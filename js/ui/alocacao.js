// Janela para alocar (ou dividir) uma despesa entre ciclos de recebimento.
import { escapeHtml, formatBRL, formatDate } from '../utils/format.js';
import { daysBetween } from '../utils/dates.js';
import { parseAmountInput } from '../utils/money.js';
import { saveManualAllocation, clearManualAllocation } from '../cycles/allocationService.js';

const inputFromCents = (cents) => (cents / 100).toFixed(2).replace('.', ',');

/**
 * Abre a janela de alocação. Resolve true se algo foi salvo/alterado, false se cancelou.
 * @param model resultado de loadModel()
 */
export function openAllocationDialog({ db, model, tx }) {
  return new Promise((resolve) => {
    const total = Math.abs(tx.amount);
    const options = model.cycles.filter((c) => Math.abs(daysBetween(tx.date, c.date)) <= 100);
    const current = model.allocations.byTransaction.get(tx.id);
    const isManual = current?.mode === 'manual';
    const initialParts = current ? current.parts : [{ cycleId: options[0]?.id, amount: total }];

    const dialog = document.createElement('dialog');
    dialog.className = 'dialog wide-dialog';
    dialog.innerHTML = `
      <form method="dialog" novalidate>
        <h2>Alocar despesa a ciclos</h2>
        <p><strong>${escapeHtml(tx.originalDescription)}</strong><br>
          ${formatDate(tx.date)} · <strong>${formatBRL(total)}</strong></p>
        ${options.length === 0 ? '<p class="w bloqueio">Não há ciclos de recebimento próximos da data desta despesa. Cadastre uma fonte de renda na aba Rendas.</p>' : `
        <p class="muted">Escolha o ciclo que paga esta despesa. Para dividir (ex.: aluguel R$ 600 + R$ 400), adicione mais um ciclo.
        A soma precisa ser <strong>exatamente</strong> ${formatBRL(total)}.</p>
        <div id="alloc-rows" class="alloc-rows"></div>
        <button class="btn small" type="button" id="add-row">+ Dividir em mais um ciclo</button>
        <p id="alloc-sum" class="alloc-sum" aria-live="polite"></p>`}
        <p id="alloc-error" class="w bloqueio" role="alert" hidden></p>
        <div class="action-buttons end">
          ${isManual ? '<button class="btn" type="button" id="to-auto">Voltar ao automático</button>' : ''}
          <button class="btn" type="submit" value="cancel" formnovalidate>Cancelar</button>
          ${options.length ? '<button class="btn primary" type="button" id="save">Salvar alocação</button>' : ''}
        </div>
      </form>`;
    document.body.appendChild(dialog);

    const rowsEl = dialog.querySelector('#alloc-rows');
    const errorEl = dialog.querySelector('#alloc-error');
    let changed = false;

    const optionHtml = (selected) => options.map((c) =>
      `<option value="${escapeHtml(c.id)}" ${c.id === selected ? 'selected' : ''}>${escapeHtml(c.name)} · ${formatDate(c.date)} · ${formatBRL(c.expected)}</option>`).join('');

    const addRow = (cycleId, cents) => {
      const row = document.createElement('div');
      row.className = 'alloc-row';
      row.innerHTML = `<select aria-label="Ciclo">${optionHtml(cycleId)}</select>
        <input type="text" inputmode="decimal" aria-label="Valor desta parte em reais" value="${cents ? inputFromCents(cents) : ''}">
        <button class="btn small danger-outline" type="button" data-remove aria-label="Remover esta parte">×</button>`;
      rowsEl.appendChild(row);
    };
    const readParts = () => [...rowsEl.querySelectorAll('.alloc-row')].map((row) => ({
      cycleId: row.querySelector('select').value,
      amount: parseAmountInput(row.querySelector('input').value),
    }));
    const updateSum = () => {
      const parts = readParts();
      const sum = parts.reduce((s, p) => s + (p.amount || 0), 0);
      const diff = total - sum;
      const el = dialog.querySelector('#alloc-sum');
      if (!el) return;
      el.className = `alloc-sum ${diff === 0 ? 'ok' : 'off'}`;
      el.textContent = diff === 0 ? `Soma: ${formatBRL(sum)} ✓ fecha com o valor da despesa`
        : diff > 0 ? `Soma: ${formatBRL(sum)} · faltam ${formatBRL(diff)}` : `Soma: ${formatBRL(sum)} · passou ${formatBRL(-diff)}`;
    };

    if (options.length) {
      for (const p of initialParts) addRow(options.some((c) => c.id === p.cycleId) ? p.cycleId : options[0].id, p.amount);
      updateSum();
    }

    dialog.addEventListener('input', updateSum);
    dialog.addEventListener('change', updateSum);
    dialog.addEventListener('click', async (e) => {
      if (e.target.closest('#add-row')) {
        const parts = readParts();
        const rest = total - parts.reduce((s, p) => s + (p.amount || 0), 0);
        // sugere o ciclo mais próximo da data da despesa que ainda não foi usado
        const unused = options.filter((c) => !parts.some((p) => p.cycleId === c.id));
        const nearest = (unused.length ? unused : options)
          .slice().sort((a, b) => Math.abs(daysBetween(tx.date, a.date)) - Math.abs(daysBetween(tx.date, b.date)))[0];
        addRow(nearest.id, rest > 0 ? rest : 0);
        updateSum();
      }
      if (e.target.closest('[data-remove]')) {
        if (rowsEl.children.length > 1) e.target.closest('.alloc-row').remove();
        updateSum();
      }
      if (e.target.closest('#save')) {
        try {
          const parts = readParts();
          if (parts.some((p) => !p.amount)) throw new Error('Preencha o valor de cada parte (use vírgula, ex.: 600,00).');
          await saveManualAllocation(db, tx.id, parts);
          changed = true;
          dialog.close('saved');
        } catch (error) {
          errorEl.textContent = error.message;
          errorEl.hidden = false;
        }
      }
      if (e.target.closest('#to-auto')) {
        await clearManualAllocation(db, tx.id);
        changed = true;
        dialog.close('auto');
      }
    });
    dialog.addEventListener('close', () => { dialog.remove(); resolve(changed); });
    dialog.showModal();
  });
}
