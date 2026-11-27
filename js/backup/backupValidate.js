// Validação do arquivo de backup ANTES de restaurar qualquer coisa.
// Confere: se é JSON, se é um backup deste app, a versão do formato, os tipos de cada campo e a
// integridade entre as tabelas (categoria existe, alocação soma o valor da despesa etc.).
// Nada aqui toca no banco.
import {
  BACKUP_FORMAT, LEGACY_BACKUP_FORMATS, BACKUP_VERSION, STORES, FIELDS, META_KEYS, pick,
} from './backupFormat.js';
import { isValidISO } from '../utils/dates.js';
import { validateSource } from '../cycles/incomeSchedule.js';
import { MATCH_TYPES } from '../categorization/categorizer.js';

export const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_ERRORS = 25;
const REQUIRED = ['categories', 'transactions'];
const CYCLE_ID = /^(\d+)@(\d{4}-\d{2}-\d{2})$/;

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isInt = Number.isInteger;
const isText = (x) => typeof x === 'string';

/**
 * @returns {{ ok:boolean, incompatible:boolean, errors:string[], warnings:string[], summary?:object }}
 */
export function validateBackup(raw) {
  const errors = [];
  const warnings = [];
  let incompatible = false;
  const err = (msg) => { if (errors.length < MAX_ERRORS) errors.push(msg); else if (errors.length === MAX_ERRORS) errors.push('... e mais problemas (corrija estes primeiro).'); };

  if (!isObject(raw)) return { ok: false, incompatible: false, errors: ['O arquivo não contém um backup válido (esperava um objeto JSON).'], warnings };
  if (raw.format !== BACKUP_FORMAT && !LEGACY_BACKUP_FORMATS.includes(raw.format)) {
    const found = raw.format === undefined ? 'o arquivo não tem a identificação do formato' : `formato "${String(raw.format).slice(0, 40)}"`;
    return { ok: false, incompatible: false, errors: [`Este arquivo não é um backup do CifrAI (${found}).`], warnings };
  }
  if (!isInt(raw.formatVersion) || raw.formatVersion < 1) {
    return { ok: false, incompatible: true, errors: ['A versão do formato do backup está ausente ou inválida.'], warnings };
  }
  if (raw.formatVersion > BACKUP_VERSION) {
    return {
      ok: false, incompatible: true, warnings,
      errors: [`Este backup foi criado por uma versão mais nova do app (formato ${raw.formatVersion}; esta versão entende até o ${BACKUP_VERSION}). Atualize o app para restaurá-lo.`],
    };
  }
  if (!isText(raw.exportedAt) || Number.isNaN(Date.parse(raw.exportedAt))) err('A data da exportação ("exportedAt") está ausente ou inválida.');
  if (!isObject(raw.data)) return { ok: false, incompatible: false, errors: ['O backup não tem a seção "data" com as tabelas.'], warnings };

  const data = {};
  for (const store of STORES) {
    const value = raw.data[store];
    if (value === undefined) {
      if (REQUIRED.includes(store)) err(`Tabela obrigatória ausente: ${store}.`);
      data[store] = [];
    } else if (!Array.isArray(value)) {
      err(`A tabela ${store} deve ser uma lista.`);
      data[store] = [];
    } else {
      data[store] = value;
    }
  }
  for (const key of Object.keys(raw.data)) if (!STORES.includes(key)) warnings.push(`Tabela desconhecida ignorada: ${String(key).slice(0, 40)}.`);

  const ids = {};
  const checkItems = (store, fn, { unique = true } = {}) => {
    ids[store] = new Set();
    data[store].forEach((item, i) => {
      const where = `${store}[${i}]`;
      if (!isObject(item)) { err(`${where}: item inválido.`); return; }
      if (unique && item.id !== undefined) {
        if (ids[store].has(item.id)) err(`${where}: id repetido (${item.id}).`);
        ids[store].add(item.id);
      }
      fn(item, where);
    });
  };

  checkItems('categories', (c, w) => {
    if (!isText(c.id) || !c.id || c.id.length > 60) err(`${w}: id inválido.`);
    if (!isText(c.nome) || !c.nome.trim() || c.nome.length > 60) err(`${w}: nome inválido.`);
    if (!/^#[0-9a-f]{6}$/i.test(c.cor || '')) err(`${w}: cor inválida.`);
  });
  const categoryIds = ids.categories;
  const knownCategory = (id) => id === null || id === undefined || categoryIds.has(id);

  checkItems('rules', (r, w) => {
    if (!isInt(r.id) || r.id < 1) err(`${w}: id inválido.`);
    if (!isText(r.pattern) || !r.pattern.trim()) err(`${w}: texto da regra inválido.`);
    if (!(r.matchType in MATCH_TYPES)) err(`${w}: tipo de comparação inválido.`);
    if (!['inicial', 'usuario'].includes(r.origem)) err(`${w}: origem inválida.`);
    if (r.categoryId !== null && !isText(r.categoryId)) err(`${w}: categoria inválida.`);
    else if (!knownCategory(r.categoryId)) err(`${w}: aponta para uma categoria que não existe no backup (${r.categoryId}).`);
  });

  checkItems('budgets', (b, w) => {
    if (!isInt(b.id) || b.id < 1) err(`${w}: id inválido.`);
    if (!isText(b.categoryId) || !knownCategory(b.categoryId)) err(`${w}: categoria inválida ou inexistente.`);
    if (!isInt(b.limit) || b.limit <= 0) err(`${w}: limite deve ser um número inteiro de centavos maior que zero.`);
  });
  const budgetCats = data.budgets.map((b) => b.categoryId);
  if (new Set(budgetCats).size !== budgetCats.length) err('Há mais de um orçamento para a mesma categoria.');

  checkItems('incomes', (s, w) => {
    if (!isInt(s.id) || s.id < 1) err(`${w}: id inválido.`);
    try { validateSource(s); } catch (e) { err(`${w}: ${e.message}`); }
  });

  checkItems('imports', (m, w) => {
    if (!isText(m.id) || !m.id) err(`${w}: id inválido.`);
    if (m.fileName !== undefined && !isText(m.fileName)) err(`${w}: nome do arquivo inválido.`);
    for (const k of ['periodStart', 'periodEnd']) {
      if (m[k] !== undefined && m[k] !== null && !isValidISO(m[k])) err(`${w}: período do extrato inválido.`);
    }
  });

  const txById = new Map();
  checkItems('transactions', (t, w) => {
    if (!isInt(t.id) || t.id < 1) err(`${w}: id inválido.`);
    if (!isValidISO(t.date)) err(`${w}: data inválida (${String(t.date).slice(0, 12)}).`);
    if (!isInt(t.amount) || t.amount === 0) err(`${w}: valor deve ser um número inteiro de centavos diferente de zero.`);
    if (!isText(t.originalDescription)) err(`${w}: descrição original ausente.`);
    if (!isText(t.normalizedName)) err(`${w}: nome normalizado ausente.`);
    if (t.status !== undefined && !['pendente', 'classificada'].includes(t.status)) err(`${w}: situação inválida.`);
    if (t.manual !== undefined && typeof t.manual !== 'boolean') err(`${w}: "manual" deve ser verdadeiro/falso.`);
    if (t.categoryId !== undefined && t.categoryId !== null && !isText(t.categoryId)) err(`${w}: categoria inválida.`);
    else if (!knownCategory(t.categoryId)) err(`${w}: aponta para uma categoria que não existe no backup (${t.categoryId}).`);
    if (!knownCategory(t.suggestedCategoryId)) err(`${w}: sugestão aponta para uma categoria inexistente.`);
    if (t.fingerprint !== undefined && !isText(t.fingerprint)) err(`${w}: impressão digital inválida.`);
    txById.set(t.id, t);
  });

  const sourceExists = (cycleId) => {
    const m = CYCLE_ID.exec(cycleId);
    return Boolean(m) && ids.incomes.has(Number(m[1]));
  };

  const allocSum = new Map();
  checkItems('allocations', (a, w) => {
    if (!isInt(a.id) || a.id < 1) err(`${w}: id inválido.`);
    const tx = txById.get(a.transactionId);
    if (!tx) err(`${w}: aponta para uma transação que não existe no backup.`);
    else if (tx.amount >= 0) err(`${w}: só despesas podem ter alocação manual.`);
    if (!isInt(a.amount) || a.amount <= 0) err(`${w}: valor deve ser um inteiro positivo de centavos.`);
    if (!isText(a.cycleId) || !sourceExists(a.cycleId)) err(`${w}: o ciclo "${String(a.cycleId).slice(0, 30)}" aponta para uma fonte de renda que não existe no backup.`);
    allocSum.set(a.transactionId, (allocSum.get(a.transactionId) || 0) + (isInt(a.amount) ? a.amount : 0));
  });
  for (const [txId, sum] of allocSum) {
    const tx = txById.get(txId);
    if (tx && tx.amount < 0 && sum !== Math.abs(tx.amount)) err(`Alocação da transação ${txId}: a soma das partes (${sum}) não é igual ao valor da despesa (${Math.abs(tx.amount)}).`);
  }

  checkItems('receiptLinks', (l, w) => {
    if (!isInt(l.id) || l.id < 1) err(`${w}: id inválido.`);
    const tx = txById.get(l.transactionId);
    if (!tx) err(`${w}: aponta para uma transação que não existe no backup.`);
    else if (tx.amount <= 0) err(`${w}: só entradas podem ser ligadas a um ciclo.`);
    if (l.cycleId !== null && (!isText(l.cycleId) || !sourceExists(l.cycleId))) err(`${w}: ciclo inválido ou de fonte de renda inexistente.`);
  });

  if (raw.meta !== undefined) {
    if (!isObject(raw.meta)) err('"meta" deve ser um objeto.');
    else {
      if (raw.meta.allocationMode !== undefined && !['auto', 'proximo'].includes(raw.meta.allocationMode)) err('meta.allocationMode inválido.');
      if (raw.meta.seeded !== undefined && typeof raw.meta.seeded !== 'boolean') err('meta.seeded inválido.');
    }
  }

  if (errors.length) return { ok: false, incompatible, errors, warnings };

  const dates = data.transactions.map((t) => t.date).sort();
  const counts = Object.fromEntries(STORES.map((s) => [s, data[s].length]));
  if (!counts.transactions) warnings.push('O backup não tem nenhuma transação.');
  return {
    ok: true, incompatible: false, errors: [], warnings,
    summary: {
      exportedAt: raw.exportedAt, formatVersion: raw.formatVersion, counts,
      firstDate: dates[0] || null, lastDate: dates[dates.length - 1] || null,
    },
  };
}

/** Cópia do backup só com os campos permitidos (descarta qualquer coisa a mais que viesse no arquivo). */
export function sanitizeBackup(raw) {
  const data = {};
  for (const store of STORES) data[store] = (raw.data[store] || []).map((r) => pick(r, FIELDS[store]));
  const meta = raw.meta ? pick(raw.meta, META_KEYS) : {};
  return { format: raw.format, formatVersion: raw.formatVersion, exportedAt: raw.exportedAt, data, meta };
}

/**
 * Lê o TEXTO do arquivo: JSON → validação → cópia limpa.
 * @returns {{ ok, errors, warnings, incompatible, summary?, backup? }}
 */
export function parseBackupText(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, incompatible: false, errors: ['O arquivo está vazio.'], warnings: [] };
  let raw;
  try { raw = JSON.parse(text); } catch {
    return { ok: false, incompatible: false, errors: ['O arquivo não é um JSON válido (pode estar corrompido, cortado ou não ser um backup).'], warnings: [] };
  }
  const result = validateBackup(raw);
  return result.ok ? { ...result, backup: sanitizeBackup(raw) } : result;
}
