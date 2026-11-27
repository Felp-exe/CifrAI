// Aba "Categorias": criar, editar e excluir categorias (com proteção das transações existentes).
import { escapeHtml } from '../utils/format.js';
import {
  listCategories, createCategory, updateCategory, deleteCategory, categoryUsage,
} from '../categorization/categoryService.js';
import { showDialog } from './dialog.js';

export async function render(container, ctx) {
  new CategoriesView(container, ctx.db).refresh();
}

/** Valor e opção "+ Nova categoria…" que as listas de categorias podem ter no final. */
export const NEW_CATEGORY_VALUE = '__nova';
export const NEW_CATEGORY_OPTION = `<option value="${NEW_CATEGORY_VALUE}">+ Nova categoria…</option>`;

/**
 * Janela "Nova categoria" (nome e cor), usada de dentro de outras telas (Transações, Orçamento).
 * Se o nome já existir ou for inválido, a janela reabre com a explicação. Devolve a categoria criada ou null (cancelou).
 */
export async function askNewCategory(db) {
  let error = '';
  let last = { nome: '', cor: '#8b7bea' };
  for (;;) {
    const values = await showDialog({
      title: 'Nova categoria',
      confirmLabel: 'Criar categoria',
      bodyHtml: `${error ? `<p class="w bloqueio" role="alert">${escapeHtml(error)}</p>` : ''}
        <label class="field"><span>Nome</span>
          <input name="nome" type="text" required maxlength="30" autocomplete="off" value="${escapeHtml(last.nome)}"></label>
        <label class="field"><span>Cor</span>
          <input name="cor" type="color" value="${escapeHtml(last.cor)}"></label>`,
    });
    if (!values) return null;
    last = { nome: values.nome, cor: values.cor };
    try {
      return await createCategory(db, { nome: values.nome, cor: values.cor });
    } catch (e) {
      error = e.message;
    }
  }
}

class CategoriesView {
  constructor(container, db) {
    this.container = container;
    this.db = db;
    this.message = '';
    this.editingId = null;
  }

  async refresh() {
    this.categories = await listCategories(this.db);
    const transactions = await this.db.getAll('transactions');
    this.counts = new Map();
    for (const t of transactions) if (t.categoryId) this.counts.set(t.categoryId, (this.counts.get(t.categoryId) || 0) + 1);
    this.draw();
  }

  draw() {
    const editing = this.categories.find((c) => c.id === this.editingId);
    this.container.innerHTML = `
      <div id="msg" class="toast" role="status" aria-live="polite">${escapeHtml(this.message)}</div>
      <section class="card">
        <h2>${editing ? `Editar "${escapeHtml(editing.nome)}"` : 'Nova categoria'}</h2>
        <form id="cat-form" class="form-grid">
          <label class="field"><span>Nome</span>
            <input name="nome" type="text" required maxlength="30" value="${escapeHtml(editing?.nome || '')}" ${editing?.padrao ? 'readonly' : ''}></label>
          <label class="field"><span>Cor</span>
            <input name="cor" type="color" value="${escapeHtml(editing?.cor || '#0ea5e9')}"></label>
          <div class="action-buttons wide">
            <button class="btn primary" type="submit">${editing ? 'Salvar' : 'Criar categoria'}</button>
            ${editing ? '<button class="btn" type="button" id="cancel-edit">Cancelar</button>' : ''}
          </div>
          ${editing?.padrao ? '<p class="micro wide">Categorias iniciais só permitem mudar a cor.</p>' : ''}
        </form>
      </section>
      <section class="card">
        <h2>Categorias (${this.categories.length})</h2>
        <ul class="cat-list">${this.categories.map((c) => `
          <li data-id="${escapeHtml(c.id)}">
            <span class="cat-dot big" style="background:${escapeHtml(c.cor)}"></span>
            <div class="grow"><strong>${escapeHtml(c.nome)}</strong>
              <div class="micro">${c.padrao ? 'Inicial · ' : 'Sua · '}${this.counts.get(c.id) || 0} transaç${(this.counts.get(c.id) || 0) === 1 ? 'ão' : 'ões'}</div></div>
            <div class="row-actions">
              <button class="btn small" data-act="edit" type="button">Editar</button>
              ${c.padrao ? '' : '<button class="btn small danger-outline" data-act="delete" type="button">Excluir</button>'}
            </div>
          </li>`).join('')}</ul>
      </section>`;

    const form = this.container.querySelector('#cat-form');
    form.addEventListener('submit', (e) => { e.preventDefault(); this.submit(new FormData(form)); });
    this.container.querySelector('#cancel-edit')?.addEventListener('click', () => { this.editingId = null; this.draw(); });
    this.container.querySelector('.cat-list').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const id = btn.closest('li').dataset.id;
      if (btn.dataset.act === 'edit') { this.editingId = id; this.draw(); window.scrollTo(0, 0); }
      if (btn.dataset.act === 'delete') this.remove(id);
    });
  }

  say(text) { this.message = text; const el = this.container.querySelector('#msg'); if (el) el.textContent = text; }

  async submit(data) {
    try {
      if (this.editingId) {
        await updateCategory(this.db, this.editingId, { nome: data.get('nome'), cor: data.get('cor') });
        this.editingId = null;
        this.message = 'Categoria atualizada.';
      } else {
        await createCategory(this.db, { nome: data.get('nome'), cor: data.get('cor') });
        this.message = 'Categoria criada.';
      }
      await this.refresh();
    } catch (error) { this.say(`Erro: ${error.message}`); }
  }

  async remove(id) {
    const category = this.categories.find((c) => c.id === id);
    const usage = await categoryUsage(this.db, id);
    const others = this.categories.filter((c) => c.id !== id);
    const needsMove = usage.transactions || usage.rules;
    const budgetNote = usage.budgets ? '<p class="micro">O orçamento desta categoria também será excluído.</p>' : '';
    const answer = await showDialog({
      title: `Excluir "${category.nome}"?`,
      bodyHtml: needsMove
        ? `<p>Esta categoria é usada por <strong>${usage.transactions}</strong> transação(ões) e <strong>${usage.rules}</strong> regra(s).
           Para não perder nada, escolha para onde movê-las:</p>
           <label class="field"><span>Mover para</span><select name="moveTo" required>
             ${others.map((c) => `<option value="${escapeHtml(c.id)}" ${c.id === 'outros' ? 'selected' : ''}>${escapeHtml(c.nome)}</option>`).join('')}</select></label>${budgetNote}`
        : `<p>Nenhuma transação nem regra usa esta categoria.</p>${budgetNote}`,
      confirmLabel: 'Excluir categoria', danger: true,
    });
    if (!answer) return;
    try {
      const result = await deleteCategory(this.db, id, answer.moveTo || null);
      this.message = `Categoria excluída.${result.movedTransactions ? ` ${result.movedTransactions} transação(ões) movida(s).` : ''}`;
      await this.refresh();
    } catch (error) { this.say(`Erro: ${error.message}`); }
  }
}
