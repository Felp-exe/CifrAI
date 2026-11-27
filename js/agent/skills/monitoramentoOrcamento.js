// SKILL 3: Monitoramento de orçamento.
// Consulta orçamentos, compara limite x gasto, aponta categorias próximas/acima do limite,
// calcula o valor disponível e faz PROJEÇÕES (sempre rotuladas como projeção).
// Usa monthlyBudgetReport (Etapa 4): a mesma regra de gasto do painel de Orçamento.
import { monthlyBudgetReport, LEVEL_LABEL, WARN_AT_PERCENT } from '../../budget/budgetEngine.js';
import { monthRange, daysInMonth, addDays, parseISO, daysBetween } from '../../utils/dates.js';
import { monthLabel } from '../../utils/format.js';
import { money, ok, pct, ToolError } from '../results.js';
import { monthsWithData } from '../periodParam.js';
import { findCategory } from '../snapshot.js';

const MONTH = { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$', description: 'Mês no formato AAAA-MM (padrão: mês atual).' };

function selectBudgets(s, categoryText) {
  if (!categoryText) return s.budgets;
  const cat = findCategory(s, categoryText);
  if (!cat) throw new ToolError('unknown_category', `Não existe a categoria "${categoryText}".`, { valid_categories: s.categories.map((c) => c.nome) });
  return s.budgets.filter((b) => b.categoryId === cat.id);
}

const catName = (s, id) => s.categoriesById.get(id)?.nome || id;

/** Situação sem dados: devolve o aviso padrão (não inventa orçamento restante de um mês vazio). */
function noMonthData(s, month) {
  const latest = monthsWithData(s)[0] || null;
  return ok({
    month: { key: month, label: monthLabel(month) }, empty: true,
    latest_month_with_data: latest ? { month: latest, label: monthLabel(latest) } : null,
  }, [`Não há transações em ${monthLabel(month)}, então não há gasto a comparar com os limites.${latest ? ` O mês mais recente com dados é ${monthLabel(latest)}.` : ''}`]);
}

const tools = [
  {
    name: 'get_budget_status',
    description: 'Orçamentos do mês: limite, gasto, valor disponível, percentual consumido e alerta (em dia, próximo do limite, ultrapassado).',
    parameters: {
      type: 'object',
      properties: {
        month: MONTH,
        category: { type: 'string', maxLength: 40 },
        only_alerts: { type: 'boolean', default: false, description: 'Só categorias próximas do limite (80%+) ou acima.' },
      },
    },
    handler(s, { month, category, only_alerts }) {
      const key = month || s.today.slice(0, 7);
      if (!s.budgets.length) return ok({ month: { key, label: monthLabel(key) }, no_budgets: true, rows: [] }, ['Nenhum orçamento cadastrado. Crie limites na aba Orçamento.']);
      const budgets = selectBudgets(s, category);
      if (!budgets.length) return ok({ month: { key, label: monthLabel(key) }, rows: [] }, ['Essa categoria não tem orçamento cadastrado.']);
      const { start, end } = monthRange(key);
      if (!s.transactions.some((t) => t.date >= start && t.date <= end)) return noMonthData(s, key);

      const report = monthlyBudgetReport({ budgets, transactions: s.transactions, month: key });
      let rows = report.rows.slice().sort((a, b) => b.percent - a.percent);
      if (only_alerts) rows = rows.filter((r) => r.level !== 'ok');
      const totals = {
        limit: money(report.totals.limit), spent: money(report.totals.spent),
        remaining: money(report.totals.limit - report.totals.spent), alerts: report.totals.alerts,
      };
      return ok({
        month: { key, label: monthLabel(key) }, empty: false, alert_threshold_percent: WARN_AT_PERCENT,
        rows: rows.map((r) => ({
          category: catName(s, r.categoryId), limit: money(r.limit), spent: money(r.spent),
          available: money(Math.max(0, r.remaining)), exceeded_by: r.remaining < 0 ? money(-r.remaining) : null,
          percent_used: pct(r.percent), level: r.level, level_label: LEVEL_LABEL[r.level],
          pending_review: r.detail.pendingCount ? { count: r.detail.pendingCount, amount: money(r.detail.pendingAmount) } : null,
        })),
        totals,
        uncategorized_expenses: { count: report.uncategorized.count, total: money(report.uncategorized.total) },
      }, [
        'O gasto conta só saídas com categoria do mês; estornos abatem; entradas e itens sem categoria não entram.',
        ...(only_alerts && !rows.length ? ['Nenhuma categoria está próxima do limite ou acima dele.'] : []),
      ]);
    },
  },

  {
    name: 'project_budget',
    description: 'PROJEÇÃO do mês em andamento: ritmo diário de gasto, total estimado até o fim do mês e data estimada para atingir o limite.',
    parameters: {
      type: 'object',
      properties: { month: MONTH, category: { type: 'string', maxLength: 40 } },
    },
    handler(s, { month, category }) {
      const key = month || s.today.slice(0, 7);
      const current = s.today.slice(0, 7);
      const disclaimer = 'É uma PROJEÇÃO simples: assume que o ritmo de gasto até hoje continua igual. Não é uma previsão garantida.';
      if (key !== current) {
        return ok({ month: { key, label: monthLabel(key) }, is_projection: true, not_applicable: true },
          [`Projeção só faz sentido para o mês em andamento (${monthLabel(current)}).`]);
      }
      if (!s.budgets.length) return ok({ month: { key, label: monthLabel(key) }, no_budgets: true, rows: [] }, ['Nenhum orçamento cadastrado.']);
      const budgets = selectBudgets(s, category);
      const { y, m, d: elapsed } = parseISO(s.today);
      const total = daysInMonth(y, m);
      const { start, end } = monthRange(key);
      const monthTxs = s.transactions.filter((t) => t.date >= start && t.date <= end);
      if (!monthTxs.length) return noMonthData(s, key);

      const lastDate = monthTxs.map((t) => t.date).sort().pop();
      const stale = daysBetween(lastDate, s.today) > 7;
      const report = monthlyBudgetReport({ budgets, transactions: s.transactions, month: key });
      const rows = report.rows.map((r) => {
        const base = { category: catName(s, r.categoryId), limit: money(r.limit), spent_so_far: money(r.spent) };
        if (r.spent > r.limit) return { ...base, status: 'already_exceeded', exceeded_by: money(r.spent - r.limit) };
        if (elapsed < 5 || r.spent === 0) return { ...base, status: 'insufficient_data' };
        const pace = r.spent / elapsed; // centavos por dia
        const projected = Math.round(pace * total);
        const daysToLimit = Math.ceil(r.limit / pace);
        const hitDate = addDays(start, daysToLimit - 1);
        return {
          ...base, status: projected > r.limit ? 'will_exceed' : 'on_track',
          daily_pace: money(Math.round(pace)), projected_month_total: money(projected),
          projected_percent: pct((projected / r.limit) * 100),
          estimated_limit_date: projected > r.limit && hitDate <= end ? hitDate : null,
        };
      });
      return ok({
        month: { key, label: monthLabel(key) }, is_projection: true, days_elapsed: elapsed, days_in_month: total,
        last_transaction_date: lastDate, rows,
      }, [
        disclaimer,
        ...(elapsed < 5 ? ['Estamos nos primeiros dias do mês: poucos dados para projetar.'] : []),
        ...(stale ? [`O último lançamento importado é de ${lastDate}; importe um extrato mais recente para a projeção refletir a realidade.`] : []),
      ]);
    },
  },
];

export default {
  id: 'monitoramento-orcamento',
  name: 'Monitoramento de orçamento',
  description: 'Compara limites e gastos, aponta categorias em alerta, calcula o valor disponível e projeta o ritmo de gasto.',
  tools,
  uses: ['get_spending_trend'],
};
