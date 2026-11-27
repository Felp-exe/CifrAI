// Contadores nas abas (ex.: nº de despesas pendentes de alocação).
import { loadModel } from '../cycles/model.js';

/** Recalcula e atualiza o número ao lado da aba "Pendências" (se ela estiver na tela). */
export async function updatePendingBadge(db) {
  const badge = document.getElementById('pending-count');
  if (!badge) return;
  badge.textContent = String((await loadModel(db)).pending.length);
}
