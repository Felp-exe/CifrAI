// Junta tudo: fontes de renda -> ciclos -> alocações -> recebimentos reais -> resumos.
import { buildCycles, computeAllocations } from './allocation.js';
import { matchReceipts } from './receipts.js';
import { summarizeCycles } from './summary.js';
import { addDays, todayISO, monthRange, shiftMonth } from '../utils/dates.js';

const MARGIN_DAYS = 100; // ciclos de meses vizinhos também podem financiar uma despesa

/**
 * Intervalo de datas que precisa ter ciclos gerados.
 * `focus` pode ser um mês ("2026-03") ou um período { start, end }, para incluir ciclos fora das transações.
 */
export function horizon(transactions, focus = null) {
  const dates = transactions.map((t) => t.date);
  const today = todayISO();
  let min = dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : today;
  let max = dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : today;
  if (focus) {
    const { start, end } = typeof focus === 'string' ? monthRange(focus) : focus;
    if (start < min) min = start;
    if (end > max) max = end;
  }
  return { from: addDays(min, -MARGIN_DAYS), to: addDays(max, MARGIN_DAYS) };
}

/** Mês mais recente com transações (ou o mês atual, se não houver nenhuma). */
export function defaultMonth(transactions) {
  const latest = transactions.map((t) => t.date).sort().pop();
  return latest ? latest.slice(0, 7) : todayISO().slice(0, 7);
}

export { shiftMonth };

/**
 * Calcula o modelo completo (função pura: fácil de testar).
 * @param input { transactions, sources, manual, links, mode, today, focusMonth }
 */
export function buildModel({ transactions, sources, manual = [], links = [], mode = 'auto', today = todayISO(), focusMonth = null }) {
  const { from, to } = horizon(transactions, focusMonth);
  const cycles = buildCycles(sources, from, to);
  const allocations = computeAllocations({ transactions, manual, cycles, mode });
  const receipts = matchReceipts({ cycles, transactions, links });
  const summaries = summarizeCycles({ cycles, allocations, transactions, receipts, today });
  return { transactions, sources, cycles, allocations, receipts, summaries, pending: allocations.pending, mode, today };
}

/** Carrega do banco e calcula. */
export async function loadModel(db, { focusMonth = null, focusRange = null, today = todayISO() } = {}) {
  const [transactions, sources, manual, links, modeSaved] = await Promise.all([
    db.getAll('transactions'), db.getAll('incomes'), db.getAll('allocations'), db.getAll('receiptLinks'),
    db.getMeta('allocationMode'),
  ]);
  return {
    transactions, sources, manual, links,
    ...buildModel({ transactions, sources, manual, links, mode: modeSaved || 'auto', today, focusMonth: focusRange || focusMonth }),
  };
}
