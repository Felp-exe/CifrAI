// Tela "Transações": lista, revisão de pendentes, regras e categorias (em abas).
import { pageHeader } from './components.js';
import * as regras from './regras.js';
import * as categorias from './categorias.js';
import { askNewCategory, NEW_CATEGORY_OPTION, NEW_CATEGORY_VALUE } from './categorias.js';
import { escapeHtml, formatBRL, formatDate } from '../utils/format.js';
import { listCategories } from '../categorization/categoryService.js';
import {
  setCategory, confirmSuggestions, resetToAutomatic, filterTransactions,
} from '../categorization/transactionService.js';
import { getSetting, setSetting } from '../storage.js';

const TABS = [
  { id: '', label: 'Todas' },
  { id: 'revisao', label: 'Revisão' },
  { id: 'regras', label: 'Regras' },
  { id: 'categorias', label: 'Categorias' },
];

const SOURCE_LABEL = {
  regra_usuario: 'Sua regra', regra_inicial: 'Regra inicial', manual: 'Corrigida por você',
  desconhecido: 'Automático', entrada: 'Entrada',
};
const CONFIDENCE_LABEL = { alta: 'Confiança alta', media: 'Confiança média', baixa: 'Confiança baixa' };
const PAGE_SIZE = 100;

// Os filtros ficam guardados enquanto você navega pelo app.
const filters = { search: '', category: 'todas', status: 'todas' };

export async function render(container, ctx) {
  const sub = TABS.some((t) => t.id === ctx.sub) ? ctx.sub : '';
  const pending = (await ctx.db.getAll('transactions')).filter((t) => t.status === 'pendente').length;

  container.innerHTML = `
    ${pageHeader('Transações', 'Veja, revise e organize suas movimentações por categoria')}
    <nav class="tabs" aria-label="Seções de transações">
      ${TABS.map((t) => `<a class="tab ${t.id === sub ? 'active' : ''}" href="#/transacoes${t.id ? '/' + t.id : ''}" ${t.id === sub ? 'aria-current="page"' : ''}>
        ${t.label}${t.id === 'revisao' ? ` <span class="count" id="review-count">${pending}</span>` : ''}</a>`).join('')}
    </nav>
    <div id="tab-content"></div>`;

  const content = container.querySelector('#tab-content');
  if (sub === 'regras') return regras.render(content, ctx);
  if (sub === 'categorias') return categorias.render(content, ctx);
  const list = new TransactionList(content, ctx, sub === 'revisao' ? 'revisao' : 'todas');
  return list.start();
}

class TransactionList {
  constructor(container, ctx, mode) {
    this.container = container;
    this.db = ctx.db;
    this.mode = mode;
    this.selected = new Set();
    this.limit = PAGE_SIZE;
    this.message = '';
    this.txs = [];
    this.categories = [];
  }

  async start() {
    await this.reload();
    this.container.innerHTML = `
      <section class="card toolbar">
        <label class="field grow"><span>Buscar</span>
          <input type="search" id="f-search" placeholder="Estabelecimento ou descrição" value="${escapeHtml(filters.search)}"></label>
        <label class="field"><span>Categoria</span><select id="f-category">${this.categoryFilterOptions()}</select></label>
        ${this.mode === 'revisao' ? '' : `<label class="field"><span>Situação</span><select id="f-status">
          ${[['todas', 'Todas'], ['pendente', 'Pendentes de revisão'], ['classificada', 'Classificadas'], ['manual', 'Corrigidas por você']]
            .map(([v, l]) => `<option value="${v}" ${filters.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`}
        <label class="check"><input type="checkbox" id="f-remember" ${getSetting('rememberCorrections') ? 'checked' : ''}>
          <span>Lembrar minhas correções <small>(cria uma regra para o estabelecimento)</small></span></label>
      </section>
      <div id="msg" class="toast" role="status" aria-live="polite"></div>
      <div id="list-area"></div>`;
    this.bind();
    this.draw();
  }

  async reload() {
    const [txs, categories] = await Promise.all([this.db.getAll('transactions'), listCategories(this.db)]);
    this.txs = txs.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
    this.categories = categories;
    this.catById = new Map(categories.map((c) => [c.id, c]));
    const badge = document.getElementById('review-count');
    if (badge) badge.textContent = String(txs.filter((t) => t.status === 'pendente').length);
  }

  categoryFilterOptions() {
    const opts = [['todas', 'Todas as categorias'], ['__sem', 'Sem categoria'], ...this.categories.map((c) => [c.id, c.nome])];
    return opts.map(([v, l]) => `<option value="${escapeHtml(v)}" ${filters.category === v ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('');
  }

  visible() {
    const status = this.mode === 'revisao' ? 'pendente' : filters.status;
    return filterTransactions(this.txs, { search: filters.search, category: filters.category, status });
  }

  bind() {
    let timer;
    this.container.querySelector('#f-search').addEventListener('input', (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => { filters.search = e.target.value; this.limit = PAGE_SIZE; this.draw(); }, 150);
    });
    this.container.querySelector('#f-category').addEventListener('change', (e) => { filters.category = e.target.value; this.limit = PAGE_SIZE; this.draw(); });
    this.container.querySelector('#f-status')?.addEventListener('change', (e) => { filters.status = e.target.value; this.limit = PAGE_SIZE; this.draw(); });
    this.container.querySelector('#f-remember').addEventListener('change', (e) => setSetting('rememberCorrections', e.target.checked));

    const area = this.container.querySelector('#list-area');
    area.addEventListener('change', (e) => this.onChange(e));
    area.addEventListener('click', (e) => this.onClick(e));
  }

  get remember() { return this.container.querySelector('#f-remember').checked; }

  say(text) {
    this.message = text;
    const el = this.container.querySelector('#msg');
    if (el) el.textContent = text;
  }

  // ------------------------------------------------------------------ desenho
  draw() {
    const area = this.container.querySelector('#list-area');
    const rows = this.visible();
    const shown = rows.slice(0, this.limit);
    const allSelected = rows.length > 0 && rows.every((t) => this.selected.has(t.id));
    const selectedCount = [...this.selected].filter((id) => this.txs.some((t) => t.id === id)).length;

    if (this.txs.length === 0) {
      area.innerHTML = `<section class="card empty"><h2>Nenhuma transação ainda</h2>
        <p>Importe um extrato em PDF para começar.</p>
        <div class="action-buttons center"><a class="btn primary" href="#/importar">Importar extrato</a></div></section>`;
      return;
    }
    if (rows.length === 0) {
      // Os filtros (busca/categoria/situação) ficam guardados entre as abas: se eles escondem tudo,
      // a tela precisa dizer isso (e não "nada para revisar") e oferecer uma saída.
      const filtering = Boolean(filters.search) || filters.category !== 'todas' || (this.mode !== 'revisao' && filters.status !== 'todas');
      const pendingTotal = this.txs.filter((t) => t.status === 'pendente').length;
      const clear = '<div class="action-buttons center"><button class="btn primary" type="button" data-act="clear-filters">Limpar filtros</button></div>';
      let title; let text; let extra = '';
      if (this.mode === 'revisao' && pendingTotal === 0) {
        title = 'Nada para revisar 🎉';
        text = 'Todas as transações já estão classificadas ou confirmadas.';
      } else if (this.mode === 'revisao') {
        title = 'Nenhuma pendência com estes filtros';
        text = `Há ${pendingTotal} transaç${pendingTotal === 1 ? 'ão pendente' : 'ões pendentes'} de revisão, mas nenhuma combina com a busca ou a categoria escolhida.`;
        extra = clear;
      } else {
        title = 'Nenhuma transação encontrada';
        text = 'Tente mudar a busca ou os filtros.';
        if (filtering) extra = clear;
      }
      area.innerHTML = `<section class="card empty"><h2>${title}</h2><p>${text}</p>${extra}</section>`;
      return;
    }

    area.innerHTML = `
      <p class="muted count-line">${rows.length} transaç${rows.length === 1 ? 'ão' : 'ões'}${rows.length > shown.length ? ` (mostrando ${shown.length})` : ''}</p>
      <section class="card table-card">
        <table class="review-table tx-table">
          <thead><tr>
            <th><input type="checkbox" id="select-all" aria-label="Selecionar todas as ${rows.length} transações filtradas" ${allSelected ? 'checked' : ''}></th>
            <th>Data</th><th>Descrição</th><th class="num">Valor</th><th>Categoria</th><th>Classificação</th></tr></thead>
          <tbody>${shown.map((t) => this.rowHtml(t)).join('')}</tbody>
        </table>
      </section>
      ${rows.length > shown.length ? `<div class="action-buttons center"><button class="btn" data-act="more" type="button">Mostrar mais ${Math.min(PAGE_SIZE, rows.length - shown.length)}</button></div>` : ''}
      ${selectedCount ? this.bulkBarHtml(selectedCount) : ''}`;
  }

  rowHtml(t) {
    const cat = this.catById.get(t.categoryId);
    const suggestion = t.suggestedCategoryId ? this.catById.get(t.suggestedCategoryId) : null;
    const options = this.categories
      .map((c) => `<option value="${escapeHtml(c.id)}" ${c.id === t.categoryId ? 'selected' : ''}>${escapeHtml(c.nome)}</option>`).join('');
    const canConfirm = t.status === 'pendente' && (t.suggestedCategoryId || t.categoryId);
    return `<tr data-id="${t.id}" class="${t.status === 'pendente' ? 'is-pending' : ''}">
      <td data-label="Selecionar"><input type="checkbox" class="f-select" aria-label="Selecionar transação" ${this.selected.has(t.id) ? 'checked' : ''}></td>
      <td data-label="Data">${formatDate(t.date)}</td>
      <td data-label="Descrição" class="desc"><strong>${escapeHtml(t.originalDescription) || '<em>(sem descrição)</em>'}</strong>
        <div class="micro">Estabelecimento: ${escapeHtml(t.merchantName || t.normalizedName) || '—'}</div></td>
      <td data-label="Valor" class="num ${t.amount < 0 ? 'neg' : 'pos'}">${formatBRL(t.amount)}</td>
      <td data-label="Categoria"><div class="cell-inline">
        <span class="cat-dot" style="background:${escapeHtml(cat?.cor || '#cbd5e1')}"></span>
        <select class="f-cat" aria-label="Categoria da transação">
          ${cat ? '' : '<option value="" selected disabled>— sem categoria —</option>'}${options}${NEW_CATEGORY_OPTION}</select></div></td>
      <td data-label="Classificação" class="status">
        <ul class="warnlist">
          <li class="w ${t.status === 'pendente' ? 'atencao' : 'ok'}"><b>${t.status === 'pendente' ? 'Revisar' : 'Classificada'}</b> · ${SOURCE_LABEL[t.categorySource] || 'Sem classificação'}${t.confidence ? ` · ${CONFIDENCE_LABEL[t.confidence]}` : ''}</li>
          ${suggestion && t.status === 'pendente' ? `<li class="w info">Sugestão: <b>${escapeHtml(suggestion.nome)}</b></li>` : ''}
          ${t.reason ? `<li class="micro">${escapeHtml(t.reason)}</li>` : ''}
        </ul>
        <div class="row-actions">
          ${canConfirm ? '<button class="btn small" data-act="confirm" type="button">Confirmar</button>' : ''}
          ${t.manual ? '<button class="btn small" data-act="reset" type="button">Voltar ao automático</button>' : ''}
        </div></td>
    </tr>`;
  }

  bulkBarHtml(count) {
    return `<div class="action-bar bulk" role="region" aria-label="Ações em lote">
      <div class="action-info"><strong>${count}</strong> selecionada${count === 1 ? '' : 's'}</div>
      <div class="action-buttons">
        <select id="bulk-cat" aria-label="Categoria para aplicar às selecionadas">
          <option value="">Escolher categoria…</option>
          ${this.categories.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.nome)}</option>`).join('')}${NEW_CATEGORY_OPTION}</select>
        <button class="btn primary" data-act="bulk-apply" type="button">Categorizar</button>
        <button class="btn" data-act="bulk-confirm" type="button">Confirmar sugestões</button>
        <button class="btn" data-act="bulk-reset" type="button">Voltar ao automático</button>
        <button class="btn" data-act="bulk-clear" type="button">Limpar seleção</button>
      </div></div>`;
  }

  // ------------------------------------------------------------------ eventos
  idOf(el) { return Number(el.closest('tr[data-id]')?.dataset.id); }

  async onChange(e) {
    const el = e.target;
    if (el.id === 'select-all') {
      const rows = this.visible();
      if (el.checked) rows.forEach((t) => this.selected.add(t.id)); else rows.forEach((t) => this.selected.delete(t.id));
      return this.draw();
    }
    if (el.classList.contains('f-select')) {
      const id = this.idOf(el);
      if (el.checked) this.selected.add(id); else this.selected.delete(id);
      return this.draw();
    }
    if (el.classList.contains('f-cat')) {
      let categoryId = el.value;
      const id = this.idOf(el);
      if (categoryId === NEW_CATEGORY_VALUE) {
        const created = await askNewCategory(this.db);
        if (!created) return this.draw(); // cancelou: o seletor volta para a categoria anterior
        categoryId = created.id;
      }
      await this.run(() => setCategory(this.db, [id], categoryId, { remember: this.remember }),
        (r) => `Categoria alterada.${r.rules ? ' Regra memorizada para este estabelecimento.' : ''}`);
    }
    if (el.id === 'bulk-cat' && el.value === NEW_CATEGORY_VALUE) {
      const created = await askNewCategory(this.db);
      if (!created) { el.value = ''; return undefined; }
      await this.reload();
      this.draw();
      const select = this.container.querySelector('#bulk-cat');
      if (select) select.value = created.id;
      this.say(`Categoria "${created.nome}" criada. Clique em Categorizar para aplicá-la às selecionadas.`);
    }
    return undefined;
  }

  async onClick(e) {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const ids = [...this.selected];
    if (act === 'more') { this.limit += PAGE_SIZE; return this.draw(); }
    if (act === 'clear-filters') {
      filters.search = ''; filters.category = 'todas'; filters.status = 'todas';
      this.limit = PAGE_SIZE;
      this.container.querySelector('#f-search').value = '';
      this.container.querySelector('#f-category').value = 'todas';
      const status = this.container.querySelector('#f-status');
      if (status) status.value = 'todas';
      return this.draw();
    }
    if (act === 'bulk-clear') { this.selected.clear(); return this.draw(); }
    if (act === 'confirm') {
      const id = this.idOf(btn);
      return this.run(() => confirmSuggestions(this.db, [id], { remember: this.remember }), () => 'Sugestão confirmada.');
    }
    if (act === 'reset') {
      const id = this.idOf(btn);
      return this.run(() => resetToAutomatic(this.db, [id]), () => 'Voltou para a classificação automática.');
    }
    if (act === 'bulk-apply') {
      const category = this.container.querySelector('#bulk-cat').value;
      if (!category || category === NEW_CATEGORY_VALUE) return this.say('Escolha uma categoria para aplicar às selecionadas.');
      return this.run(() => setCategory(this.db, ids, category, { remember: this.remember }),
        (r) => `${r.changed} transaç${r.changed === 1 ? 'ão categorizada' : 'ões categorizadas'}.${r.rules ? ` ${r.rules} regra(s) memorizada(s).` : ''}`, true);
    }
    if (act === 'bulk-confirm') {
      return this.run(() => confirmSuggestions(this.db, ids, { remember: this.remember }),
        (r) => `${r.changed} confirmada(s).${r.skipped ? ` ${r.skipped} sem sugestão (escolha uma categoria).` : ''}`, true);
    }
    if (act === 'bulk-reset') {
      return this.run(() => resetToAutomatic(this.db, ids), () => 'Selecionadas voltaram ao automático.', true);
    }
  }

  async run(action, successMessage, clearSelection = false) {
    try {
      const result = await action();
      if (clearSelection) this.selected.clear();
      await this.reload();
      this.draw();
      this.say(successMessage(result));
    } catch (error) {
      console.error(error);
      this.say(`Erro: ${error.message}`);
    }
  }
}
