// Pequenos blocos de interface reutilizados por várias telas.
import { escapeHtml } from '../utils/format.js';

export function pageHeader(title, subtitle) {
  return `<header class="page-header"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></header>`;
}

/** Navegação por mês (‹ mês ›). Os botões têm data-month="prev|next|latest". */
export function monthNavHtml(label) {
  return `<div class="month-nav" role="group" aria-label="Escolher mês">
    <button class="btn small" type="button" data-month="prev" aria-label="Mês anterior">‹</button>
    <strong aria-live="polite">${escapeHtml(label.charAt(0).toUpperCase() + label.slice(1))}</strong>
    <button class="btn small" type="button" data-month="next" aria-label="Próximo mês">›</button>
    <button class="btn small" type="button" data-month="latest">Mês mais recente</button>
  </div>`;
}

/** Cartão de indicador (ex.: Entradas, Saídas). */
export function statCard({ label, value, hint = '', tone = '' }) {
  return `<article class="card stat ${tone}">
    <span class="stat-label">${escapeHtml(label)}</span>
    <strong class="stat-value">${escapeHtml(value)}</strong>
    <span class="stat-hint">${escapeHtml(hint)}</span>
  </article>`;
}
