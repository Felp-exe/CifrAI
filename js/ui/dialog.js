// Janelas de confirmação (elemento <dialog> do navegador, acessível por teclado).
import { escapeHtml } from '../utils/format.js';

/**
 * Mostra uma janela com um formulário. Resolve com os valores (objeto) ou null se cancelar.
 * @param bodyHtml campos do formulário (inputs/selects com atributo name)
 */
export function showDialog({ title, bodyHtml = '', confirmLabel = 'Confirmar', danger = false }) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'dialog';
    dialog.innerHTML = `
      <form method="dialog">
        <h2>${escapeHtml(title)}</h2>
        <div class="dialog-body">${bodyHtml}</div>
        <div class="action-buttons end">
          <button class="btn" value="cancel" type="submit" formnovalidate>Cancelar</button>
          <button class="btn ${danger ? 'danger' : 'primary'}" value="ok" type="submit">${escapeHtml(confirmLabel)}</button>
        </div>
      </form>`;
    document.body.appendChild(dialog);
    dialog.addEventListener('close', () => {
      const ok = dialog.returnValue === 'ok';
      const values = ok ? Object.fromEntries(new FormData(dialog.querySelector('form'))) : null;
      dialog.remove();
      resolve(values);
    });
    dialog.showModal();
  });
}
