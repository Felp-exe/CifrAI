// Recebimentos REAIS: ligar as entradas do extrato (ex.: "SALARIO EMPRESA XYZ") aos ciclos previstos.
//
// Regras:
//  1. Vínculos feitos por você (tabela receiptLinks) valem sempre. Um vínculo "nenhum" desfaz a ligação automática.
//  2. Para o resto, o app sugere automaticamente: entrada dentro de ±5 dias da data prevista e com valor
//     até 10% diferente do esperado. Cada entrada só liga a um ciclo; cada ciclo recebe no máximo 1 automática.
//  3. Estornos não contam como recebimento (eles abatem despesas).
import { daysBetween } from '../utils/dates.js';

export const WINDOW_DAYS = 5;
export const AMOUNT_TOLERANCE = 0.1;

export const isIncoming = (tx) => tx.amount > 0 && tx.type !== 'estorno';

/**
 * @returns {{ byCycle: Map<string, Array<{tx, origin}>>, linkOf: Map<number, {cycleId|null, origin}>, unlinked: Array }}
 */
export function matchReceipts({ cycles, transactions, links = [] }) {
  const cycleIds = new Set(cycles.map((c) => c.id));
  const incoming = transactions.filter(isIncoming);
  const byCycle = new Map(cycles.map((c) => [c.id, []]));
  const linkOf = new Map();

  // 1) vínculos manuais
  const manualCycles = new Set();
  for (const link of links) {
    const tx = incoming.find((t) => t.id === link.transactionId);
    if (!tx) continue;
    if (link.cycleId === null) {
      linkOf.set(tx.id, { cycleId: null, origin: 'manual' });
    } else if (cycleIds.has(link.cycleId)) {
      linkOf.set(tx.id, { cycleId: link.cycleId, origin: 'manual' });
      byCycle.get(link.cycleId).push({ tx, origin: 'manual' });
      manualCycles.add(link.cycleId);
    } // vínculo para ciclo que não existe mais: ignorado (a entrada volta ao automático)
  }

  // 2) sugestões automáticas (melhor par primeiro: data mais próxima, depois valor mais próximo)
  const pairs = [];
  for (const cycle of cycles) {
    if (manualCycles.has(cycle.id)) continue;
    for (const tx of incoming) {
      if (linkOf.has(tx.id)) continue;
      const dateGap = Math.abs(daysBetween(cycle.date, tx.date));
      const amountGap = Math.abs(tx.amount - cycle.expected);
      if (dateGap <= WINDOW_DAYS && amountGap <= cycle.expected * AMOUNT_TOLERANCE) {
        pairs.push({ cycle, tx, dateGap, amountGap });
      }
    }
  }
  pairs.sort((a, b) => a.dateGap - b.dateGap || a.amountGap - b.amountGap || a.cycle.date.localeCompare(b.cycle.date));
  const usedCycles = new Set();
  for (const { cycle, tx } of pairs) {
    if (linkOf.has(tx.id) || usedCycles.has(cycle.id)) continue;
    linkOf.set(tx.id, { cycleId: cycle.id, origin: 'auto' });
    byCycle.get(cycle.id).push({ tx, origin: 'auto' });
    usedCycles.add(cycle.id);
  }

  const unlinked = incoming.filter((t) => !linkOf.get(t.id)?.cycleId);
  return { byCycle, linkOf, unlinked };
}
