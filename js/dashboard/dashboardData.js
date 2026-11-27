// Reúne tudo o que o painel mostra, para um período. Sem tela e sem banco aqui: recebe os dados
// e devolve números (por isso é fácil de testar). `loadDashboard` é a versão que lê o IndexedDB.
import { resolvePeriod, referenceMonth } from './period.js';
import {
  inPeriod, summarize, expensesByCategory, chartMonths, monthlySeries, spendingTrend, balanceSeries,
} from './analytics.js';
import { buildInsights } from './insights.js';
import { analyzeCycles } from './cyclesAnalysis.js';
import { monthlyBudgetReport } from '../budget/budgetEngine.js';
import { buildCycles } from '../cycles/allocation.js';
import { loadModel } from '../cycles/model.js';
import { listCategories } from '../categorization/categoryService.js';
import { listBudgets } from '../budget/budgetService.js';
import { addDays, daysBetween, todayISO } from '../utils/dates.js';

/**
 * @param input { model (de loadModel/buildModel), categories, budgets, preset, custom, today }
 */
export function buildDashboard({ model, categories, budgets, preset, custom, today, imports = [] }) {
  const transactions = model.transactions;
  const categoriesById = new Map(categories.map((c) => [c.id, c]));
  const period = resolvePeriod(preset, { today, custom, transactions, imports });
  const base = { period, today, hasTransactions: transactions.length > 0, categoriesById };
  if (!period.valid) return { ...base, valid: false };

  const rows = inPeriod(transactions, period);
  const refMonth = referenceMonth(period, today);
  const months = chartMonths(period, transactions);
  const series = monthlySeries(transactions, months, period);
  const budgetReport = monthlyBudgetReport({ budgets, transactions, month: refMonth });

  return {
    ...base,
    valid: true,
    rows,
    isEmptyPeriod: rows.length === 0,
    summary: summarize(rows),
    byCategory: expensesByCategory(rows, categoriesById),
    refMonth,
    series,
    trend: spendingTrend(series),
    balance: balanceSeries(transactions, period),
    budgetReport,
    budgetUsage: budgetReport.totals.limit > 0 ? (budgetReport.totals.spent / budgetReport.totals.limit) * 100 : null,
    insights: buildInsights({ transactions, period, today, refMonth, budgets, categoriesById }),
    cycles: analyzeCycles(model, period),
    nextReceipts: nextReceipts(model.sources, today),
  };
}

/** Próximos recebimentos previstos (a partir de hoje). */
export function nextReceipts(sources, today, limit = 5) {
  return buildCycles(sources, today, addDays(today, 120))
    .slice(0, limit)
    .map((c) => ({ ...c, daysUntil: daysBetween(today, c.date) }));
}

/** Lê o banco e monta o painel. */
export async function loadDashboard(db, { preset, custom, today = todayISO() }) {
  const [categories, budgets, imports, first] = await Promise.all([
    listCategories(db), listBudgets(db), db.getAll('imports'), loadModel(db, { today }),
  ]);
  // 2ª leitura só para incluir os ciclos do período escolhido (inclusive futuros) no modelo
  const period = resolvePeriod(preset, { today, custom, transactions: first.transactions, imports });
  const model = period.valid ? await loadModel(db, { today, focusMonth: null, focusRange: period }) : first;
  return buildDashboard({ model, categories, budgets, preset, custom, today, imports });
}
