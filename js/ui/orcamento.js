// Tela "Orçamento": limites mensais por categoria, com gasto, restante, percentual e alertas.
import { pageHeader, statCard, monthNavHtml } from './components.js';
import { showDialog } from './dialog.js';
import { askNewCategory, NEW_CATEGORY_OPTION, NEW_CATEGORY_VALUE } from './categorias.js';
import { escapeHtml, formatBRL, monthLabel } from '../utils/format.js';
import { shiftMonth } from '../utils/dates.js';
import { parseAmountInput } from '../utils/money.js';
import { listCategories } from '../categorization/categoryService.js';
import { listBudgets, createBudget, updateBudget, deleteBudget } from '../budget/budgetService.js';
import { monthlyBudgetReport, LEVEL_LABEL, WARN_AT_PERCENT } from '../budget/budgetEngine.js';
import { defaultMonth } from '../cycles/model.js';

const state = { month: null }; // o mês escolhido fica guardado enquanto você navega

const LEVEL_ICON = { ok: '✓', atencao: '!', excedido: '✕' };

export async function render(container, ctx) {
  // O contêiner da página é reaproveitado; criamos um filho novo para que os ouvintes de
  // clique desta tela morram junto com ela ao trocar de página.
  container.innerHTML = '<div></div>';
  await new BudgetView(container.firstElementChild, ctx.db).start();
}

class BudgetView {
  constructor(container, db) {
    this.container = container;
    this.db = db;
    this.message = '';
  }

  async start() {
    await this.load();
    this.draw();
    this.container.addEventListener('click', (e) => this.onClick(e));
    this.container.addEventListener('submit', (e) => this.onSubmit(e));
    this.container.addEventListener('change', (e) => this.onChange(e));
  }

  async load() {
    [this.budgets, this.categories, this.transactions] = await Promise.all([
      listBudgets(this.db), listCategories(this.db), this.db.getAll('transactions'),
    ]);
    this.catById = new Map(this.categories.map((c) => [c.id, c]));
    if (!state.month) state.month = defaultMonth(this.transactions);
  }

  draw() {
    const month = state.month;
    const report = monthlyBudgetReport({ budgets: this.budgets, transactions: this.transactions, month });
    const available = this.categories.filter((c) => !this.budgets.some((b) => b.categoryId === c.id));
    const rows = report.rows.sort((a, b) => b.percent - a.percent);

    this.container.innerHTML = `
      ${pageHeader('Orçamento', 'Defina quanto quer gastar por categoria em cada mês')}
      ${monthNavHtml(monthLabel(month))}
      <div id="msg" class="toast" role="status" aria-live="polite">${escapeHtml(this.message)}</div>

      <section class="grid stats">
        ${statCard({ label: 'Planejado', value: formatBRL(report.totals.limit), hint: `${rows.length} categoria(s) com orçamento` })}
        ${statCard({ label: 'Gasto', value: formatBRL(report.totals.spent), hint: 'nas categorias com orçamento', tone: 'negative' })}
        ${statCard({ label: 'Restante', value: formatBRL(report.totals.limit - report.totals.spent), hint: 'planejado − gasto', tone: report.totals.limit - report.totals.spent < 0 ? 'negative' : 'positive' })}
        ${statCard({ label: 'Alertas', value: String(report.totals.alerts), hint: `a partir de ${WARN_AT_PERCENT}% do limite`, tone: report.totals.alerts ? 'warning' : '' })}
      </section>

      <section class="card">
        <h2>Novo orçamento</h2>
        ${available.length === 0
          ? '<p class="muted">Todas as categorias já têm orçamento. <button type="button" class="link-btn" data-new-cat>Criar uma nova categoria</button> para definir outro limite.</p>'
          : `<form id="budget-form" class="form-grid">
              <label class="field"><span>Categoria</span><select name="categoryId" required>
                ${available.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.nome)}</option>`).join('')}${NEW_CATEGORY_OPTION}</select></label>
              <label class="field"><span>Limite mensal (R$)</span>
                <input name="limit" type="text" inputmode="decimal" required placeholder="Ex.: 600" autocomplete="off"></label>
              <div class="action-buttons"><button class="btn primary" type="submit">Criar orçamento</button></div>
            </form>`}
      </section>

      ${rows.length === 0 ? `<section class="card empty"><h2>Nenhum orçamento ainda</h2>
        <p>Crie um limite acima (por exemplo, Alimentação: R$ 600) para acompanhar quanto já foi gasto no mês.</p></section>`
        : `<section class="budget-list" aria-label="Orçamentos">${rows.map((r) => this.cardHtml(r)).join('')}</section>`}

      ${this.extraHtml(report)}`;
  }

  cardHtml(r) {
    const cat = this.catById.get(r.categoryId);
    const width = Math.min(100, r.percent);
    const over = r.remaining < 0;
    return `<article class="card budget-card level-${r.level}" data-id="${r.budget.id}">
      <header class="budget-head">
        <div><span class="cat-dot" style="background:${escapeHtml(cat?.cor || '#cbd5e1')}"></span><strong>${escapeHtml(cat?.nome || 'Categoria removida')}</strong></div>
        <span class="level-badge ${r.level}"><span aria-hidden="true">${LEVEL_ICON[r.level]}</span> ${LEVEL_LABEL[r.level]}</span>
      </header>
      <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(Math.min(r.percent, 100))}"
           aria-label="${Math.round(r.percent)}% do orçamento de ${escapeHtml(cat?.nome || '')} consumido">
        <span style="width:${width}%"></span>
      </div>
      <div class="budget-numbers">
        <div><span>Planejado</span><strong>${formatBRL(r.limit)}</strong></div>
        <div><span>Gasto</span><strong>${formatBRL(r.spent)}</strong></div>
        <div><span>${over ? 'Excedido em' : 'Restante'}</span><strong class="${over ? 'neg' : 'pos'}">${formatBRL(Math.abs(r.remaining))}</strong></div>
        <div><span>Consumido</span><strong>${r.percent.toFixed(1).replace('.', ',')}%</strong></div>
      </div>
      ${r.detail.refunds ? `<p class="micro">Inclui o abatimento de ${formatBRL(r.detail.refunds)} em estornos.</p>` : ''}
      ${r.detail.pendingCount ? `<p class="micro">${r.detail.pendingCount} despesa(s) (${formatBRL(r.detail.pendingAmount)}) ainda estão pendentes de revisão: o valor pode mudar quando você confirmar as categorias.</p>` : ''}
      <div class="row-actions">
        <button class="btn small" data-act="edit" type="button">Editar limite</button>
        <button class="btn small danger-outline" data-act="delete" type="button">Excluir</button>
      </div>
    </article>`;
  }

  extraHtml(report) {
    const parts = [];
    if (report.withoutBudget.length) {
      parts.push(`<section class="card"><h2>Gastos em categorias sem orçamento</h2>
        <ul class="plain-list">${report.withoutBudget.map((w) => {
          const cat = this.catById.get(w.categoryId);
          return `<li><span class="cat-dot" style="background:${escapeHtml(cat?.cor || '#cbd5e1')}"></span>${escapeHtml(cat?.nome || w.categoryId)}: <strong>${formatBRL(w.spent)}</strong></li>`;
        }).join('')}</ul></section>`);
    }
    if (report.uncategorized.count) {
      parts.push(`<section class="card warn"><h2>Despesas sem categoria</h2>
        <p>${report.uncategorized.count} despesa(s) somando <strong>${formatBRL(report.uncategorized.total)}</strong> neste mês não entram em nenhum orçamento.
        Categorize-as na aba <a href="#/transacoes/revisao">Revisão</a>.</p></section>`);
    }
    parts.push(`<p class="muted note">Como o gasto é calculado: contam só <strong>saídas com categoria</strong> do mês. Estornos da mesma categoria abatem o gasto.
      Entradas e transações sem categoria não entram.</p>`);
    return parts.join('');
  }

  say(text) {
    this.message = text;
    const el = this.container.querySelector('#msg');
    if (el) el.textContent = text;
  }

  async refresh(message) {
    await this.load();
    this.message = message ?? this.message;
    this.draw();
  }

  /** Cria uma categoria nova sem sair do Orçamento e já a deixa escolhida no formulário. */
  async createCategoryHere() {
    const created = await askNewCategory(this.db);
    if (!created) return;
    await this.refresh(`Categoria "${created.nome}" criada. Agora defina o limite mensal.`);
    const select = this.container.querySelector('#budget-form select[name="categoryId"]');
    if (select) select.value = created.id;
    this.container.querySelector('#budget-form input[name="limit"]')?.focus();
  }

  async onChange(e) {
    if (e.target.name !== 'categoryId' || e.target.value !== NEW_CATEGORY_VALUE) return;
    const first = [...e.target.options].find((o) => o.value !== NEW_CATEGORY_VALUE);
    e.target.value = first ? first.value : '';
    await this.createCategoryHere();
  }

  async onSubmit(e) {
    if (e.target.id !== 'budget-form') return;
    e.preventDefault();
    const data = new FormData(e.target);
    const limit = parseAmountInput(data.get('limit'));
    try {
      if (!limit) throw new Error('Digite um valor válido, como 600 ou 1.250,50.');
      await createBudget(this.db, { categoryId: data.get('categoryId'), limit });
      await this.refresh('Orçamento criado.');
    } catch (error) { this.say(`Erro: ${error.message}`); }
  }

  async onClick(e) {
    if (e.target.closest('[data-new-cat]')) return this.createCategoryHere();
    const nav = e.target.closest('[data-month]');
    if (nav) {
      const kind = nav.dataset.month;
      state.month = kind === 'prev' ? shiftMonth(state.month, -1) : kind === 'next' ? shiftMonth(state.month, 1) : defaultMonth(this.transactions);
      return this.draw();
    }
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.closest('[data-id]').dataset.id);
    const budget = this.budgets.find((b) => b.id === id);
    const cat = this.catById.get(budget.categoryId);

    if (btn.dataset.act === 'edit') {
      const answer = await showDialog({
        title: `Editar orçamento de ${cat?.nome || ''}`,
        bodyHtml: `<label class="field"><span>Limite mensal (R$)</span>
          <input name="limit" type="text" inputmode="decimal" required value="${(budget.limit / 100).toFixed(2).replace('.', ',')}"></label>`,
        confirmLabel: 'Salvar',
      });
      if (!answer) return;
      try {
        const limit = parseAmountInput(answer.limit);
        if (!limit) throw new Error('Digite um valor válido, como 600 ou 1.250,50.');
        await updateBudget(this.db, id, { limit });
        await this.refresh('Orçamento atualizado.');
      } catch (error) { this.say(`Erro: ${error.message}`); }
    }
    if (btn.dataset.act === 'delete') {
      const answer = await showDialog({
        title: 'Excluir orçamento?',
        bodyHtml: `<p>O limite de <strong>${escapeHtml(cat?.nome || '')}</strong> será excluído. Suas transações não mudam.</p>`,
        confirmLabel: 'Excluir', danger: true,
      });
      if (!answer) return;
      await deleteBudget(this.db, id);
      await this.refresh('Orçamento excluído.');
    }
  }
}
