// Limpeza de dados: excluir UMA importação (e só o que veio dela) ou apagar TUDO.
// Ambas as operações usam uma única transação do IndexedDB ("tudo ou nada").
import { seedDefaults } from '../seed.js';
import { STORES } from '../backup/backupFormat.js';
import { setSetting } from '../storage.js';

/** Importações salvas, da mais recente para a mais antiga, com a quantidade de transações de cada uma. */
export async function listImports(db) {
  const [imports, transactions] = await Promise.all([db.getAll('imports'), db.getAll('transactions')]);
  const byImport = new Map();
  for (const t of transactions) {
    const info = byImport.get(t.importId) || { count: 0, first: null, last: null };
    info.count += 1;
    if (!info.first || t.date < info.first) info.first = t.date;
    if (!info.last || t.date > info.last) info.last = t.date;
    byImport.set(t.importId, info);
  }
  return imports
    .map((imp) => {
      const info = byImport.get(imp.id) || { count: 0, first: null, last: null };
      return {
        ...imp,
        transactionCount: info.count,
        firstDate: imp.periodStart || info.first,
        lastDate: imp.periodEnd || info.last,
      };
    })
    .sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt)));
}

/** O que seria removido ao excluir a importação (não grava nada). */
export async function previewDeleteImport(db, importId) {
  const { transactions, allocations, receiptLinks } = await collect(db, importId);
  return {
    transactions: transactions.length,
    manual: transactions.filter((t) => t.manual).length,
    allocations: allocations.length,
    receiptLinks: receiptLinks.length,
  };
}

async function collect(db, importId) {
  const [transactions, allocations, receiptLinks] = await Promise.all([
    db.getAllByIndex('transactions', 'importId', importId),
    db.getAll('allocations'),
    db.getAll('receiptLinks'),
  ]);
  const ids = new Set(transactions.map((t) => t.id));
  return {
    transactions,
    allocations: allocations.filter((a) => ids.has(a.transactionId)),
    receiptLinks: receiptLinks.filter((l) => ids.has(l.transactionId)),
  };
}

/**
 * Exclui a importação: suas transações, as alocações/vínculos dessas transações e o registro da importação.
 * Regras, categorias, orçamentos e rendas não são tocados.
 */
export async function deleteImport(db, importId) {
  if (!(await db.get('imports', importId))) throw new Error('Essa importação não existe mais.');
  const found = await collect(db, importId);
  await db.transact(['transactions', 'allocations', 'receiptLinks', 'imports'], (s) => {
    for (const t of found.transactions) s.transactions.delete(t.id);
    for (const a of found.allocations) s.allocations.delete(a.id);
    for (const l of found.receiptLinks) s.receiptLinks.delete(l.id);
    s.imports.delete(importId);
  });
  return {
    transactions: found.transactions.length,
    allocations: found.allocations.length,
    receiptLinks: found.receiptLinks.length,
  };
}

/**
 * Apaga todos os dados (inclusive categorias, regras, orçamentos e rendas criados por você) e volta ao estado
 * de app novo: as categorias e regras iniciais são recarregadas.
 */
export async function wipeAllData(db, { baseUrl = 'data/', resetPrefs = true } = {}) {
  const removed = {};
  for (const store of STORES) removed[store] = await db.count(store);
  await db.transact([...STORES, 'meta'], (s) => {
    for (const store of [...STORES, 'meta']) s[store].clear();
  });
  await seedDefaults(db, baseUrl);
  if (resetPrefs) {
    setSetting('dashboardPeriod', null);
    setSetting('dashboardCustom', { start: '', end: '' });
    setSetting('rulesUpdateNotice', null);
  }
  return removed;
}
