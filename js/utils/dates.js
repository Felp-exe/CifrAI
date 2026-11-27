// Cálculos de datas SEM fuso horário. Todas as datas do app são texto "AAAA-MM-DD".
// (Usar o relógio local com fuso pode "pular" um dia; aqui usamos sempre UTC para evitar isso.)

const pad = (n) => String(n).padStart(2, '0');

export function toISO(year, month, day) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function parseISO(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return { y, m, d };
}

/** O texto é uma data real do calendário? ("2026-02-30" não é.) */
export function isValidISO(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return false;
  const { y, m, d } = parseISO(iso);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Quantos dias o mês tem (mês de 1 a 12). Considera ano bissexto. */
export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Se o mês não tem o dia pedido (ex.: dia 30 em fevereiro), usa o ÚLTIMO dia do mês. */
export function clampDay(year, month, day) {
  return Math.min(day, daysInMonth(year, month));
}

export function addDays(iso, amount) {
  const { y, m, d } = parseISO(iso);
  const date = new Date(Date.UTC(y, m - 1, d + amount));
  return toISO(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** Dia da semana: 0 = domingo ... 6 = sábado. */
export function weekdayOf(iso) {
  const { y, m, d } = parseISO(iso);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function daysBetween(fromIso, toIso) {
  const a = parseISO(fromIso);
  const b = parseISO(toIso);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
}

/** "2026-03" -> { start: "2026-03-01", end: "2026-03-31" } */
export function monthRange(key) {
  const [y, m] = key.split('-').map(Number);
  return { start: toISO(y, m, 1), end: toISO(y, m, daysInMonth(y, m)) };
}

/** Soma (ou subtrai) meses a uma chave "AAAA-MM". */
export function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const index = y * 12 + (m - 1) + delta;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
}

/** Hoje, no calendário local do usuário, como "AAAA-MM-DD". */
export function todayISO(now = new Date()) {
  return toISO(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export const WEEKDAYS = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
