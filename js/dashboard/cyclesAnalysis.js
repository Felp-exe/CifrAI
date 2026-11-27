// Análise dos ciclos para o painel. Usa o modelo de ciclos da Etapa 4 (nada é recalculado à parte).
//
// Vocabulário (para não confundir):
//  - PREVISTO:    quanto a fonte de renda diz que vai pagar.
//  - RECEBIDO:    o que realmente entrou (entradas do extrato ligadas ao ciclo).
//  - COMPROMETIDO: despesas pagas ANTES do recebimento, contando com ele.
//  - GASTO (realizado): despesas pagas DEPOIS do recebimento.
//  - DISPONÍVEL PLANEJADO = previsto − despesas alocadas;  DISPONÍVEL REAL = recebido − despesas alocadas.
//  Nada disso é o saldo bancário.

/** @returns análise dos ciclos cujo recebimento cai dentro do período. */
export function analyzeCycles(model, period) {
  const inRange = model.summaries.filter((s) => s.cycle.date >= period.start && s.cycle.date <= period.end);
  const totalExpected = inRange.reduce((s, c) => s + c.expected, 0);

  const cycles = inRange.map((s) => ({
    id: s.cycle.id, name: s.cycle.name, date: s.cycle.date, status: s.status,
    expected: s.expected, received: s.received,
    committed: s.committed, realized: s.realized, allocated: s.allocated,
    availablePlanned: s.plannedBalance, availableReal: s.realBalance,
    share: totalExpected ? (s.expected / totalExpected) * 100 : 0,
    overAllocated: s.allocated > s.expected,
  }));

  const pendingItems = model.pending.filter((p) => p.tx.date >= period.start && p.tx.date <= period.end);
  const byStatus = (status) => cycles.filter((c) => c.status === status).length;

  return {
    cycles,
    totals: {
      expected: totalExpected,
      received: cycles.reduce((s, c) => s + c.received, 0),
      committed: cycles.reduce((s, c) => s + c.committed, 0),
      realized: cycles.reduce((s, c) => s + c.realized, 0),
      allocated: cycles.reduce((s, c) => s + c.allocated, 0),
    },
    counts: {
      recebido: byStatus('recebido'), parcial: byStatus('parcial'),
      previsto: byStatus('previsto'), sem_recebimento: byStatus('sem_recebimento'),
    },
    unallocated: {
      count: pendingItems.length,
      amount: pendingItems.reduce((s, p) => s + Math.abs(p.tx.amount), 0),
      items: pendingItems,
      totalCountEver: model.pending.length,
    },
  };
}

/** Segmentos (em % da barra) para desenhar um ciclo: comprometido, gasto e disponível. */
export function barSegments(cycle) {
  const total = Math.max(cycle.expected, cycle.allocated) || 1;
  const pct = (v) => (Math.max(0, v) / total) * 100;
  return {
    committed: pct(cycle.committed),
    realized: pct(cycle.realized),
    available: pct(Math.max(0, cycle.expected - cycle.allocated)),
    over: pct(cycle.allocated - cycle.expected),
  };
}
