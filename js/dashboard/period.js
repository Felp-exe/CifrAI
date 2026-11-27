// Filtros de período do painel (funções puras: recebem "hoje" como parâmetro, então são testáveis).
import { addDays, monthRange, shiftMonth, isValidISO } from '../utils/dates.js';
import { monthLabel, formatDate } from '../utils/format.js';

export const PRESETS = {
  ultimo_extrato: 'Período do último extrato',
  mes_atual: 'Mês atual',
  mes_anterior: 'Mês anterior',
  ultimos_30: 'Últimos 30 dias',
  ultimos_90: 'Últimos 90 dias',
  ano_atual: 'Ano atual',
  ultimo_com_dados: 'Mês mais recente com dados',
  personalizado: 'Período personalizado',
};

/**
 * Período do último extrato importado. Usa o período lido do cabeçalho do PDF (guardado na importação);
 * se o extrato não informava, usa a primeira e a última data das transações dessa importação.
 * @returns {{ start, end, source: 'cabecalho'|'transacoes' } | null}
 */
export function statementPeriod(imports = [], transactions = []) {
  const latest = [...imports].sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt)))[0];
  if (!latest) return null;
  if (latest.periodStart && latest.periodEnd) return { start: latest.periodStart, end: latest.periodEnd, source: 'cabecalho' };
  const dates = transactions.filter((t) => t.importId === latest.id).map((t) => t.date).sort();
  return dates.length ? { start: dates[0], end: dates[dates.length - 1], source: 'transacoes' } : null;
}

/**
 * Converte um filtro em datas.
 * @returns {{ preset, start, end, label, valid, error? }}
 */
export function resolvePeriod(preset, { today, custom = {}, transactions = [], imports = [] }) {
  const month = today.slice(0, 7);
  const make = (start, end, label) => ({ preset, start, end, label, valid: true });

  switch (preset) {
    case 'ultimo_extrato': {
      const sp = statementPeriod(imports, transactions);
      if (!sp) return resolvePeriod('ultimo_com_dados', { today, custom, transactions, imports });
      return make(sp.start, sp.end, `${formatDate(sp.start)} a ${formatDate(sp.end)}`);
    }
    case 'mes_atual': {
      const r = monthRange(month);
      return make(r.start, r.end, monthLabel(month));
    }
    case 'mes_anterior': {
      const prev = shiftMonth(month, -1);
      const r = monthRange(prev);
      return make(r.start, r.end, monthLabel(prev));
    }
    case 'ultimos_30': return make(addDays(today, -29), today, 'Últimos 30 dias');
    case 'ultimos_90': return make(addDays(today, -89), today, 'Últimos 90 dias');
    case 'ano_atual': return make(`${today.slice(0, 4)}-01-01`, `${today.slice(0, 4)}-12-31`, `Ano de ${today.slice(0, 4)}`);
    case 'ultimo_com_dados': {
      const latest = transactions.map((t) => t.date).sort().pop();
      const m = latest ? latest.slice(0, 7) : month;
      const r = monthRange(m);
      return make(r.start, r.end, monthLabel(m));
    }
    case 'personalizado': {
      if (!isValidISO(custom.start) || !isValidISO(custom.end)) {
        return { preset, start: null, end: null, label: 'Período personalizado', valid: false, error: 'Informe a data inicial e a data final.' };
      }
      if (custom.start > custom.end) {
        return { preset, start: null, end: null, label: 'Período personalizado', valid: false, error: 'A data inicial deve ser anterior à data final.' };
      }
      return make(custom.start, custom.end, `${formatDate(custom.start)} a ${formatDate(custom.end)}`);
    }
    default:
      return resolvePeriod('mes_atual', { today, custom, transactions, imports });
  }
}

/** Filtro inicial: o período do último extrato importado; sem importação, o mês atual (ou o mais recente com dados). */
export function defaultPreset(transactions, today, imports = []) {
  if (statementPeriod(imports, transactions)) return 'ultimo_extrato';
  const month = today.slice(0, 7);
  if (transactions.some((t) => t.date.startsWith(month))) return 'mes_atual';
  return transactions.length ? 'ultimo_com_dados' : 'mes_atual';
}

/**
 * Mês de referência para orçamentos e comparações: o último mês do período que já começou
 * (um período que termina no futuro, como "Ano atual", usa o mês de hoje).
 */
export function referenceMonth(period, today) {
  const end = period.end < today ? period.end : today;
  const month = end.slice(0, 7);
  return month < period.start.slice(0, 7) ? period.start.slice(0, 7) : month;
}
