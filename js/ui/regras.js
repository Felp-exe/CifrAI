// Aba "Regras": criar, editar, ativar/desativar e excluir regras de categorização + simulador.
import { escapeHtml, normalizeText } from '../utils/format.js';
import { MATCH_TYPES, categorize } from '../categorization/categorizer.js';
import { listCategories } from '../categorization/categoryService.js';
import { extractMerchant } from '../categorization/merchant.js';
import { createRule, updateRule, setRuleActive, deleteRule, listRules } from '../categorization/ruleService.js';
import { recategorize } from '../categorization/transactionService.js';
import { showDialog } from './dialog.js';

const REVIEW = '__revisao';

export async function render(container, ctx) {
  new RulesView(container, ctx.db).start();
}

class RulesView {
  constructor(container, db) {
    this.container = container;
    this.db = db;
    this.editingId = null;
    this.message = '';
  }

  async start() {
    [this.rules, this.categories] = await Promise.all([listRules(this.db), listCategories(this.db)]);
    this.catById = new Map(this.categories.map((c) => [c.id, c]));
    this.draw();
  }

  async refresh() {
    [this.rules, this.categories] = await Promise.all([listRules(this.db), listCategories(this.db)]);
    this.catById = new Map(this.categories.map((c) => [c.id, c]));
    this.draw();
  }

  categoryOptions(selected) {
    return `<option value="${REVIEW}" ${selected === null ? 'selected' : ''}>Enviar para revisão (sem categoria)</option>` +
      this.categories.map((c) => `<option value="${escapeHtml(c.id)}" ${c.id === selected ? 'selected' : ''}>${escapeHtml(c.nome)}</option>`).join('');
  }

  draw() {
    const editing = this.editingId ? this.rules.find((r) => r.id === this.editingId) : null;
    const user = this.rules.filter((r) => r.origem === 'usuario');
    const initial = this.rules.filter((r) => r.origem !== 'usuario');

    this.container.innerHTML = `
      <div id="msg" class="toast" role="status" aria-live="polite">${escapeHtml(this.message)}</div>

      <section class="card">
        <h2>${editing ? 'Editar regra' : 'Nova regra'}</h2>
        <p class="muted">Suas regras têm prioridade sobre as regras iniciais do sistema.</p>
        <form id="rule-form" class="form-grid">
          <label class="field"><span>Texto a procurar</span>
            <input name="pattern" type="text" required maxlength="60" placeholder="Ex.: netflix" value="${escapeHtml(editing?.pattern || '')}"></label>
          <label class="field"><span>Como comparar</span>
            <select name="matchType">${Object.entries(MATCH_TYPES).map(([v, l]) => `<option value="${v}" ${editing?.matchType === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="field"><span>Categoria</span>
            <select name="categoryId">${this.categoryOptions(editing ? editing.categoryId : 'outros')}</select></label>
          ${editing ? '' : `<label class="check wide"><input type="checkbox" name="apply" checked>
            <span>Aplicar às transações já salvas <small>(as que você corrigiu manualmente não mudam)</small></span></label>`}
          <div class="action-buttons wide">
            <button class="btn primary" type="submit">${editing ? 'Salvar alterações' : 'Criar regra'}</button>
            ${editing ? '<button class="btn" type="button" id="cancel-edit">Cancelar</button>' : ''}
          </div>
        </form>
      </section>

      <section class="card">
        <h2>Testar uma descrição</h2>
        <p class="muted">Digite uma descrição de extrato para ver como o sistema classificaria.</p>
        <label class="field"><span>Descrição</span><input id="sim-input" type="text" placeholder="Ex.: COMPRA DEBITO IFD*IFOOD SAO PAULO"></label>
        <div id="sim-result" class="sim-result" aria-live="polite"></div>
      </section>

      <section class="card">
        <h2>Suas regras (${user.length})</h2>
        ${user.length ? this.tableHtml(user, true) : '<p class="muted">Você ainda não criou regras. Elas também são criadas automaticamente quando você corrige uma categoria (se a opção "Lembrar minhas correções" estiver ligada).</p>'}
      </section>

      <section class="card">
        <h2>Regras iniciais do sistema (${initial.length})</h2>
        <p class="muted">Podem ser desativadas, mas não editadas nem excluídas.</p>
        ${this.tableHtml(initial, false)}
      </section>`;

    this.bind();
  }

  tableHtml(rules, editable) {
    return `<div class="table-card"><table class="review-table rules-table">
      <thead><tr><th>Texto</th><th>Comparação</th><th>Categoria</th><th>Ativa</th>${editable ? '<th></th>' : ''}</tr></thead>
      <tbody>${rules.map((r) => {
        const cat = this.catById.get(r.categoryId);
        return `<tr data-id="${r.id}">
          <td data-label="Texto"><strong>${escapeHtml(r.pattern)}</strong>${r.observacao ? `<div class="micro">${escapeHtml(r.observacao)}</div>` : ''}${r.alternatives?.length ? `<div class="micro">Também reconhece: ${r.alternatives.map(escapeHtml).join(', ')}</div>` : ''}</td>
          <td data-label="Comparação">${escapeHtml(MATCH_TYPES[r.matchType] || r.matchType)}</td>
          <td data-label="Categoria">${r.categoryId === null ? '<span class="badge warn">Vai para revisão</span>'
            : cat ? `<span class="cell-inline"><span class="cat-dot" style="background:${escapeHtml(cat.cor)}"></span>${escapeHtml(cat.nome)}</span>` : '<em>categoria removida</em>'}</td>
          <td data-label="Ativa"><label class="switch"><input type="checkbox" class="f-active" ${r.ativa !== false ? 'checked' : ''} aria-label="Regra ativa"><span></span></label></td>
          ${editable ? `<td data-label="Ações" class="row-actions">
            <button class="btn small" data-act="edit" type="button">Editar</button>
            <button class="btn small danger-outline" data-act="delete" type="button">Excluir</button></td>` : ''}
        </tr>`;
      }).join('')}</tbody></table></div>`;
  }

  say(text) { this.message = text; const el = this.container.querySelector('#msg'); if (el) el.textContent = text; }

  bind() {
    const form = this.container.querySelector('#rule-form');
    form.addEventListener('submit', (e) => { e.preventDefault(); this.submit(new FormData(form)); });
    this.container.querySelector('#cancel-edit')?.addEventListener('click', () => { this.editingId = null; this.draw(); });

    if (this.bound) return; // os ouvintes abaixo ficam no contêiner fixo: registrar só uma vez
    this.bound = true;

    this.container.addEventListener('change', async (e) => {
      if (!e.target.classList.contains('f-active')) return;
      const id = Number(e.target.closest('tr').dataset.id);
      try {
        await setRuleActive(this.db, id, e.target.checked);
        const changed = await recategorize(this.db);
        await this.refresh();
        this.say(`Regra ${e.target.checked ? 'ativada' : 'desativada'}. ${changed} transação(ões) reclassificada(s).`);
      } catch (error) { this.say(`Erro: ${error.message}`); }
    });

    this.container.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const id = Number(btn.closest('tr').dataset.id);
      if (btn.dataset.act === 'edit') { this.editingId = id; this.draw(); window.scrollTo(0, 0); }
      if (btn.dataset.act === 'delete') await this.remove(id);
    });

    this.container.addEventListener('input', (e) => {
      if (e.target.id === 'sim-input') this.simulate(e.target.value);
    });
  }

  async submit(data) {
    const categoryId = data.get('categoryId') === REVIEW ? null : data.get('categoryId');
    try {
      if (this.editingId) {
        await updateRule(this.db, this.editingId, { pattern: data.get('pattern'), matchType: data.get('matchType'), categoryId });
        this.editingId = null;
        const changed = await recategorize(this.db);
        await this.refresh();
        this.say(`Regra atualizada. ${changed} transação(ões) reclassificada(s).`);
      } else {
        await createRule(this.db, { pattern: data.get('pattern'), matchType: data.get('matchType'), categoryId });
        const changed = data.get('apply') ? await recategorize(this.db) : 0;
        await this.refresh();
        this.say(`Regra criada.${data.get('apply') ? ` ${changed} transação(ões) reclassificada(s).` : ''}`);
      }
    } catch (error) { this.say(`Erro: ${error.message}`); }
  }

  async remove(id) {
    const rule = this.rules.find((r) => r.id === id);
    const answer = await showDialog({
      title: 'Excluir regra?',
      bodyHtml: `<p>A regra <strong>${escapeHtml(rule.pattern)}</strong> será excluída. As transações já corrigidas por você não mudam; as demais serão reclassificadas.</p>`,
      confirmLabel: 'Excluir', danger: true,
    });
    if (!answer) return;
    try {
      await deleteRule(this.db, id);
      const changed = await recategorize(this.db);
      await this.refresh();
      this.say(`Regra excluída. ${changed} transação(ões) reclassificada(s).`);
    } catch (error) { this.say(`Erro: ${error.message}`); }
  }

  simulate(text) {
    const out = this.container.querySelector('#sim-result');
    if (!text.trim()) { out.innerHTML = ''; return; }
    const tx = { originalDescription: text, normalizedName: normalizeText(text), amount: -1 };
    const result = categorize(tx, this.rules, new Set(this.categories.map((c) => c.id)));
    const cat = this.catById.get(result.categoryId);
    out.innerHTML = `<div><strong>Estabelecimento reconhecido:</strong> ${escapeHtml(extractMerchant(text))}</div>
      <div><strong>Categoria:</strong> ${cat ? `<span class="cat-dot" style="background:${escapeHtml(cat.cor)}"></span>${escapeHtml(cat.nome)}` : 'nenhuma (pendente)'}
        · ${result.status === 'pendente' ? '<span class="badge warn">Fica pendente de revisão</span>' : '<span class="badge">Classificada</span>'}</div>
      <div class="micro">${escapeHtml(result.reason)}</div>`;
  }
}
