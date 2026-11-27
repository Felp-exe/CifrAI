// Cálculo dos orçamentos (funções puras).
//
// O que conta como gasto de uma categoria no mês:
//  - SÓ despesas (saídas) que têm categoria e data dentro do mês;
//  - estornos (devoluções) da mesma categoria ABATEM o gasto (comprou e devolveu = não gastou);
//  - entradas de dinheiro e transações sem categoria NÃO entram em nenhum orçamento.
//
// Alertas: até 79,9% = em dia; de 80% até 100% = próximo do limite; acima de 100% = estourado.
import { monthKey } from '../utils/format.js';

export const WARN_AT_PERCENT = 80;

/** Gasto por categoria em um mês ("AAAA-MM"). */
export function spentByCategory(transactions, month) {
  const result = new Map();
  const get = (id) => {
    if (!result.has(id)) result.set(id, { gross: 0, refunds: 0, net: 0, count: 0, pendingCount: 0, pendingAmount: 0 });
    return result.get(id);
  };
  for (const tx of transactions) {
    if (!tx.categoryId || monthKey(tx.date) !== month) continue;
    if (tx.amount < 0) {
      const entry = get(tx.categoryId);
      entry.gross += -tx.amount;
      entry.count += 1;
      if (tx.status === 'pendente') { entry.pendingCount += 1; entry.pendingAmount += -tx.amount; }
    } else if (tx.type === 'estorno') {
      get(tx.categoryId).refunds += tx.amount;
    }
  }
  for (const entry of result.values()) entry.net = Math.max(0, entry.gross - entry.refunds);
  return result;
}

/** Despesas do mês que não entram em nenhum orçamento por estarem sem categoria. */
export function uncategorizedExpenses(transactions, month) {
  const rows = transactions.filter((t) => t.amount < 0 && !t.categoryId && monthKey(t.date) === month);
  return { count: rows.length, total: rows.reduce((s, t) => s + -t.amount, 0) };
}

/** Situação de um orçamento: planejado, gasto, restante, percentual e nível de alerta. */
export function budgetStatus(limit, spent) {
  const remaining = limit - spent;
  const percent = limit > 0 ? (spent / limit) * 100 : 0;
  let level = 'ok';
  if (spent > limit) level = 'excedido';
  else if (spent * 100 >= limit * WARN_AT_PERCENT) level = 'atencao';
  return { limit, spent, remaining, percent, level };
}

export const LEVEL_LABEL = {
  ok: 'Dentro do limite',
  atencao: 'Próximo do limite',
  excedido: 'Limite ultrapassado',
};

/** Linhas do painel de orçamento para um mês. */
export function monthlyBudgetReport({ budgets, transactions, month }) {
  const spent = spentByCategory(transactions, month);
  const rows = budgets.map((b) => {
    const s = spent.get(b.categoryId) || { gross: 0, refunds: 0, net: 0, count: 0, pendingCount: 0, pendingAmount: 0 };
    return { budget: b, categoryId: b.categoryId, detail: s, ...budgetStatus(b.limit, s.net) };
  });
  const budgeted = new Set(budgets.map((b) => b.categoryId));
  const withoutBudget = [...spent]
    .filter(([id, v]) => !budgeted.has(id) && v.net > 0)
    .map(([categoryId, v]) => ({ categoryId, spent: v.net }));
  return {
    rows,
    withoutBudget,
    uncategorized: uncategorizedExpenses(transactions, month),
    totals: {
      limit: rows.reduce((s, r) => s + r.limit, 0),
      spent: rows.reduce((s, r) => s + r.spent, 0),
      alerts: rows.filter((r) => r.level !== 'ok').length,
    },
  };
}
