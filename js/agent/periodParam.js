// Parâmetro "período" das ferramentas: o modelo escolhe um nome (ex.: "mes_passado") ou datas;
// o cálculo das datas é sempre feito aqui, em JavaScript (o modelo não calcula datas).
import { resolvePeriod } from '../dashboard/period.js';
import { monthRange, isValidISO } from '../utils/dates.js';
import { monthLabel, formatDate } from '../utils/format.js';
import { ToolError } from './results.js';

export const PERIOD_PRESETS = ['mes_atual', 'mes_anterior', 'ultimos_30', 'ultimos_90', 'ano_atual', 'ultimo_com_dados', 'tudo'];

const DATE = '^\\d{4}-\\d{2}-\\d{2}$';

export const PERIOD_SCHEMA = {
  type: 'object',
  description: 'Período da consulta. Use "preset", OU "month" (AAAA-MM), OU "start" e "end" (AAAA-MM-DD). Padrão: mes_atual.',
  properties: {
    preset: { type: 'string', enum: PERIOD_PRESETS },
    month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
    start: { type: 'string', pattern: DATE },
    end: { type: 'string', pattern: DATE },
  },
};

/** Meses (AAAA-MM) em que há transações, do mais recente para o mais antigo. */
export function monthsWithData(snapshot) {
  return [...new Set(snapshot.transactions.map((t) => t.date.slice(0, 7)))].sort().reverse();
}

/**
 * Converte o parâmetro em datas e separa as transações do período.
 * @returns {{ period:{start,end,label}, rows, hasData, latestMonthWithData }}
 */
export function resolveToolPeriod(snapshot, param) {
  const p = param || {};
  const today = snapshot.today;
  let period;

  if (p.start || p.end) {
    if (!p.start || !p.end) throw new ToolError('invalid_period', 'Informe "start" e "end" juntos.');
    if (!isValidISO(p.start) || !isValidISO(p.end)) throw new ToolError('invalid_period', 'Datas inválidas (use AAAA-MM-DD, datas que existam no calendário).');
    if (p.start > p.end) throw new ToolError('invalid_period', 'A data inicial deve ser anterior à final.');
    period = { start: p.start, end: p.end, label: `${formatDate(p.start)} a ${formatDate(p.end)}` };
  } else if (p.month) {
    const r = monthRange(p.month);
    period = { ...r, label: monthLabel(p.month) };
  } else if (p.preset === 'tudo') {
    const dates = snapshot.transactions.map((t) => t.date).sort();
    period = { start: dates[0] || today, end: dates[dates.length - 1] || today, label: 'Todo o histórico' };
  } else {
    const resolved = resolvePeriod(p.preset || 'mes_atual', { today, transactions: snapshot.transactions });
    period = { start: resolved.start, end: resolved.end, label: resolved.label };
  }

  const rows = snapshot.transactions.filter((t) => t.date >= period.start && t.date <= period.end);
  const latest = monthsWithData(snapshot)[0] || null;
  return {
    period, rows, hasData: rows.length > 0,
    latestMonthWithData: latest ? { month: latest, label: monthLabel(latest) } : null,
  };
}

/** Nota padrão quando o período não tem dados (para o modelo não inventar nada). */
export function emptyPeriodNote(resolved) {
  return `Não há transações em ${resolved.period.label}.${resolved.latestMonthWithData ? ` O mês mais recente com dados é ${resolved.latestMonthWithData.label}.` : ' Ainda não há transações importadas.'}`;
}
