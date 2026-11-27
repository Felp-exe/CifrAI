// Ciclos e ALOCAÇÃO de despesas. Funções puras (não mexem no banco).
//
// Ideia central: cada recebimento (ex.: salário do dia 15) é um CICLO. Cada despesa é ligada a
// ciclos por uma alocação. Existem 3 modos:
//   1. Automático por data: o recebimento mais recente que já aconteceu até a data da despesa.
//   2. Próximo recebimento: o primeiro recebimento depois da data da despesa.
//   3. Manual: você escolhe o ciclo ou divide a despesa entre vários (grava no banco).
// Os modos 1 e 2 são CALCULADOS na hora (nada é gravado), então nunca ficam desatualizados nem duplicados.
import { occurrences } from './incomeSchedule.js';

export const MODES = {
  auto: 'Automático por data',
  proximo: 'Próximo recebimento',
};

export const cycleId = (sourceId, date) => `${sourceId}@${date}`;

/** Gera todos os ciclos (um por recebimento) entre duas datas. */
export function buildCycles(sources, from, to) {
  const cycles = [];
  for (const source of sources) {
    if (source.ativa === false) continue;
    for (const date of occurrences(source, from, to)) {
      cycles.push({ id: cycleId(source.id, date), sourceId: source.id, name: source.name, date, expected: source.amount });
    }
  }
  return cycles.sort((a, b) => a.date.localeCompare(b.date) || b.expected - a.expected || a.sourceId - b.sourceId);
}

/** Despesa (saída) ou estorno (entrada que devolve gasto, tratado como crédito). */
export function isExpenseLike(tx) {
  return tx.amount < 0 || (tx.type === 'estorno' && tx.amount > 0);
}

/** Valor positivo para despesas; NEGATIVO para estornos (eles abatem o gasto do ciclo). */
export function expenseValue(tx) {
  return -tx.amount;
}

/** Escolhe o ciclo automaticamente. `cycles` precisa estar ordenado por data. */
export function autoCycleFor(date, cycles, mode) {
  if (mode === 'proximo') {
    const firstDate = cycles.find((c) => c.date > date)?.date;
    return firstDate ? cycles.find((c) => c.date === firstDate) : null; // empate: o de maior valor (já ordenado)
  }
  let lastDate = null;
  for (const c of cycles) if (c.date <= date) lastDate = c.date;
  return lastDate ? cycles.find((c) => c.date === lastDate) : null;
}

/**
 * Valida uma alocação manual. Cada parte: { cycleId, amount } (centavos).
 * - partes do mesmo ciclo são somadas; - a soma TEM que ser exatamente o valor da despesa;
 * - todos os ciclos precisam existir.
 */
export function validateManualParts(total, parts, cycleIds) {
  const merged = new Map();
  for (const part of parts) {
    if (!Number.isInteger(part.amount) || part.amount <= 0) throw new Error('Cada parte da alocação precisa ter um valor maior que zero.');
    if (!cycleIds.has(part.cycleId)) throw new Error('Um dos ciclos escolhidos não existe.');
    merged.set(part.cycleId, (merged.get(part.cycleId) || 0) + part.amount);
  }
  if (merged.size === 0) throw new Error('Escolha pelo menos um ciclo.');
  const sum = [...merged.values()].reduce((s, v) => s + v, 0);
  if (sum !== total) {
    const diff = total - sum;
    throw new Error(diff > 0
      ? `A soma das partes não fecha: faltam ${(diff / 100).toFixed(2).replace('.', ',')} para o valor da despesa.`
      : `A soma das partes passa do valor da despesa em ${(-diff / 100).toFixed(2).replace('.', ',')}.`);
  }
  return [...merged].map(([id, amount]) => ({ cycleId: id, amount }));
}

/**
 * Calcula a alocação de TODAS as despesas.
 * @returns {{ byTransaction: Map, pending: Array }}
 *   byTransaction: txId -> { mode, parts: [{cycleId, amount}] }   (nunca conta uma despesa duas vezes)
 *   pending: [{ tx, reason }]  despesas que ficaram sem alocação válida
 */
export function computeAllocations({ transactions, manual = [], cycles, mode = 'auto' }) {
  const cycleIds = new Set(cycles.map((c) => c.id));
  const manualByTx = new Map();
  for (const row of manual) {
    if (!manualByTx.has(row.transactionId)) manualByTx.set(row.transactionId, []);
    manualByTx.get(row.transactionId).push(row);
  }

  const byTransaction = new Map();
  const pending = [];

  for (const tx of transactions) {
    if (!isExpenseLike(tx)) continue;
    const rows = manualByTx.get(tx.id);

    if (rows?.length && tx.amount < 0) {
      const total = Math.abs(tx.amount);
      const sum = rows.reduce((s, r) => s + r.amount, 0);
      if (rows.every((r) => cycleIds.has(r.cycleId)) && sum === total) {
        byTransaction.set(tx.id, { mode: 'manual', parts: rows.map((r) => ({ cycleId: r.cycleId, amount: r.amount })) });
      } else {
        // Alocação manual quebrada (ex.: a renda foi editada ou excluída). Não adivinhamos:
        // a despesa vai para as pendências e NÃO entra em nenhum ciclo até você alocar de novo.
        const missing = rows.some((r) => !cycleIds.has(r.cycleId));
        pending.push({
          tx,
          reason: missing
            ? 'A alocação manual aponta para um ciclo que não existe mais (renda editada ou excluída).'
            : 'A alocação manual não soma o valor da despesa.',
        });
      }
      continue;
    }

    const cycle = autoCycleFor(tx.date, cycles, mode);
    if (cycle) {
      byTransaction.set(tx.id, { mode, parts: [{ cycleId: cycle.id, amount: expenseValue(tx) }] });
    } else {
      pending.push({
        tx,
        reason: mode === 'proximo'
          ? 'Não há um recebimento previsto depois da data desta despesa.'
          : 'Não há um recebimento anterior à data desta despesa. Cadastre uma fonte de renda ou aloque manualmente.',
      });
    }
  }
  return { byTransaction, pending };
}
