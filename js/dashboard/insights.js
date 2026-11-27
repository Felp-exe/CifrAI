// Insights automáticos: calculados por JavaScript a partir dos dados reais (sem IA generativa).
// Regra: só dizemos o que os dados sustentam. Sem dados suficientes, o insight vai para a lista
// "indisponíveis", com o motivo, em vez de inventar uma conclusão.
import { formatBRL, monthLabel, monthKey } from '../utils/format.js';
import { shiftMonth, monthRange } from '../utils/dates.js';
import {
  summarize, expensesByCategory, inPeriod, isExpense,
} from './analytics.js';
import { monthlyBudgetReport, LEVEL_LABEL } from '../budget/budgetEngine.js';

const pct = (n) => `${n.toFixed(1).replace('.', ',')}%`;

/**
 * @param input { transactions (todas), period, today, refMonth, budgets, categoriesById }
 * @returns {{ items: Array<{id,tone,title,text}>, unavailable: Array<{id,title,reason}> }}
 */
export function buildInsights({ transactions, period, today, refMonth, budgets, categoriesById }) {
  const items = [];
  const unavailable = [];
  const rows = inPeriod(transactions, period);
  const totals = summarize(rows);
  const name = (id) => categoriesById.get(id)?.nome || id;

  // 1) Categoria com maior gasto no período
  const byCategory = expensesByCategory(rows, categoriesById).filter((c) => c.categoryId);
  if (byCategory.length) {
    const top = byCategory[0];
    // parte do valor que ainda não foi confirmada por você (ex.: "Outros" automático)
    const unconfirmed = rows.filter((t) => isExpense(t) && t.categoryId === top.categoryId && t.status === 'pendente')
      .reduce((s, t) => s + -t.amount, 0);
    items.push({
      id: 'maior-categoria', tone: 'info', title: 'Maior gasto do período',
      text: `${top.name} foi a categoria com maior gasto: ${formatBRL(top.value)} (${pct((top.value / (totals.expensesNet || 1)) * 100)} das despesas).`
        + (unconfirmed ? ` Atenção: ${formatBRL(unconfirmed)} dessa categoria ainda estão pendentes de revisão e podem mudar de categoria.` : ''),
    });
  } else {
    unavailable.push({ id: 'maior-categoria', title: 'Maior gasto do período', reason: 'Não há despesas categorizadas no período.' });
  }

  // 2) Categoria que mais aumentou em relação ao mês anterior
  const previousMonth = shiftMonth(refMonth, -1);
  const monthTxs = (m) => inPeriod(transactions, monthRange(m));
  const current = expensesByCategory(monthTxs(refMonth), categoriesById).filter((c) => c.categoryId);
  const before = expensesByCategory(monthTxs(previousMonth), categoriesById).filter((c) => c.categoryId);
  if (current.length && before.length) {
    const prevMap = new Map(before.map((c) => [c.categoryId, c.value]));
    const rises = current
      .filter((c) => prevMap.has(c.categoryId) && c.value > prevMap.get(c.categoryId))
      .map((c) => ({ ...c, rise: c.value - prevMap.get(c.categoryId), previous: prevMap.get(c.categoryId) }))
      .sort((a, b) => b.rise - a.rise);
    const partial = refMonth === today.slice(0, 7) && today < monthRange(refMonth).end;
    const note = partial ? ' (o mês atual ainda não terminou)' : '';
    if (rises.length) {
      const r = rises[0];
      items.push({
        id: 'maior-aumento', tone: 'warn', title: 'Maior aumento',
        text: `${r.name} subiu ${formatBRL(r.rise)} (${pct((r.rise / r.previous) * 100)}) em ${monthLabel(refMonth)} em relação a ${monthLabel(previousMonth)}${note}.`,
      });
    } else {
      items.push({
        id: 'maior-aumento', tone: 'ok', title: 'Maior aumento',
        text: `Nenhuma categoria gastou mais em ${monthLabel(refMonth)} do que em ${monthLabel(previousMonth)}${note}.`,
      });
    }
  } else {
    unavailable.push({
      id: 'maior-aumento', title: 'Maior aumento',
      reason: `Preciso de despesas categorizadas em ${monthLabel(previousMonth)} e em ${monthLabel(refMonth)} para comparar.`,
    });
  }

  // 3) Percentual da renda comprometido
  if (totals.income > 0 && totals.expenseCount > 0) {
    const share = (totals.expensesNet / totals.income) * 100;
    items.push({
      id: 'renda-comprometida', tone: share > 100 ? 'warn' : share >= 80 ? 'warn' : 'ok', title: 'Renda comprometida',
      text: `As despesas (${formatBRL(totals.expensesNet)}) correspondem a ${pct(share)} das receitas (${formatBRL(totals.income)}) do período.`,
    });
  } else {
    unavailable.push({ id: 'renda-comprometida', title: 'Renda comprometida', reason: 'Preciso de receitas e de despesas no período.' });
  }

  // 4) Orçamentos próximos do limite (mês de referência)
  if (budgets.length) {
    const report = monthlyBudgetReport({ budgets, transactions, month: refMonth });
    const alerts = report.rows.filter((r) => r.level !== 'ok').sort((a, b) => b.percent - a.percent);
    if (alerts.length) {
      items.push({
        id: 'orcamentos', tone: 'warn', title: `Orçamentos em alerta (${monthLabel(refMonth)})`,
        text: alerts.map((a) => `${name(a.categoryId)}: ${pct(a.percent)} do limite (${LEVEL_LABEL[a.level].toLowerCase()})`).join('; ') + '.',
      });
    } else {
      items.push({ id: 'orcamentos', tone: 'ok', title: `Orçamentos (${monthLabel(refMonth)})`, text: 'Nenhum orçamento está próximo do limite.' });
    }
  } else {
    unavailable.push({ id: 'orcamentos', title: 'Orçamentos em alerta', reason: 'Você ainda não cadastrou orçamentos.' });
  }

  // 5) Despesas recorrentes (mesmo estabelecimento, em 2+ meses, valores parecidos)
  const recurring = findRecurring(transactions.filter((t) => t.date <= period.end));
  if (recurring.length) {
    items.push({
      id: 'recorrentes', tone: 'info', title: 'Possíveis despesas recorrentes',
      text: recurring.slice(0, 5).map((r) => `${r.name} (~${formatBRL(r.typical)} em ${r.months} meses)`).join('; ') + '.',
    });
  } else {
    unavailable.push({
      id: 'recorrentes', title: 'Despesas recorrentes',
      reason: 'Preciso ver o mesmo estabelecimento em pelo menos 2 meses, com valores parecidos (até 10% de diferença).',
    });
  }

  // 6) Receitas x despesas
  if (totals.income > 0 || totals.expensesNet > 0) {
    const diff = totals.income - totals.expensesNet;
    items.push({
      id: 'resultado', tone: diff >= 0 ? 'ok' : 'warn', title: 'Receitas x despesas',
      text: `Receitas de ${formatBRL(totals.income)} e despesas de ${formatBRL(totals.expensesNet)}: ${diff >= 0 ? 'sobraram' : 'faltaram'} ${formatBRL(Math.abs(diff))} nas movimentações do período.`,
    });
  } else {
    unavailable.push({ id: 'resultado', title: 'Receitas x despesas', reason: 'Não há movimentações no período.' });
  }

  return { items, unavailable };
}

/**
 * Despesas que se repetem: o mesmo estabelecimento em pelo menos 2 meses diferentes, com o total mensal
 * dentro de 10% entre o menor e o maior mês.
 */
export function findRecurring(transactions) {
  const groups = new Map();
  for (const t of transactions.filter(isExpense)) {
    const key = t.merchantName || t.normalizedName;
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, new Map());
    const months = groups.get(key);
    months.set(monthKey(t.date), (months.get(monthKey(t.date)) || 0) + -t.amount);
  }
  const result = [];
  for (const [name, months] of groups) {
    const totals = [...months.values()];
    if (totals.length < 2) continue;
    const min = Math.min(...totals);
    const max = Math.max(...totals);
    if (max > min * 1.1) continue;
    const sorted = totals.slice().sort((a, b) => a - b);
    result.push({ name, months: totals.length, typical: sorted[Math.floor(sorted.length / 2)] });
  }
  return result.sort((a, b) => b.months - a.months || b.typical - a.typical);
}
