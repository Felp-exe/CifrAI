// Aba "Rendas": cadastro de fontes de recebimento (nome, valor, dia, frequência).
import { escapeHtml, formatBRL, formatDate } from '../utils/format.js';
import { addDays, todayISO, WEEKDAYS } from '../utils/dates.js';
import { parseAmountInput } from '../utils/money.js';
import { showDialog } from './dialog.js';
import { updatePendingBadge } from './badges.js';
import { FREQUENCIES, occurrences, describeSource } from '../cycles/incomeSchedule.js';
import {
  listSources, createSource, updateSource, setSourceActive, deleteSource, deleteImpact,
} from '../cycles/incomeService.js';

export async function render(container, ctx) {
  new IncomeView(container, ctx.db).start();
}

class IncomeView {
  constructor(container, db) {
    this.container = container;
    this.db = db;
    this.editingId = null;
    this.message = '';
    this.frequency = 'mensal';
  }

  async start() {
    await this.load();
    this.draw();
    this.container.addEventListener('click', (e) => this.onClick(e));
    this.container.addEventListener('change', (e) => this.onChange(e));
    this.container.addEventListener('submit', (e) => this.onSubmit(e));
  }

  async load() { this.sources = await listSources(this.db); }

  draw() {
    const editing = this.sources.find((s) => s.id === this.editingId) || null;
    const f = editing ? editing.frequency : this.frequency;
    const today = todayISO();

    this.container.innerHTML = `
      <div id="msg" class="toast" role="status" aria-live="polite">${escapeHtml(this.message)}</div>
      <section class="card">
        <h2>${editing ? `Editar "${escapeHtml(editing.name)}"` : 'Nova fonte de renda'}</h2>
        <p class="muted">Cadastre quantas fontes quiser, com qualquer dia (não só 15, 20 e 30). Se o mês não tiver o dia
        (por exemplo, dia 30 em fevereiro), vale o <strong>último dia do mês</strong>.</p>
        <form id="income-form" class="form-grid">
          <label class="field"><span>Nome</span>
            <input name="name" type="text" required maxlength="40" placeholder="Ex.: Salário" value="${escapeHtml(editing?.name || '')}"></label>
          <label class="field"><span>Valor esperado (R$)</span>
            <input name="amount" type="text" inputmode="decimal" required placeholder="Ex.: 2500" value="${editing ? (editing.amount / 100).toFixed(2).replace('.', ',') : ''}"></label>
          <label class="field"><span>Frequência</span>
            <select name="frequency" id="frequency">${Object.entries(FREQUENCIES).map(([v, l]) => `<option value="${v}" ${f === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>

          ${f === 'mensal' || f === 'quinzenal' ? `<label class="field"><span>Dia do recebimento (1 a 31)</span>
            <input name="day" type="number" min="1" max="31" required value="${editing?.day ?? ''}"></label>` : ''}
          ${f === 'semanal' ? `<label class="field"><span>Dia da semana</span>
            <select name="weekday">${WEEKDAYS.map((w, i) => `<option value="${i}" ${editing?.weekday === i ? 'selected' : ''}>${w}</option>`).join('')}</select></label>` : ''}
          ${f === 'unica' ? `<label class="field"><span>Data do recebimento</span>
            <input name="date" type="date" required value="${editing?.date || ''}"></label>` : ''}

          <details class="wide">
            <summary>Opções avançadas (período de validade)</summary>
            <div class="form-grid inner">
              <label class="field"><span>Vale a partir de (opcional)</span><input name="startDate" type="date" value="${editing?.startDate || ''}"></label>
              <label class="field"><span>Vale até (opcional)</span><input name="endDate" type="date" value="${editing?.endDate || ''}"></label>
            </div>
          </details>

          <div class="action-buttons wide">
            <button class="btn primary" type="submit">${editing ? 'Salvar alterações' : 'Cadastrar fonte'}</button>
            ${editing ? '<button class="btn" type="button" data-act="cancel">Cancelar</button>' : ''}
          </div>
        </form>
      </section>

      <section class="card">
        <h2>Suas fontes de renda (${this.sources.length})</h2>
        ${this.sources.length === 0 ? '<p class="muted">Nenhuma fonte cadastrada ainda. Cadastre ao menos uma para o app criar os ciclos de recebimento.</p>' : `
        <ul class="income-list">${this.sources.map((s) => {
          const next = occurrences(s, today, addDays(today, 400)).slice(0, 3);
          return `<li data-id="${s.id}" class="${s.ativa === false ? 'inactive' : ''}">
            <div class="grow">
              <strong>${escapeHtml(s.name)}</strong> · ${formatBRL(s.amount)}
              <div class="micro">${escapeHtml(describeSource(s))}${s.startDate ? ` · a partir de ${formatDate(s.startDate)}` : ''}${s.endDate ? ` · até ${formatDate(s.endDate)}` : ''}</div>
              <div class="micro">${next.length ? `Próximos recebimentos: ${next.map(formatDate).join(', ')}` : 'Sem próximos recebimentos previstos.'}</div>
            </div>
            <label class="switch" title="Ativa"><input type="checkbox" data-act="toggle" ${s.ativa !== false ? 'checked' : ''} aria-label="Fonte ativa"><span></span></label>
            <div class="row-actions">
              <button class="btn small" data-act="edit" type="button">Editar</button>
              <button class="btn small danger-outline" data-act="delete" type="button">Excluir</button>
            </div>
          </li>`;
        }).join('')}</ul>`}
      </section>`;
  }

  say(text) { this.message = text; const el = this.container.querySelector('#msg'); if (el) el.textContent = text; }

  async refresh(message) {
    await this.load();
    this.message = message;
    this.draw();
    updatePendingBadge(this.db); // as rendas mudam os ciclos e, com eles, as pendências
  }

  formValues() {
    const d = new FormData(this.container.querySelector('#income-form'));
    const amount = parseAmountInput(d.get('amount'));
    if (!amount) throw new Error('Digite um valor válido, como 2500 ou 1.250,50.');
    return {
      name: d.get('name'), amount, frequency: d.get('frequency'),
      day: d.get('day'), weekday: d.get('weekday'), date: d.get('date'),
      startDate: d.get('startDate'), endDate: d.get('endDate'),
    };
  }

  async onSubmit(e) {
    if (e.target.id !== 'income-form') return;
    e.preventDefault();
    try {
      const values = this.formValues();
      if (this.editingId) {
        await updateSource(this.db, this.editingId, values);
        this.editingId = null;
        await this.refresh('Fonte de renda atualizada. Os ciclos foram recalculados.');
      } else {
        await createSource(this.db, values);
        await this.refresh('Fonte de renda cadastrada.');
      }
    } catch (error) { this.say(`Erro: ${error.message}`); }
  }

  onChange(e) {
    if (e.target.id === 'frequency') {
      // guarda o que já foi digitado ao trocar a frequência
      const keep = { name: e.target.form.name.value, amount: e.target.form.amount.value };
      this.frequency = e.target.value;
      if (this.editingId) {
        const s = this.sources.find((x) => x.id === this.editingId);
        this.sources = this.sources.map((x) => (x.id === s.id ? { ...x, frequency: this.frequency } : x));
      }
      this.draw();
      const form = this.container.querySelector('#income-form');
      form.name.value = keep.name;
      form.amount.value = keep.amount;
      return;
    }
    if (e.target.dataset.act === 'toggle') {
      const id = Number(e.target.closest('li').dataset.id);
      setSourceActive(this.db, id, e.target.checked)
        .then(() => this.refresh(e.target.checked ? 'Fonte ativada.' : 'Fonte desativada: seus ciclos deixam de aparecer.'))
        .catch((error) => this.say(`Erro: ${error.message}`));
    }
  }

  async onClick(e) {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'cancel') { this.editingId = null; this.frequency = 'mensal'; return this.refresh(''); }
    const id = Number(btn.closest('li')?.dataset.id);
    const source = this.sources.find((s) => s.id === id);
    if (btn.dataset.act === 'edit') {
      this.editingId = id;
      this.frequency = source.frequency;
      this.draw();
      window.scrollTo(0, 0);
    }
    if (btn.dataset.act === 'delete') {
      const impact = await deleteImpact(this.db, id);
      const answer = await showDialog({
        title: `Excluir "${source.name}"?`,
        bodyHtml: `<p>Os ciclos desta fonte deixam de existir. Suas transações <strong>não</strong> são apagadas.</p>
          ${impact.manualAllocations || impact.receiptLinks
            ? `<p>Também serão desfeitas a alocação manual de <strong>${impact.manualAllocations}</strong> despesa(s) e <strong>${impact.receiptLinks}</strong> vínculo(s) de recebimento ligados a esses ciclos.
               As despesas voltam para o cálculo automático ou para as pendências.</p>` : ''}`,
        confirmLabel: 'Excluir fonte', danger: true,
      });
      if (!answer) return;
      try {
        await deleteSource(this.db, id);
        this.editingId = null;
        await this.refresh('Fonte de renda excluída.');
      } catch (error) { this.say(`Erro: ${error.message}`); }
    }
  }
}
