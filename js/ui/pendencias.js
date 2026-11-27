// Aba "Pendências": despesas que ficaram sem alocação válida a um ciclo.
import { escapeHtml, formatBRL, formatDate } from '../utils/format.js';
import { openAllocationDialog } from './alocacao.js';
// (o contador da aba é atualizado aqui mesmo, logo abaixo)
import { loadModel } from '../cycles/model.js';

export async function render(container, ctx) {
  new PendingView(container, ctx.db).start();
}

class PendingView {
  constructor(container, db) {
    this.container = container;
    this.db = db;
  }

  async start() {
    this.container.addEventListener('click', (e) => this.onClick(e));
    await this.refresh();
  }

  async refresh() {
    this.model = await loadModel(this.db);
    const items = this.model.pending.slice().sort((a, b) => b.tx.date.localeCompare(a.tx.date));
    const badge = document.getElementById('pending-count');
    if (badge) badge.textContent = String(items.length);

    this.container.innerHTML = items.length === 0
      ? `<section class="card empty"><h2>Nenhuma pendência de alocação 🎉</h2>
          <p>Todas as despesas estão ligadas a algum ciclo de recebimento${this.model.sources.length ? '' : ' (ou ainda não há despesas ou fontes de renda cadastradas)'}.</p></section>`
      : `<p class="muted">${items.length} despesa(s) sem ciclo. Elas <strong>não entram</strong> no saldo de nenhum ciclo até serem alocadas.</p>
        <section class="card table-card">
          <table class="review-table tx-table">
            <thead><tr><th>Data</th><th>Descrição</th><th class="num">Valor</th><th>Motivo</th><th></th></tr></thead>
            <tbody>${items.map(({ tx, reason }) => `<tr data-id="${tx.id}">
              <td data-label="Data">${formatDate(tx.date)}</td>
              <td data-label="Descrição" class="desc"><strong>${escapeHtml(tx.originalDescription)}</strong></td>
              <td data-label="Valor" class="num ${tx.amount < 0 ? 'neg' : 'pos'}">${formatBRL(tx.amount)}</td>
              <td data-label="Motivo" class="status"><span class="micro">${escapeHtml(reason)}</span></td>
              <td data-label="Ação">${tx.amount < 0 ? '<button class="btn small primary" data-act="allocate" type="button">Alocar…</button>' : ''}</td>
            </tr>`).join('')}</tbody>
          </table>
        </section>`;
  }

  async onClick(e) {
    const btn = e.target.closest('[data-act="allocate"]');
    if (!btn) return;
    const tx = this.model.transactions.find((t) => t.id === Number(btn.closest('tr').dataset.id));
    if (await openAllocationDialog({ db: this.db, model: this.model, tx })) await this.refresh();
  }
}
