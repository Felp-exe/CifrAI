// Funções de formatação: dinheiro (R$), datas e texto.
// Decisão técnica: valores em dinheiro são guardados em CENTAVOS (números inteiros).
// Motivo: computadores erram contas com decimais (0,1 + 0,2 = 0,30000000000000004).
// Com centavos inteiros, as somas ficam sempre exatas.

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/** Converte reais (ex.: 12.34) em centavos inteiros (1234). */
export function toCents(reais) {
  return Math.round(Number(reais) * 100);
}

/** Converte centavos (1234) em reais (12.34). */
export function fromCents(cents) {
  return Number(cents) / 100;
}

/** Formata centavos como moeda brasileira: 123456 -> "R$ 1.234,56". */
export function formatBRL(cents) {
  return brl.format(fromCents(cents)).replace(/ /g, ' ');
}

/** Formata data ISO "2026-03-05" como "05/03/2026" (sem mexer em fuso horário). */
export function formatDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** Retorna "2026-03" a partir de "2026-03-05". */
export function monthKey(iso) {
  return String(iso).slice(0, 7);
}

/** Mês atual no formato "2026-03". */
export function currentMonthKey(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/** "2026-03" -> "março de 2026". */
export function monthLabel(key) {
  const [y, m] = key.split('-');
  return `${MESES[Number(m) - 1]} de ${y}`;
}

/** Evita que texto vindo de PDF/usuário seja interpretado como HTML. */
export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Normaliza texto para comparação: minúsculas, sem acentos, sem símbolos extras. */
export function normalizeText(text) {
  return String(text ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
