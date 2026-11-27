// SKILL 2: Análise financeira.
// Consulta receitas e despesas, compara períodos, aponta maiores categorias, aumentos e reduções,
// padrões de consumo, despesas recorrentes e movimentações específicas.
// Todos os cálculos reutilizam js/dashboard/analytics.js e insights.js (nada é recalculado à parte).
import {
  summarize, expensesByCategory, isExpense, isIncome, isRefund,
} from '../../dashboard/analytics.js';
import { findRecurring } from '../../dashboard/insights.js';
import { monthRange, shiftMonth, daysBetween, weekdayOf, WEEKDAYS } from '../../utils/dates.js';
import { monthLabel, normalizeText } from '../../utils/format.js';
import { money, ok, pct, ToolError } from '../results.js';
import { PERIOD_SCHEMA, resolveToolPeriod, emptyPeriodNote, monthsWithData } from '../periodParam.js';
import { findCategory } from '../snapshot.js';

const catName = (s, id) => (id ? s.categoriesById.get(id)?.nome || id : null);
const merchantOf = (t) => t.merchantName || t.normalizedName || '';

function periodInfo(r) {
  return { label: r.period.label, start: r.period.start, end: r.period.end };
}

function emptyResult(r) {
  return ok({ period: periodInfo(r), empty: true, latest_month_with_data: r.latestMonthWithData }, [emptyPeriodNote(r)]);
}

function resolveCategoryParam(s, text) {
  const cat = findCategory(s, text);
  if (!cat) {
    throw new ToolError('unknown_category', `Não existe a categoria "${text}".`, { valid_categories: s.categories.map((c) => c.nome) });
  }
  return cat;
}

const tools = [
  // ------------------------------------------------------------------ resumo
  {
    name: 'get_financial_summary',
    description: 'Receitas, despesas, estornos, saldo do período e despesas pendentes de revisão. Use para "quanto recebi e quanto gastei".',
    parameters: { type: 'object', properties: { period: PERIOD_SCHEMA } },
    handler(s, { period }) {
      const r = resolveToolPeriod(s, period);
      if (!r.hasData) return emptyResult(r);
      const t = summarize(r.rows);
      return ok({
        period: periodInfo(r), empty: false,
        income: money(t.income), expenses_gross: money(t.expensesGross), refunds: money(t.refunds),
        expenses_net: money(t.expensesNet), balance: money(t.balance),
        income_count: t.incomeCount, expense_count: t.expenseCount,
        pending_expenses: { count: t.pending.count, amount: money(t.pending.amount) },
      }, ['O saldo é receitas menos despesas líquidas (despesas − estornos) das movimentações importadas. NÃO é o saldo da conta bancária.']);
    },
  },

  // ------------------------------------------------------------------ por categoria
  {
    name: 'get_expenses_by_category',
    description: 'Despesas líquidas por categoria no período, com percentual. Com "category", devolve só o total daquela categoria.',
    parameters: {
      type: 'object',
      properties: {
        period: PERIOD_SCHEMA,
        category: { type: 'string', maxLength: 40, description: 'Nome ou id da categoria (ex.: Alimentação).' },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
      },
    },
    handler(s, { period, category, limit }) {
      const r = resolveToolPeriod(s, period);
      if (!r.hasData) return emptyResult(r);
      const list = expensesByCategory(r.rows, s.categoriesById);
      const total = list.reduce((sum, c) => sum + c.value, 0);

      if (category) {
        const cat = resolveCategoryParam(s, category);
        const item = list.find((c) => c.categoryId === cat.id);
        const count = r.rows.filter((t) => isExpense(t) && t.categoryId === cat.id).length;
        return ok({
          period: periodInfo(r), empty: false, category: { id: cat.id, name: cat.nome },
          total: money(item ? item.value : 0), percent_of_expenses: item ? pct(item.percent) : 0,
          expense_count: count, total_expenses_in_period: money(total),
        }, item ? [] : [`Nenhuma despesa em ${cat.nome} neste período.`]);
      }
      return ok({
        period: periodInfo(r), empty: false, total_expenses: money(total),
        categories: list.slice(0, limit).map((c) => ({ category: c.name, total: money(c.value), percent: pct(c.percent) })),
        omitted_categories: Math.max(0, list.length - limit),
      }, ['Valores líquidos: estornos abatem a categoria deles. "Sem categoria" são despesas ainda não classificadas.']);
    },
  },

  // ------------------------------------------------------------------ comparar períodos
  {
    name: 'compare_periods',
    description: 'Compara dois períodos (receitas, despesas, saldo e categorias que mais subiram ou caíram). Ex.: este mês x mês passado.',
    parameters: {
      type: 'object',
      required: ['period_a', 'period_b'],
      properties: { period_a: PERIOD_SCHEMA, period_b: PERIOD_SCHEMA },
    },
    handler(s, { period_a, period_b }) {
      const a = resolveToolPeriod(s, period_a);
      const b = resolveToolPeriod(s, period_b);
      if (!a.hasData || !b.hasData) {
        const missing = [!a.hasData && a.period.label, !b.hasData && b.period.label].filter(Boolean);
        return ok({
          comparable: false, period_a: periodInfo(a), period_b: periodInfo(b), periods_without_data: missing,
          latest_month_with_data: a.latestMonthWithData,
        }, [`Não dá para comparar: sem transações em ${missing.join(' e ')}.`]);
      }
      const ta = summarize(a.rows);
      const tb = summarize(b.rows);
      const byCat = (rows) => new Map(expensesByCategory(rows, s.categoriesById).map((c) => [c.name, c.value]));
      const ca = byCat(a.rows);
      const cb = byCat(b.rows);
      const changes = [...new Set([...ca.keys(), ...cb.keys()])].map((name) => {
        const va = ca.get(name) || 0;
        const vb = cb.get(name) || 0;
        return { category: name, period_a: money(va), period_b: money(vb), delta: money(va - vb), delta_cents: va - vb, percent: vb > 0 ? pct(((va - vb) / vb) * 100) : null };
      });
      const clean = ({ delta_cents, ...rest }) => rest;
      const diff = ta.expensesNet - tb.expensesNet;
      return ok({
        comparable: true,
        period_a: { ...periodInfo(a), income: money(ta.income), expenses_net: money(ta.expensesNet), balance: money(ta.balance) },
        period_b: { ...periodInfo(b), income: money(tb.income), expenses_net: money(tb.expensesNet), balance: money(tb.balance) },
        expenses_difference: { delta: money(diff), direction: diff > 0 ? 'more' : diff < 0 ? 'less' : 'same', percent: tb.expensesNet > 0 ? pct((diff / tb.expensesNet) * 100) : null },
        income_difference: money(ta.income - tb.income),
        balance_difference: money(ta.balance - tb.balance),
        biggest_increases: changes.filter((c) => c.delta_cents > 0).sort((x, y) => y.delta_cents - x.delta_cents).slice(0, 5).map(clean),
        biggest_decreases: changes.filter((c) => c.delta_cents < 0).sort((x, y) => x.delta_cents - y.delta_cents).slice(0, 5).map(clean),
      }, ['"delta" = período A menos período B. Se um dos períodos for parcial (mês em andamento), a comparação favorece o período menor.']);
    },
  },

  // ------------------------------------------------------------------ busca de transações
  {
    name: 'search_transactions',
    description: 'Busca movimentações específicas (maior despesa, gastos em um estabelecimento etc.). Devolve no máximo 50 linhas.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 60, description: 'Texto do estabelecimento ou da descrição.' },
        category: { type: 'string', maxLength: 40, description: 'Nome da categoria, ou "sem_categoria".' },
        direction: { type: 'string', enum: ['saida', 'entrada', 'estorno'] },
        period: PERIOD_SCHEMA,
        min_amount_cents: { type: 'integer', minimum: 0 },
        max_amount_cents: { type: 'integer', minimum: 0 },
        sort: { type: 'string', enum: ['date_desc', 'date_asc', 'amount_desc', 'amount_asc'], default: 'date_desc' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
      },
    },
    handler(s, p) {
      const r = resolveToolPeriod(s, p.period);
      if (!r.hasData) return emptyResult(r);
      const term = normalizeText(p.query || '');
      const category = p.category && p.category !== 'sem_categoria' ? resolveCategoryParam(s, p.category) : null;
      let rows = r.rows.filter((t) => {
        if (p.direction === 'saida' && !isExpense(t)) return false;
        if (p.direction === 'entrada' && !isIncome(t)) return false;
        if (p.direction === 'estorno' && !isRefund(t)) return false;
        if (term && !normalizeText(`${t.originalDescription} ${t.merchantName || ''}`).includes(term)) return false;
        if (p.category === 'sem_categoria' && t.categoryId) return false;
        if (category && t.categoryId !== category.id) return false;
        const abs = Math.abs(t.amount);
        if (p.min_amount_cents !== undefined && abs < p.min_amount_cents) return false;
        if (p.max_amount_cents !== undefined && abs > p.max_amount_cents) return false;
        return true;
      });
      const sorters = {
        date_desc: (a, b) => b.date.localeCompare(a.date) || b.id - a.id,
        date_asc: (a, b) => a.date.localeCompare(b.date) || a.id - b.id,
        amount_desc: (a, b) => Math.abs(b.amount) - Math.abs(a.amount),
        amount_asc: (a, b) => Math.abs(a.amount) - Math.abs(b.amount),
      };
      rows = rows.slice().sort(sorters[p.sort]);
      if (!rows.length) {
        return ok({ period: periodInfo(r), empty: false, matched_count: 0, transactions: [] }, ['Nenhuma transação encontrada com esses filtros.']);
      }
      const net = rows.reduce((sum, t) => sum + t.amount, 0);
      return ok({
        period: periodInfo(r), empty: false, matched_count: rows.length, returned: Math.min(rows.length, p.limit),
        net_total_of_matches: money(net),
        transactions: rows.slice(0, p.limit).map((t) => ({
          id: t.id, date: t.date, description: t.originalDescription, merchant: merchantOf(t),
          amount: money(t.amount), category: catName(s, t.categoryId), status: t.status,
        })),
      }, rows.length > p.limit ? [`Mostrando ${p.limit} de ${rows.length} resultados.`] : []);
    },
  },

  // ------------------------------------------------------------------ estabelecimentos
  {
    name: 'get_top_merchants',
    description: 'Estabelecimentos que mais aparecem (quantidade de lançamentos e total) no período.',
    parameters: {
      type: 'object',
      properties: {
        period: PERIOD_SCHEMA,
        direction: { type: 'string', enum: ['saida', 'entrada'], default: 'saida' },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
      },
    },
    handler(s, { period, direction, limit }) {
      const r = resolveToolPeriod(s, period);
      if (!r.hasData) return emptyResult(r);
      const groups = new Map();
      for (const t of r.rows) {
        if (direction === 'saida' ? !isExpense(t) : !isIncome(t)) continue;
        const key = merchantOf(t);
        if (!key) continue;
        const g = groups.get(key) || { merchant: key, count: 0, total: 0 };
        g.count += 1;
        g.total += Math.abs(t.amount);
        groups.set(key, g);
      }
      const list = [...groups.values()].sort((a, b) => b.count - a.count || b.total - a.total);
      return ok({
        period: periodInfo(r), empty: false, distinct_merchants: list.length,
        merchants: list.slice(0, limit).map((g) => ({ merchant: g.merchant, count: g.count, total: money(g.total) })),
      }, list.length ? [] : ['Não há lançamentos desse tipo no período.']);
    },
  },

  // ------------------------------------------------------------------ recorrentes
  {
    name: 'get_recurring_expenses',
    description: 'Despesas que parecem recorrentes: mesmo estabelecimento em 2+ meses com valores até 10% diferentes.',
    parameters: { type: 'object', properties: {} },
    handler(s) {
      const months = monthsWithData(s);
      const items = findRecurring(s.transactions);
      if (months.length < 2) {
        return ok({ enough_data: false, months_with_data: months.length, items: [] }, ['Preciso de pelo menos 2 meses de dados para identificar recorrência.']);
      }
      return ok({
        enough_data: true, months_with_data: months.length,
        items: items.slice(0, 15).map((i) => ({ merchant: i.name, months: i.months, typical_amount: money(i.typical) })),
      }, items.length ? ['É uma detecção por padrão (mesmo nome e valor parecido), não uma garantia de assinatura.'] : ['Nenhuma despesa recorrente encontrada nos dados.']);
    },
  },

  // ------------------------------------------------------------------ tendência
  {
    name: 'get_spending_trend',
    description: 'Evolução mensal das despesas (total ou de uma categoria) nos últimos meses, com variação do último mês.',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', maxLength: 40 },
        months: { type: 'integer', minimum: 2, maximum: 12, default: 3 },
        until_month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$', description: 'Último mês da série (padrão: mês mais recente com dados).' },
      },
    },
    handler(s, { category, months, until_month }) {
      const withData = monthsWithData(s);
      if (!withData.length) return ok({ enough_data: false, series: [] }, ['Ainda não há transações importadas.']);
      const cat = category ? resolveCategoryParam(s, category) : null;
      const last = until_month || withData[0];
      const keys = Array.from({ length: months }, (_, i) => shiftMonth(last, i - months + 1));
      const series = keys.map((key) => {
        const { start, end } = monthRange(key);
        const rows = s.transactions.filter((t) => t.date >= start && t.date <= end && (!cat || t.categoryId === cat.id));
        const t = summarize(rows);
        return { month: key, label: monthLabel(key), total: money(t.expensesNet), cents: t.expensesNet, hasExpenses: rows.some(isExpense) };
      });
      const filled = series.filter((p) => p.hasExpenses).length;
      const enough = filled >= 2 && series[series.length - 1].hasExpenses;
      const prev = series[series.length - 2].cents;
      const cur = series[series.length - 1].cents;
      const change = prev > 0 ? ((cur - prev) / prev) * 100 : null;
      const partial = last === s.today.slice(0, 7) && s.today < monthRange(last).end;
      return ok({
        category: cat ? { id: cat.id, name: cat.nome } : null, until_month: last, enough_data: enough,
        series: series.map(({ month, label, total }) => ({ month, label, total })),
        last_month_change: enough && change !== null
          ? { delta: money(cur - prev), percent: pct(change), direction: change > 10 ? 'increasing' : change < -10 ? 'decreasing' : 'stable' } : null,
      }, [
        ...(enough ? [] : ['Dados insuficientes: preciso de despesas no último mês e em pelo menos mais um mês da série.']),
        ...(partial ? ['O último mês ainda está em andamento, então a comparação pode parecer uma redução.'] : []),
        'Direção: "increasing" ou "decreasing" só quando a variação passa de 10%.',
      ]);
    },
  },

  // ------------------------------------------------------------------ padrões
  {
    name: 'get_spending_patterns',
    description: 'Padrões de consumo no período: ticket médio, maior despesa, dia da semana em que mais gasta, dias com gasto.',
    parameters: { type: 'object', properties: { period: PERIOD_SCHEMA } },
    handler(s, { period }) {
      const r = resolveToolPeriod(s, period);
      if (!r.hasData) return emptyResult(r);
      const expenses = r.rows.filter(isExpense);
      if (expenses.length < 5) {
        return ok({ period: periodInfo(r), enough_data: false, expense_count: expenses.length }, ['Preciso de pelo menos 5 despesas no período para falar em padrões.']);
      }
      const total = expenses.reduce((sum, t) => sum + -t.amount, 0);
      const byWeekday = Array(7).fill(0);
      for (const t of expenses) byWeekday[weekdayOf(t.date)] += -t.amount;
      const topDay = byWeekday.indexOf(Math.max(...byWeekday));
      const biggest = expenses.slice().sort((a, b) => a.amount - b.amount)[0];
      return ok({
        period: periodInfo(r), enough_data: true, expense_count: expenses.length,
        average_ticket: money(Math.round(total / expenses.length)),
        days_with_spending: new Set(expenses.map((t) => t.date)).size,
        days_in_period: daysBetween(r.period.start, r.period.end) + 1,
        biggest_expense: { date: biggest.date, description: biggest.originalDescription, amount: money(biggest.amount) },
        top_weekday: { name: WEEKDAYS[topDay], total: money(byWeekday[topDay]) },
        by_weekday: byWeekday.map((v, i) => ({ weekday: WEEKDAYS[i], total: money(v) })),
      });
    },
  },
];

export default {
  id: 'analise-financeira',
  name: 'Análise financeira',
  description: 'Consulta receitas e despesas, compara períodos, aponta maiores categorias, aumentos, reduções, padrões e recorrências.',
  tools,
};
