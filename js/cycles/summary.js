// Resumo de cada ciclo: previsto x recebido, despesas e saldos.
//
// ATENÇÃO (não confundir com o saldo do banco):
//  - Saldo PLANEJADO do ciclo = receita PREVISTA − despesas alocadas ao ciclo.
//  - Saldo REAL do ciclo      = receita EFETIVAMENTE RECEBIDA − despesas alocadas ao ciclo.
//  Nenhum dos dois considera o dinheiro que já estava na conta antes do ciclo.
//
// Despesas "realizadas" x "comprometidas" (dentro de um ciclo):
//  - realizadas:   pagas DEPOIS do recebimento (a data da despesa é igual ou posterior ao ciclo);
//  - comprometidas: pagas ANTES do recebimento (adiantadas: dependem desse dinheiro que ainda
//                   entraria, típico do modo "Próximo recebimento").

export function summarizeCycles({ cycles, allocations, transactions, receipts, today }) {
  const txById = new Map(transactions.map((t) => [t.id, t]));
  const byCycle = new Map(cycles.map((c) => [c.id, []]));

  for (const [txId, allocation] of allocations.byTransaction) {
    const tx = txById.get(txId);
    for (const part of allocation.parts) {
      if (byCycle.has(part.cycleId)) byCycle.get(part.cycleId).push({ tx, amount: part.amount, mode: allocation.mode });
    }
  }

  return cycles.map((cycle) => {
    const expenses = byCycle.get(cycle.id).sort((a, b) => a.tx.date.localeCompare(b.tx.date));
    const linked = receipts.byCycle.get(cycle.id) || [];
    const received = linked.reduce((s, r) => s + r.tx.amount, 0);
    const committed = expenses.filter((e) => e.tx.date < cycle.date).reduce((s, e) => s + e.amount, 0);
    const realized = expenses.filter((e) => e.tx.date >= cycle.date).reduce((s, e) => s + e.amount, 0);
    const allocated = committed + realized;

    let status;
    if (received > 0) status = received >= cycle.expected ? 'recebido' : 'parcial';
    else status = cycle.date > today ? 'previsto' : 'sem_recebimento';

    return {
      cycle, expenses, receipts: linked,
      expected: cycle.expected, received, committed, realized, allocated,
      plannedBalance: cycle.expected - allocated,
      realBalance: received - allocated,
      status,
    };
  });
}

export const STATUS_LABEL = {
  recebido: 'Recebido',
  parcial: 'Recebido parcialmente',
  previsto: 'Previsto',
  sem_recebimento: 'Sem recebimento identificado',
};
