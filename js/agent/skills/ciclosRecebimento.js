// SKILL 4: Gestão de ciclos de recebimento.
// Consulta fontes de renda, próximos recebimentos, ciclos (ativos e anteriores), despesas comprometidas
// e realizadas, despesas sem alocação e o valor disponível por ciclo.
// Usa o modelo de ciclos da Etapa 4 (buildModel): as mesmas regras de alocação da tela Ciclos.
import { buildCycles } from '../../cycles/allocation.js';
import { occurrences, describeSource } from '../../cycles/incomeSchedule.js';
import { STATUS_LABEL } from '../../cycles/summary.js';
import { addDays, daysBetween, monthRange } from '../../utils/dates.js';
import { monthLabel, normalizeText } from '../../utils/format.js';
import { money, ok, pct, ToolError } from '../results.js';
import { PERIOD_SCHEMA, resolveToolPeriod, emptyPeriodNote } from '../periodParam.js';
import { getModel } from '../snapshot.js';

const WINDOW_DAYS = 120;
const SOURCE = { type: 'string', maxLength: 40, description: 'Nome da fonte de renda (opcional).' };

const sourceMatches = (cycleName, text) => !text || normalizeText(cycleName).includes(normalizeText(text));
const focus = (s) => ({ start: addDays(s.today, -WINDOW_DAYS), end: addDays(s.today, WINDOW_DAYS) });

function requireSources(s) {
  if (!s.sources.length) throw new ToolError('no_income_sources', 'Nenhuma fonte de renda cadastrada. Cadastre em Ciclos > Rendas.');
}

function cycleView(s, summary, { expensesLimit = 10 } = {}) {
  const c = summary.cycle;
  return {
    id: c.id, source: c.name, date: c.date, status: summary.status, status_label: STATUS_LABEL[summary.status],
    expected: money(summary.expected), received: money(summary.received),
    committed: money(summary.committed), realized: money(summary.realized), allocated_total: money(summary.allocated),
    available_planned: money(summary.plannedBalance), available_real: money(summary.realBalance),
    commitment_percent: summary.expected ? pct((summary.allocated / summary.expected) * 100) : null,
    expense_count: summary.expenses.length,
    expenses: summary.expenses.slice().sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, expensesLimit).map((e) => ({
      date: e.tx.date, description: e.tx.originalDescription, part: money(Math.abs(e.amount)), allocation: e.mode,
    })),
  };
}

const tools = [
  {
    name: 'list_income_sources',
    description: 'Fontes de renda cadastradas (nome, valor esperado, frequência, próximas datas).',
    parameters: { type: 'object', properties: {} },
    handler(s) {
      if (!s.sources.length) return ok({ sources: [] }, ['Nenhuma fonte de renda cadastrada.']);
      return ok({
        sources: s.sources.map((src) => ({
          name: src.name, expected_amount: money(src.amount), schedule: describeSource(src), active: src.ativa !== false,
          next_dates: occurrences(src, s.today, addDays(s.today, 400)).slice(0, 3),
        })),
      });
    },
  },

  {
    name: 'get_upcoming_income',
    description: 'Próximos recebimentos previstos a partir de hoje.',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 365, default: 60 },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
        source: SOURCE,
      },
    },
    handler(s, { days, limit, source }) {
      requireSources(s);
      const list = buildCycles(s.sources, s.today, addDays(s.today, days)).filter((c) => sourceMatches(c.name, source));
      return ok({
        from: s.today, days_ahead: days,
        upcoming: list.slice(0, limit).map((c) => ({ date: c.date, source: c.name, expected: money(c.expected), days_until: daysBetween(s.today, c.date) })),
        total_expected_in_window: money(list.reduce((sum, c) => sum + c.expected, 0)),
      }, list.length ? [] : [`Nenhum recebimento previsto nos próximos ${days} dias${source ? ` para "${source}"` : ''}.`]);
    },
  },

  {
    name: 'get_cycle_details',
    description: 'Detalhes de ciclos: previsto, recebido, despesas comprometidas e realizadas, valor disponível (planejado e real) e percentual comprometido.',
    parameters: {
      type: 'object',
      properties: {
        when: { type: 'string', enum: ['current', 'next', 'last', 'month'], default: 'current', description: 'current = último recebimento já ocorrido; next = próximo; last = o anterior ao atual; month = todos do mês.' },
        month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
        source: SOURCE,
      },
    },
    handler(s, { when, month, source }) {
      requireSources(s);
      if (when === 'month' && !month) throw new ToolError('invalid_parameters', 'Para when="month", informe "month" (AAAA-MM).');
      const model = getModel(s, when === 'month' ? { start: monthRange(month).start, end: monthRange(month).end } : focus(s));
      const all = model.summaries.filter((x) => sourceMatches(x.cycle.name, source));
      let chosen;
      if (when === 'month') {
        chosen = all.filter((x) => x.cycle.date.startsWith(month));
      } else {
        const names = [...new Set(all.map((x) => x.cycle.name))];
        chosen = names.map((name) => {
          const mine = all.filter((x) => x.cycle.name === name).sort((a, b) => a.cycle.date.localeCompare(b.cycle.date));
          const pastIndex = mine.map((x) => x.cycle.date <= s.today).lastIndexOf(true);
          if (when === 'next') return mine[pastIndex + 1];
          if (when === 'current') return mine[pastIndex];
          return mine[pastIndex - 1];
        }).filter(Boolean);
      }
      if (!chosen.length) {
        return ok({ when, cycles: [] }, [`Nenhum ciclo encontrado${source ? ` para "${source}"` : ''}${when === 'month' ? ` em ${monthLabel(month)}` : ''}.`]);
      }
      return ok({ when, allocation_mode: s.allocationMode, cycles: chosen.sort((a, b) => a.cycle.date.localeCompare(b.cycle.date)).map((x) => cycleView(s, x)) }, [
        'Comprometidas = despesas pagas ANTES do recebimento; realizadas = pagas DEPOIS. Disponível planejado = previsto − despesas; disponível real = recebido − despesas.',
        'Os saldos dos ciclos não são o saldo da conta bancária.',
      ]);
    },
  },

  {
    name: 'get_upcoming_commitment',
    description: 'Quanto do PRÓXIMO recebimento já está comprometido por despesas feitas antes dele (ex.: "quanto do meu próximo salário já está comprometido?").',
    parameters: { type: 'object', properties: { source: SOURCE } },
    handler(s, { source }) {
      requireSources(s);
      const next = buildCycles(s.sources, s.today, addDays(s.today, WINDOW_DAYS)).find((c) => c.date > s.today && sourceMatches(c.name, source));
      if (!next) return ok({ cycle: null }, [`Nenhum recebimento futuro encontrado${source ? ` para "${source}"` : ''}.`]);

      const find = (model) => model.summaries.find((x) => x.cycle.id === next.id);
      const current = find(getModel(s, focus(s)));
      const asNext = find(getModel(s, focus(s), 'proximo'));
      const share = (v) => (next.expected ? pct((v / next.expected) * 100) : null);
      return ok({
        cycle: { id: next.id, source: next.name, date: next.date, expected: money(next.expected), days_until: daysBetween(s.today, next.date) },
        allocation_mode_in_use: s.allocationMode,
        committed_in_current_mode: money(current.committed),
        committed_if_next_receipt_pays_recent_expenses: money(asNext.committed),
        percent_committed_if_next_receipt_pays_recent_expenses: share(asNext.committed),
        available_if_next_receipt_pays_recent_expenses: money(asNext.plannedBalance),
        expenses_counted: asNext.expenses.filter((e) => e.tx.date < next.date).length,
      }, [
        s.allocationMode === 'proximo'
          ? 'Seu modo de alocação é "Próximo recebimento": as despesas feitas antes do recebimento já são atribuídas a ele.'
          : 'Seu modo de alocação é "Automático por data": nele, nada é atribuído ao recebimento futuro. O valor "se o próximo recebimento pagar as despesas recentes" é uma simulação com o modo "Próximo recebimento".',
        'Comprometido = despesas pagas antes do recebimento e alocadas a ele (inclui alocações manuais).',
      ]);
    },
  },

  {
    name: 'get_pending_allocations',
    description: 'Despesas sem alocação válida a um ciclo de recebimento (não entram no saldo de nenhum ciclo).',
    parameters: {
      type: 'object',
      properties: { period: PERIOD_SCHEMA, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 } },
    },
    handler(s, { period, limit }) {
      const r = resolveToolPeriod(s, period);
      const model = getModel(s, { start: r.period.start, end: r.period.end });
      const items = model.pending.filter((p) => p.tx.date >= r.period.start && p.tx.date <= r.period.end)
        .sort((a, b) => b.tx.date.localeCompare(a.tx.date));
      const note = [];
      if (!s.sources.length) note.push('Sem fontes de renda cadastradas, nenhuma despesa consegue ser alocada a um ciclo.');
      if (!r.hasData) note.push(emptyPeriodNote(r));
      return ok({
        period: { label: r.period.label, start: r.period.start, end: r.period.end },
        pending_count: items.length, pending_total: money(items.reduce((sum, p) => sum + Math.abs(p.tx.amount), 0)),
        items: items.slice(0, limit).map((p) => ({
          id: p.tx.id, date: p.tx.date, description: p.tx.originalDescription, amount: money(p.tx.amount), reason: p.reason,
        })),
        no_data_in_period: !r.hasData,
      }, note);
    },
  },
];

export default {
  id: 'ciclos-recebimento',
  name: 'Gestão de ciclos de recebimento',
  description: 'Fontes de renda, próximos recebimentos, ciclos, despesas comprometidas/realizadas, pendências de alocação e valor disponível.',
  tools,
};
