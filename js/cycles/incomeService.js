// Fontes de renda no banco: cadastrar, editar, ativar/desativar e excluir.
import { validateSource } from './incomeSchedule.js';

export async function listSources(db) {
  const all = await db.getAll('incomes');
  return all.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

async function assertUniqueName(db, name, ignoreId = null) {
  const all = await db.getAll('incomes');
  const same = all.find((s) => s.id !== ignoreId && s.name.toLowerCase() === name.toLowerCase());
  if (same) throw new Error('Já existe uma fonte de renda com esse nome.');
}

export async function createSource(db, input) {
  const source = validateSource(input);
  await assertUniqueName(db, source.name);
  const record = { ...source, ativa: true, createdAt: new Date().toISOString() };
  record.id = await db.add('incomes', record);
  return record;
}

export async function updateSource(db, id, input) {
  const current = await db.get('incomes', id);
  if (!current) throw new Error('Fonte de renda não encontrada.');
  const source = validateSource(input);
  await assertUniqueName(db, source.name, id);
  // Limpa campos de frequências antigas para não deixar lixo (ex.: "weekday" em uma fonte mensal).
  const updated = { id, ativa: current.ativa, createdAt: current.createdAt, ...source };
  await db.put('incomes', updated);
  return updated;
}

export async function setSourceActive(db, id, ativa) {
  const current = await db.get('incomes', id);
  if (!current) throw new Error('Fonte de renda não encontrada.');
  await db.put('incomes', { ...current, ativa: Boolean(ativa) });
}

const belongsTo = (sourceId) => (row) => String(row.cycleId).startsWith(`${sourceId}@`);

/**
 * Alocações manuais afetadas: se uma despesa dividida tinha uma parte neste ciclo, a alocação inteira
 * dela fica incompleta (a soma não fecha mais), então ela volta toda ao cálculo automático.
 */
async function affected(db, id) {
  const [allocations, links] = await Promise.all([db.getAll('allocations'), db.getAll('receiptLinks')]);
  const txIds = new Set(allocations.filter(belongsTo(id)).map((r) => r.transactionId));
  return {
    allocationRows: allocations.filter((r) => txIds.has(r.transactionId)),
    expenses: txIds.size,
    links: links.filter(belongsTo(id)),
  };
}

/** O que acontece se esta fonte for excluída (contagens para o aviso ao usuário). */
export async function deleteImpact(db, id) {
  const a = await affected(db, id);
  return { manualAllocations: a.expenses, receiptLinks: a.links.length };
}

/**
 * Exclui a fonte E as alocações manuais e vínculos ligados aos ciclos dela, numa operação
 * "tudo ou nada". As despesas envolvidas voltam ao cálculo automático (ou às pendências).
 * Nenhuma transação é apagada ou alterada.
 */
export async function deleteSource(db, id) {
  const a = await affected(db, id);
  await db.transact(['incomes', 'allocations', 'receiptLinks'], (stores) => {
    for (const row of a.allocationRows) stores.allocations.delete(row.id);
    for (const row of a.links) stores.receiptLinks.delete(row.id);
    stores.incomes.delete(id);
  });
  return { manualAllocations: a.expenses, receiptLinks: a.links.length };
}
