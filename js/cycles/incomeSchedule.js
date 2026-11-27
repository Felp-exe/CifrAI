// Fontes de renda e as DATAS em que cada uma paga.
//
// Frequências:
//  - mensal:    uma vez por mês, no dia escolhido (1 a 31).
//  - quinzenal: DUAS vezes por mês: no dia escolhido e 15 dias depois (ou 15 antes, se o dia for > 15).
//               Ex.: dia 15 -> dias 15 e 30; dia 5 -> dias 5 e 20; dia 20 -> dias 5 e 20.
//  - semanal:   toda semana, no dia da semana escolhido (domingo a sábado).
//  - unica:     uma data específica, uma só vez.
// Regra do fim de mês: se o mês não tem o dia (ex.: dia 30 em fevereiro), vale o ÚLTIMO dia do mês.
import {
  toISO, parseISO, clampDay, addDays, weekdayOf, isValidISO, WEEKDAYS,
} from '../utils/dates.js';
import { formatDate } from '../utils/format.js';

/** Texto curto que descreve quando a fonte paga (ex.: "Mensal, todo dia 15"). */
export function describeSource(s) {
  if (s.frequency === 'mensal') return `Mensal, todo dia ${s.day}`;
  if (s.frequency === 'quinzenal') return `Quinzenal: dias ${s.day} e ${s.day <= 15 ? s.day + 15 : s.day - 15}`;
  if (s.frequency === 'semanal') return `Semanal, toda ${WEEKDAYS[s.weekday].toLowerCase()}`;
  return `Única, em ${formatDate(s.date)}`;
}

export const FREQUENCIES = {
  mensal: 'Mensal',
  quinzenal: 'Quinzenal (2 vezes por mês)',
  semanal: 'Semanal',
  unica: 'Única',
};

/** Valida e normaliza os dados de uma fonte. Lança Error com mensagem clara se algo estiver errado. */
export function validateSource(input) {
  const name = String(input.name ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('Digite o nome da fonte de renda.');
  if (name.length > 40) throw new Error('O nome pode ter no máximo 40 caracteres.');

  if (!Number.isInteger(input.amount) || input.amount <= 0) throw new Error('Informe um valor esperado maior que zero.');
  if (!(input.frequency in FREQUENCIES)) throw new Error('Escolha uma frequência válida.');

  const source = { name, amount: input.amount, frequency: input.frequency, startDate: null, endDate: null };

  if (input.frequency === 'mensal' || input.frequency === 'quinzenal') {
    const day = Number(input.day);
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error('O dia do recebimento deve estar entre 1 e 31.');
    source.day = day;
  } else if (input.frequency === 'semanal') {
    const weekday = Number(input.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new Error('Escolha o dia da semana.');
    source.weekday = weekday;
  } else if (!isValidISO(input.date)) {
    throw new Error('Informe a data do recebimento único.');
  } else {
    source.date = input.date;
  }

  for (const field of ['startDate', 'endDate']) {
    if (input[field]) {
      if (!isValidISO(input[field])) throw new Error('Data de início/fim inválida.');
      source[field] = input[field];
    }
  }
  if (source.startDate && source.endDate && source.startDate > source.endDate) {
    throw new Error('A data de início deve ser anterior à data final.');
  }
  return source;
}

/** Datas de recebimento da fonte entre `from` e `to` (inclusive), em ordem. */
export function occurrences(source, from, to) {
  const dates = new Set();

  if (source.frequency === 'unica') {
    if (source.date >= from && source.date <= to) dates.add(source.date);
  } else if (source.frequency === 'semanal') {
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (weekdayOf(d) === source.weekday) dates.add(d);
    }
  } else {
    const days = source.frequency === 'quinzenal'
      ? [source.day, source.day <= 15 ? source.day + 15 : source.day - 15]
      : [source.day];
    const start = parseISO(from);
    const end = parseISO(to);
    for (let index = start.y * 12 + start.m - 1; index <= end.y * 12 + end.m - 1; index++) {
      const year = Math.floor(index / 12);
      const month = (index % 12) + 1;
      for (const day of days) {
        const iso = toISO(year, month, clampDay(year, month, day));
        if (iso >= from && iso <= to) dates.add(iso);
      }
    }
  }

  return [...dates]
    .filter((d) => (!source.startDate || d >= source.startDate) && (!source.endDate || d <= source.endDate))
    .sort();
}
