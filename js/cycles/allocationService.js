// Alocações manuais, modo automático e vínculos de recebimentos, gravados no banco.
import { buildCycles, validateManualParts, MODES } from './allocation.js';
import { addDays } from '../utils/dates.js';

const CYCLE_WINDOW_DAYS = 370; // ciclos aceitos numa alocação manual: até ~1 ano antes/depois da despesa

export async function getMode(db) {
  return (await db.getMeta('allocationMode')) || 'auto';
}

export async function setMode(db, mode) {
  if (!(mode in MODES)) throw new Error('Modo de alocação inválido.');
  await db.setMeta('allocationMode', mode);
}

/**
 * Salva a alocação MANUAL de uma despesa (substitui a anterior, sem duplicar).
 * @param parts [{ cycleId, amount }] em centavos. A soma TEM que ser igual ao valor da despesa.
 */
export async function saveManualAllocation(db, transactionId, parts) {
  const tx = await db.get('transactions', transactionId);
  if (!tx) throw new Error('Transação não encontrada.');
  if (tx.amount >= 0) throw new Error('Só despesas (saídas) podem ser alocadas manualmente.');

  const sources = await db.getAll('incomes');
  const cycles = buildCycles(sources, addDays(tx.date, -CYCLE_WINDOW_DAYS), addDays(tx.date, CYCLE_WINDOW_DAYS));
  const valid = validateManualParts(Math.abs(tx.amount), parts, new Set(cycles.map((c) => c.id)));

  const existing = await db.getAllByIndex('allocations', 'transactionId', transactionId);
  await db.transact(['allocations'], ({ allocations }) => {
    for (const row of existing) allocations.delete(row.id);
    const createdAt = new Date().toISOString();
    for (const part of valid) allocations.add({ transactionId, cycleId: part.cycleId, amount: part.amount, createdAt });
  });
  return valid;
}

/** Remove a alocação manual: a despesa volta ao modo automático. */
export async function clearManualAllocation(db, transactionId) {
  const existing = await db.getAllByIndex('allocations', 'transactionId', transactionId);
  await db.transact(['allocations'], ({ allocations }) => { for (const row of existing) allocations.delete(row.id); });
  return existing.length;
}

/** Liga uma entrada real a um ciclo (cycleId = null desfaz a ligação automática). */
export async function linkReceipt(db, transactionId, cycleId) {
  const tx = await db.get('transactions', transactionId);
  if (!tx || tx.amount <= 0) throw new Error('Só entradas de dinheiro podem ser ligadas a um ciclo.');
  const existing = await db.getAllByIndex('receiptLinks', 'transactionId', transactionId);
  await db.transact(['receiptLinks'], ({ receiptLinks }) => {
    for (const row of existing) receiptLinks.delete(row.id);
    receiptLinks.add({ transactionId, cycleId, createdAt: new Date().toISOString() });
  });
}

/** Remove o vínculo manual: a entrada volta à sugestão automática. */
export async function clearReceiptLink(db, transactionId) {
  const existing = await db.getAllByIndex('receiptLinks', 'transactionId', transactionId);
  await db.transact(['receiptLinks'], ({ receiptLinks }) => { for (const row of existing) receiptLinks.delete(row.id); });
}
