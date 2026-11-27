// Operações de categorização sobre as transações salvas.
// Regra de ouro: só os CAMPOS DE CLASSIFICAÇÃO mudam. Data, valor, descrição original e
// nome normalizado nunca são alterados aqui.
import { normalizeText } from '../utils/format.js';
import { categorize, applyCategorization } from './categorizer.js';
import { extractMerchant } from './merchant.js';
import { rememberMerchant } from './ruleService.js';

async function loadContext(db) {
  const [rules, categories] = await Promise.all([db.getAll('rules'), db.getAll('categories')]);
  return { rules, categoryIds: new Set(categories.map((c) => c.id)) };
}

function saveAll(db, items) {
  if (!items.length) return Promise.resolve();
  return db.transact(['transactions'], ({ transactions }) => { for (const t of items) transactions.put(t); });
}

/**
 * Recalcula a categoria automática. Correções manuais NUNCA são alteradas.
 * @param options.onlyUncategorized só transações que ainda não passaram pela categorização
 * @param options.ids limitar a estas transações
 * @returns quantidade de transações que mudaram
 */
export async function recategorize(db, { onlyUncategorized = false, ids = null } = {}) {
  const { rules, categoryIds } = await loadContext(db);
  const all = await db.getAll('transactions');
  const changed = [];
  let reclassified = 0;
  const outcome = (t) => `${t.categoryId}|${t.status}|${t.suggestedCategoryId}`;
  for (const tx of all) {
    if (ids && !ids.includes(tx.id)) continue;
    if (tx.manual) continue;
    if (onlyUncategorized && tx.categorySource) continue;
    const result = categorize(tx, rules, categoryIds);
    // Compara sem o carimbo de hora, para só gravar o que realmente mudou.
    const probe = applyCategorization(tx, result, tx.categorizedAt);
    if (JSON.stringify(probe) !== JSON.stringify(tx)) {
      changed.push(applyCategorization(tx, result));
      // "Reclassificada" = mudou de categoria, de situação ou de sugestão (só o texto do motivo não conta).
      if (outcome(probe) !== outcome(tx)) reclassified += 1;
    }
  }
  await saveAll(db, changed);
  return reclassified;
}

/** Categoriza transações salvas por versões antigas do app (Etapa 2), uma única vez. */
export function migrateLegacy(db) {
  return recategorize(db, { onlyUncategorized: true });
}

/**
 * Define a categoria escolhida por você. Fica protegida: importações e regras futuras não sobrescrevem.
 * @param remember cria/atualiza uma regra de nome exato para cada estabelecimento (memorização)
 */
export async function setCategory(db, ids, categoryId, { remember = false } = {}) {
  if (!(await db.get('categories', categoryId))) throw new Error('A categoria escolhida não existe.');
  const all = await db.getAll('transactions');
  const chosen = all.filter((t) => ids.includes(t.id));
  const updated = chosen.map((tx) => ({
    ...tx,
    merchantName: tx.merchantName || extractMerchant(tx.originalDescription || tx.normalizedName || ''),
    categoryId, status: 'classificada', categorySource: 'manual', confidence: 'alta',
    reason: 'Definida por você.', manual: true, categorizedAt: new Date().toISOString(),
  }));
  await saveAll(db, updated);

  const rulesTouched = [];
  if (remember) {
    for (const merchant of new Set(updated.map((t) => t.merchantName).filter(Boolean))) {
      const rule = await rememberMerchant(db, merchant, categoryId);
      if (rule) rulesTouched.push(rule);
    }
    if (rulesTouched.length) await recategorize(db); // aplica às outras parecidas (não-manuais)
  }
  return { changed: updated.length, rules: rulesTouched.length };
}

/** Aceita a sugestão automática (ou a categoria atual) das transações pendentes. */
export async function confirmSuggestions(db, ids, { remember = false } = {}) {
  const all = await db.getAll('transactions');
  const byCategory = new Map();
  let skipped = 0;
  for (const tx of all.filter((t) => ids.includes(t.id))) {
    const target = tx.suggestedCategoryId || tx.categoryId;
    if (!target) { skipped++; continue; }
    if (!byCategory.has(target)) byCategory.set(target, []);
    byCategory.get(target).push(tx.id);
  }
  let changed = 0;
  let rules = 0;
  for (const [categoryId, group] of byCategory) {
    const result = await setCategory(db, group, categoryId, { remember });
    changed += result.changed;
    rules += result.rules;
  }
  return { changed, skipped, rules };
}

/**
 * Fotografia (cópia) das transações e das regras, tirada ANTES de uma classificação, para o botão "Desfazer".
 * Guarda tudo porque uma classificação pode reclassificar outras transações e criar/alterar uma regra memorizada.
 */
export async function takeUndoSnapshot(db) {
  const [transactions, rules] = await Promise.all([db.getAll('transactions'), db.getAll('rules')]);
  return { transactions: structuredClone(transactions), rules: structuredClone(rules) };
}

/**
 * Volta as transações e as regras ao que eram na fotografia (só grava o que realmente mudou, numa única operação).
 * Regras criadas depois da fotografia são removidas; regras alteradas voltam ao que eram.
 * @returns {{ transactions:number, rules:number }} quantas transações e regras foram restauradas
 */
export async function restoreUndoSnapshot(db, snapshot) {
  const [txNow, rulesNow] = await Promise.all([db.getAll('transactions'), db.getAll('rules')]);
  const txById = new Map(txNow.map((t) => [t.id, t]));
  const ruleById = new Map(rulesNow.map((r) => [r.id, r]));
  const keepRuleIds = new Set(snapshot.rules.map((r) => r.id));
  const txToPut = snapshot.transactions.filter((t) => JSON.stringify(txById.get(t.id)) !== JSON.stringify(t));
  const rulesToDelete = rulesNow.filter((r) => !keepRuleIds.has(r.id));
  const rulesToPut = snapshot.rules.filter((r) => JSON.stringify(ruleById.get(r.id)) !== JSON.stringify(r));
  await db.transact(['transactions', 'rules'], ({ transactions, rules }) => {
    for (const t of txToPut) transactions.put(t);
    for (const r of rulesToDelete) rules.delete(r.id);
    for (const r of rulesToPut) rules.put(r);
  });
  return { transactions: txToPut.length, rules: rulesToDelete.length + rulesToPut.length };
}

/** Devolve transações para a Revisão: tira a proteção manual e volta a marcá-las como pendentes (mantém a categoria atual). */
export async function sendBackToReview(db, ids) {
  const all = await db.getAll('transactions');
  const now = new Date().toISOString();
  const updated = all.filter((t) => ids.includes(t.id)).map((tx) => ({
    ...tx, manual: false, status: 'pendente', categorySource: 'desconhecido', confidence: 'baixa',
    reason: 'Devolvida para revisão por você.', suggestedCategoryId: tx.categoryId || tx.suggestedCategoryId || null, categorizedAt: now,
  }));
  await saveAll(db, updated);
  return updated.length;
}

/** Remove a proteção manual e volta a usar as regras automáticas. */
export async function resetToAutomatic(db, ids) {
  const all = await db.getAll('transactions');
  const released = all.filter((t) => ids.includes(t.id)).map((t) => ({ ...t, manual: false, categorySource: null }));
  await saveAll(db, released);
  return recategorize(db, { ids });
}

/** Filtro da lista (função pura). */
export function filterTransactions(txs, { search = '', category = 'todas', status = 'todas' } = {}) {
  const term = normalizeText(search);
  return txs.filter((t) => {
    if (term) {
      const hay = normalizeText(`${t.originalDescription} ${t.normalizedName} ${t.merchantName || ''}`);
      if (!hay.includes(term)) return false;
    }
    if (category === '__sem') { if (t.categoryId) return false; }
    else if (category !== 'todas' && t.categoryId !== category) return false;
    if (status === 'pendente' && t.status !== 'pendente') return false;
    if (status === 'classificada' && t.status !== 'classificada') return false;
    if (status === 'manual' && !t.manual) return false;
    return true;
  });
}
