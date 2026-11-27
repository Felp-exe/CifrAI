// Tela "Ciclos de recebimento": ciclos do mês, rendas e pendências de alocação (em abas).
import { pageHeader, statCard, monthNavHtml } from './components.js';
import * as rendas from './rendas.js';
import * as pendencias from './pendencias.js';
import { openAllocationDialog } from './alocacao.js';
import { escapeHtml, formatBRL, formatDate, monthLabel } from '../utils/format.js';
import { shiftMonth, daysBetween } from '../utils/dates.js';
import { MODES } from '../cycles/allocation.js';
import { STATUS_LABEL } from '../cycles/summary.js';
import { loadModel, defaultMonth } from '../cycles/model.js';
import { getMode, setMode, linkReceipt, clearReceiptLink } from '../cycles/allocationService.js';
import { listCategories } from '../categorization/categoryService.js';

const TABS = [
  { id: '', label: 'Ciclos' },
  { id: 'rendas', label: 'Rendas' },
  { id: 'pendencias', label: 'Pendências' },
];

const state = { month: null };

export async function render(container, ctx) {
  const sub = TABS.some((t) => t.id === ctx.sub) ? ctx.sub : '';
  const model = await loadModel(ctx.db);
  const mode = await getMode(ctx.db);

  container.innerHTML = `
    ${pageHeader('Ciclos de recebimento', 'Cada recebimento abre um ciclo. Veja entradas, despesas e saldo de cada um')}
    <nav class="tabs" aria-label="Seções de ciclos">
      ${TABS.map((t) => `<a class="tab ${t.id === sub ? 'active' : ''}" href="#/ciclos${t.id ? '/' + t.id : ''}" ${t.id === sub ? 'aria-current="page"' : ''}>
        ${t.label}${t.id === 'pendencias' ? ` <span class="count" id="pending-count">${model.pending.length}</span>` : ''}</a>`).join('')}
    </nav>
    ${sub === 'rendas' ? '' : `
    <fieldset class="mode-box">
      <legend>Como alocar despesas automaticamente</legend>
      ${Object.entries(MODES).map(([value, label]) => `<label class="check"><input type="radio" name="mode" value="${value}" ${mode === value ? 'checked' : ''}> <span>${label}${value === 'auto'
        ? ' <small>(o recebimento mais recente antes da despesa)</small>' : ' <small>(o próximo recebimento depois da despesa)</small>'}</span></label>`).join('')}
      <p class="micro">Você sempre pode alocar uma despesa manualmente (inclusive dividindo entre ciclos); isso vale mais que o modo automático.</p>
    </fieldset>`}
    <div id="tab-content"></div>`;

  container.querySelector('input[name="mode"]')?.closest('fieldset').addEventListener('change', async (e) => {
    await setMode(ctx.db, e.target.value);
    render(container, ctx);
  });

  const content = container.querySelector('#tab-content');
  if (sub === 'rendas') return rendas.render(content, ctx);
  if (sub === 'pendencias') return pendencias.render(content, ctx);
  return new CyclesView(content, ctx.db).start();
}

class CyclesView {
  constructor(container, db) {
    this.container = container;
    this.db = db;
    this.message = '';
  }

  async start() {
    this.categories = new Map((await listCategories(this.db)).map((c) => [c.id, c]));
    this.container.addEventListener('click', (e) => this.onClick(e));
    this.container.addEventListener('change', (e) => this.onChange(e));
    await this.refresh();
  }

  async refresh() {
    const txs = await this.db.getAll('transactions');
    if (!state.month) state.month = defaultMonth(txs);
    this.model = await loadModel(this.db, { focusMonth: state.month });
    this.draw();
    const badge = document.getElementById('pending-count');
    if (badge) badge.textContent = String(this.model.pending.length);
  }

  monthCycles() {
    return this.model.summaries.filter((s) => s.cycle.date.startsWith(state.month));
  }

  draw() {
    const { model } = this;
    const list = this.monthCycles();
    const sum = (key) => list.reduce((s, c) => s + c[key], 0);
    const open = new Set([...this.container.querySelectorAll('details.cycle[open]')].map((d) => d.dataset.id));

    this.container.innerHTML = `
      ${monthNavHtml(monthLabel(state.month))}
      <div id="msg" class="toast" role="status" aria-live="polite">${escapeHtml(this.message)}</div>

      ${model.sources.length === 0 ? `<section class="card empty"><h2>Cadastre sua primeira fonte de renda</h2>
        <p>Os ciclos nascem dos seus recebimentos (salário, adiantamento, renda extra...).</p>
        <div class="action-buttons center"><a class="btn primary" href="#/ciclos/rendas">Cadastrar renda</a></div></section>` : `
      <section class="grid stats">
        ${statCard({ label: 'Receita prevista', value: formatBRL(sum('expected')), hint: `${list.length} ciclo(s) neste mês` })}
        ${statCard({ label: 'Receita recebida', value: formatBRL(sum('received')), hint: 'entradas ligadas aos ciclos', tone: 'positive' })}
        ${statCard({ label: 'Despesas alocadas', value: formatBRL(sum('allocated')), hint: 'nos ciclos deste mês', tone: 'negative' })}
        ${statCard({ label: 'Saldo planejado', value: formatBRL(sum('plannedBalance')), hint: 'previsto − despesas', tone: sum('plannedBalance') < 0 ? 'negative' : '' })}
      </section>
      <p class="micro note">O saldo dos ciclos <strong>não é o saldo da sua conta bancária</strong>: ele só considera os recebimentos e despesas ligados a cada ciclo.</p>

      ${list.length === 0 ? '<section class="card empty"><h2>Nenhum recebimento neste mês</h2><p>Use as setas para ver outros meses.</p></section>'
        : `<section class="cycle-list">${list.map((s) => this.cycleHtml(s, open)).join('')}</section>`}
      ${this.unlinkedHtml()}`}`;
  }

  cycleHtml(s, open) {
    const { cycle } = s;
    const catChip = (tx) => {
      const c = this.categories.get(tx.categoryId);
      return c ? `<span class="cell-inline"><span class="cat-dot" style="background:${escapeHtml(c.cor)}"></span>${escapeHtml(c.nome)}</span>` : '<span class="muted">sem categoria</span>';
    };
    const modeLabel = { manual: 'Manual', auto: 'Automático', proximo: 'Próximo recebimento' };
    return `<details class="card cycle status-${s.status}" data-id="${escapeHtml(cycle.id)}" ${open.has(cycle.id) ? 'open' : ''}>
      <summary>
        <span class="cycle-title"><strong>${escapeHtml(cycle.name)}</strong> · ${formatDate(cycle.date)}</span>
        <span class="level-badge status-${s.status}">${STATUS_LABEL[s.status]}</span>
        <span class="cycle-balance ${s.realBalance < 0 ? 'neg' : ''}">Saldo planejado <strong>${formatBRL(s.plannedBalance)}</strong></span>
      </summary>

      <div class="budget-numbers six">
        <div><span>Previsto</span><strong>${formatBRL(s.expected)}</strong></div>
        <div><span>Recebido</span><strong>${formatBRL(s.received)}</strong></div>
        <div><span>Despesas comprometidas</span><strong>${formatBRL(s.committed)}</strong></div>
        <div><span>Despesas realizadas</span><strong>${formatBRL(s.realized)}</strong></div>
        <div><span>Saldo planejado</span><strong class="${s.plannedBalance < 0 ? 'neg' : ''}">${formatBRL(s.plannedBalance)}</strong></div>
        <div><span>Saldo real</span><strong class="${s.realBalance < 0 ? 'neg' : ''}">${formatBRL(s.realBalance)}</strong></div>
      </div>
      <p class="micro"><b>Realizadas</b> = pagas depois do recebimento. <b>Comprometidas</b> = pagas antes, contando com este recebimento.
        <b>Saldo planejado</b> = previsto − despesas. <b>Saldo real</b> = recebido − despesas.</p>

      <h2 class="cycle-sub">Recebimentos identificados</h2>
      ${s.receipts.length === 0 ? '<p class="muted">Nenhuma entrada do extrato foi ligada a este ciclo ainda.</p>'
        : `<ul class="plain-list">${s.receipts.map((r) => `<li data-tx="${r.tx.id}">
            ${formatDate(r.tx.date)} · ${escapeHtml(r.tx.originalDescription)} · <strong class="pos">${formatBRL(r.tx.amount)}</strong>
            <span class="micro">(${r.origin === 'auto' ? 'ligado automaticamente' : 'ligado por você'})</span>
            <button class="btn small" data-act="unlink" type="button">Desvincular</button>
            ${r.origin === 'manual' ? '<button class="btn small" data-act="auto-link" type="button">Voltar ao automático</button>' : ''}
          </li>`).join('')}</ul>`}

      <h2 class="cycle-sub">Despesas alocadas (${s.expenses.length})</h2>
      ${s.expenses.length === 0 ? '<p class="muted">Nenhuma despesa alocada a este ciclo.</p>' : `
      <div class="table-card"><table class="review-table tx-table">
        <thead><tr><th>Data</th><th>Descrição</th><th>Categoria</th><th class="num">Parte neste ciclo</th><th>Alocação</th><th></th></tr></thead>
        <tbody>${s.expenses.map((x) => `<tr data-tx="${x.tx.id}">
          <td data-label="Data">${formatDate(x.tx.date)}</td>
          <td data-label="Descrição" class="desc"><strong>${escapeHtml(x.tx.originalDescription)}</strong></td>
          <td data-label="Categoria">${catChip(x.tx)}</td>
          <td data-label="Parte" class="num ${x.amount < 0 ? 'pos' : 'neg'}">${formatBRL(Math.abs(x.amount))}${x.amount < 0 ? ' <span class="micro">(estorno)</span>' : ''}
            ${Math.abs(x.amount) !== Math.abs(x.tx.amount) ? `<div class="micro">de ${formatBRL(Math.abs(x.tx.amount))}</div>` : ''}</td>
          <td data-label="Alocação"><span class="badge ${x.mode === 'manual' ? '' : 'warn'}">${modeLabel[x.mode]}</span></td>
          <td data-label="Ação">${x.tx.amount < 0 ? '<button class="btn small" data-act="allocate" type="button">Alterar</button>' : ''}</td>
        </tr>`).join('')}</tbody></table></div>`}
    </details>`;
  }

  /** Entradas do mês que não estão ligadas a nenhum ciclo. */
  unlinkedHtml() {
    const items = this.model.receipts.unlinked.filter((t) => t.date.startsWith(state.month));
    if (!items.length) return '';
    return `<section class="card">
      <h2>Entradas sem ciclo (${items.length})</h2>
      <p class="muted">Dinheiro que entrou neste mês e não foi ligado a nenhum recebimento previsto. Se for um dos seus recebimentos, escolha o ciclo.</p>
      <ul class="plain-list">${items.map((t) => {
        const options = this.model.cycles.filter((c) => Math.abs(daysBetween(t.date, c.date)) <= 45);
        return `<li data-tx="${t.id}">${formatDate(t.date)} · ${escapeHtml(t.originalDescription)} · <strong class="pos">${formatBRL(t.amount)}</strong>
          <select data-act="link" aria-label="Ligar esta entrada a um ciclo">
            <option value="">Ligar ao ciclo…</option>
            ${options.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)} · ${formatDate(c.date)}</option>`).join('')}</select></li>`;
      }).join('')}</ul></section>`;
  }

  say(text) { this.message = text; const el = this.container.querySelector('#msg'); if (el) el.textContent = text; }

  async onChange(e) {
    if (e.target.dataset.act !== 'link' || !e.target.value) return;
    const txId = Number(e.target.closest('li').dataset.tx);
    try {
      await linkReceipt(this.db, txId, e.target.value);
      this.message = 'Entrada ligada ao ciclo.';
      await this.refresh();
    } catch (error) { this.say(`Erro: ${error.message}`); }
  }

  async onClick(e) {
    const nav = e.target.closest('[data-month]');
    if (nav) {
      const kind = nav.dataset.month;
      if (kind === 'latest') state.month = defaultMonth(await this.db.getAll('transactions'));
      else state.month = shiftMonth(state.month, kind === 'prev' ? -1 : 1);
      this.message = '';
      return this.refresh();
    }
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const txId = Number(btn.closest('[data-tx]')?.dataset.tx);
    try {
      if (btn.dataset.act === 'allocate') {
        const tx = this.model.transactions.find((t) => t.id === txId);
        if (await openAllocationDialog({ db: this.db, model: this.model, tx })) { this.message = 'Alocação atualizada.'; await this.refresh(); }
      } else if (btn.dataset.act === 'unlink') {
        await linkReceipt(this.db, txId, null);
        this.message = 'Entrada desvinculada do ciclo.';
        await this.refresh();
      } else if (btn.dataset.act === 'auto-link') {
        await clearReceiptLink(this.db, txId);
        this.message = 'Vínculo manual removido: voltou à sugestão automática.';
        await this.refresh();
      }
    } catch (error) { this.say(`Erro: ${error.message}`); }
  }
}
