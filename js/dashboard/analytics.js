// Cálculos do painel (funções PURAS: recebem os dados e devolvem números; nunca alteram nada).
// Tudo em CENTAVOS inteiros.
//
// Regras de contagem (cada transação é contada UMA vez, em UM destes grupos):
//  - Receita:  entrada de dinheiro que NÃO é estorno.
//  - Despesa:  saída de dinheiro.
//  - Estorno:  entrada que devolve um gasto. NÃO é receita: ele abate as despesas.
//  Despesas (líquidas) = despesas brutas − estornos.  Saldo = receitas − despesas líquidas.
//  Esse saldo é o resultado das movimentações importadas; NÃO é o saldo da conta bancária.
import { monthKey } from '../utils/format.js';
import { daysBetween, shiftMonth, monthRange } from '../utils/dates.js';

export const isRefund = (tx) => tx.amount > 0 && tx.type === 'estorno';
export const isIncome = (tx) => tx.amount > 0 && tx.type !== 'estorno';
export const isExpense = (tx) => tx.amount < 0;

/** Transações com data dentro do período (inclusive nas duas pontas). */
export function inPeriod(transactions, period) {
  return transactions.filter((t) => t.date >= period.start && t.date <= period.end);
}

export function summarize(transactions) {
  let income = 0; let expensesGross = 0; let refunds = 0;
  let pendingCount = 0; let pendingAmount = 0;
  let incomeCount = 0; let expenseCount = 0;
  for (const t of transactions) {
    if (isIncome(t)) { income += t.amount; incomeCount += 1; }
    else if (isRefund(t)) refunds += t.amount;
    else if (isExpense(t)) {
      expensesGross += -t.amount;
      expenseCount += 1;
      if (t.status === 'pendente') { pendingCount += 1; pendingAmount += -t.amount; }
    }
  }
  const expensesNet = expensesGross - refunds;
  return {
    income, expensesGross, refunds, expensesNet,
    balance: income - expensesNet,
    incomeCount, expenseCount,
    pending: { count: pendingCount, amount: pendingAmount },
  };
}

/**
 * Despesas líquidas por categoria (estornos abatem a categoria deles; fatias que ficam em zero ou
 * negativas não aparecem). Despesas sem categoria aparecem como "Sem categoria".
 */
export function expensesByCategory(transactions, categoriesById) {
  const map = new Map();
  const get = (id) => {
    const key = id ?? '__sem';
    if (!map.has(key)) map.set(key, { categoryId: id ?? null, gross: 0, refunds: 0 });
    return map.get(key);
  };
  for (const t of transactions) {
    if (isExpense(t)) get(t.categoryId).gross += -t.amount;
    else if (isRefund(t)) get(t.categoryId).refunds += t.amount;
  }
  const rows = [...map.values()]
    .map((r) => {
      const cat = r.categoryId ? categoriesById.get(r.categoryId) : null;
      return {
        ...r, value: r.gross - r.refunds,
        name: r.categoryId ? (cat?.nome || r.categoryId) : 'Sem categoria',
        color: r.categoryId ? (cat?.cor || '#94a3b8') : '#94a3b8',
      };
    })
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);
  const total = rows.reduce((s, r) => s + r.value, 0);
  return rows.map((r) => ({ ...r, percent: total ? (r.value / total) * 100 : 0 }));
}

/** Lista de meses "AAAA-MM" de um mês até outro (inclusive). */
export function monthKeysBetween(startKey, endKey) {
  const keys = [];
  for (let k = startKey; k <= endKey; k = shiftMonth(k, 1)) keys.push(k);
  return keys;
}

/**
 * Meses mostrados nos gráficos mensais: os meses do período. Para dar o que comparar, se o período tem
 * menos de 3 meses, acrescenta meses ANTERIORES (só até o primeiro mês com dados).
 */
export function chartMonths(period, transactions, minMonths = 3) {
  const first = period.start.slice(0, 7);
  const last = period.end.slice(0, 7);
  let months = monthKeysBetween(first, last);
  const firstData = transactions.map((t) => t.date).sort()[0]?.slice(0, 7);
  while (months.length < minMonths && firstData && months[0] > firstData) months = [shiftMonth(months[0], -1), ...months];
  return months;
}

/**
 * Receitas, despesas líquidas e saldo de cada mês.
 * Com `period`, os meses DENTRO do período só contam as datas do período (o primeiro e o último mês
 * podem ficar "parciais"). Meses anteriores ao período, acrescentados só para comparação, contam inteiros.
 */
export function monthlySeries(transactions, months, period = null) {
  const byMonth = new Map(months.map((m) => [m, []]));
  for (const t of transactions) {
    const key = monthKey(t.date);
    if (!byMonth.has(key)) continue;
    const clipped = period && key >= period.start.slice(0, 7);
    if (clipped && (t.date < period.start || t.date > period.end)) continue;
    byMonth.get(key).push(t);
  }
  return months.map((month) => {
    const { start, end } = monthRange(month);
    const clipped = period && month >= period.start.slice(0, 7);
    const partial = Boolean(clipped && (period.start > start || period.end < end));
    return { month, partial, ...summarize(byMonth.get(month)) };
  });
}

/** Variação das despesas de um mês para o seguinte. */
export function spendingTrend(series) {
  return series.map((row, i) => {
    if (i === 0) return { month: row.month, expenses: row.expensesNet, delta: null, deltaPercent: null };
    const previous = series[i - 1].expensesNet;
    const delta = row.expensesNet - previous;
    return { month: row.month, expenses: row.expensesNet, delta, deltaPercent: previous > 0 ? (delta / previous) * 100 : null };
  });
}

/**
 * Evolução do saldo ACUMULADO do período (começa em zero e soma as movimentações).
 * Não é o saldo bancário: não sabemos o saldo que a conta tinha antes do período.
 * Períodos de até ~3 meses têm um ponto por dia com movimentação; períodos maiores, um por mês.
 */
export function balanceSeries(transactions, period) {
  const rows = inPeriod(transactions, period);
  const days = daysBetween(period.start, period.end) + 1;
  const granularity = days <= 92 ? 'dia' : 'mes';
  const buckets = new Map();
  for (const t of rows) {
    const key = granularity === 'dia' ? t.date : monthKey(t.date);
    buckets.set(key, (buckets.get(key) || 0) + t.amount);
  }
  let running = 0;
  const points = [...buckets.keys()].sort().map((key) => {
    running += buckets.get(key);
    return { key, flow: buckets.get(key), balance: running };
  });
  return { granularity, points };
}
