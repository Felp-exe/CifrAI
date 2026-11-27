// Tela "Importar extrato": envio do PDF, revisão das transações e salvamento.
// Fluxo: 1) escolher PDF  2) ler e interpretar  3) REVISAR  4) salvar (só com sua confirmação).
import { pageHeader, statCard } from './components.js';
import { icons } from './icons.js';
import { escapeHtml, formatBRL, formatDate } from '../utils/format.js';
import { setSetting } from '../storage.js';
import { parseMoneyBR } from '../utils/money.js';
import { MOVEMENT_TYPES } from '../import/movementTypes.js';
import { ImportError } from '../pdf/pdfReader.js';
import {
  analyzePdf, applyYear, blockingProblems, isSavable, saveReviewed, syncSignedAmount,
} from '../import/importService.js';
import { markDuplicates, loadExistingFingerprints } from '../import/duplicates.js';

const MAX_SIZE = 25 * 1024 * 1024; // 25 MB
const SAMPLE_URL = 'samples/extrato-exemplo-modelo-a.pdf';

/** Baixa o extrato de exemplo (dados fictícios, que vêm junto com o site) como se fosse um PDF escolhido por você. */
export async function fetchSampleFile(url = SAMPLE_URL) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('o arquivo de exemplo não foi encontrado.');
  return new File([await response.blob()], 'extrato-exemplo.pdf', { type: 'application/pdf' });
}

let queuedFile = null; // arquivo que a tela inicial deixa pronto para a tela de importação

/** Usado pela tela inicial: prepara o extrato de exemplo e abre a importação (que já começa a ler). */
export async function useSampleStatement() {
  queuedFile = await fetchSampleFile();
  location.hash = '#/importar';
}

export async function render(container, ctx) {
  const view = new ImportView(container, ctx);
  if (queuedFile) {
    const file = queuedFile;
    queuedFile = null;
    await view.handleFile(file);
    return;
  }
  await view.showUpload();
}

class ImportView {
  constructor(container, ctx) {
    this.container = container;
    this.db = ctx.db;
    this.analysis = null;
    this.existing = new Set();
    this.filter = 'todas';
  }

  // ------------------------------------------------------------------ 1) Envio
  async showUpload(errorMessage = '') {
    const imports = (await this.db.getAll('imports')).sort((a, b) => b.importedAt.localeCompare(a.importedAt));
    this.container.innerHTML = `
      ${pageHeader('Importar extrato', 'Envie o extrato bancário em PDF. Você revisa tudo antes de salvar.')}
      ${errorMessage ? `<section class="card error" role="alert"><h2>Não foi possível importar</h2><p>${escapeHtml(errorMessage)}</p></section>` : ''}
      <section class="card dropzone" id="dropzone">
        <div class="dropzone-icon">${icons.upload}</div>
        <h2>Arraste o PDF do extrato até aqui</h2>
        <p>ou</p>
        <label class="btn primary">Escolher arquivo
          <input type="file" id="file-input" accept="application/pdf,.pdf" hidden>
        </label>
        <p class="hint">O arquivo é lido no seu navegador e <strong>não é enviado para nenhum servidor</strong>.
        Funciona com PDFs que têm texto (baixados do app ou site do banco). PDFs escaneados não são suportados.
        Em computador compartilhado ou público, apague seus dados ao terminar (<a href="#/configuracoes">Ajustes</a>).</p>
        <div class="sample-box">
          <span class="muted">Sem um extrato à mão? Veja como funciona com dados fictícios.</span>
          <button class="btn" type="button" id="sample-btn">Usar extrato de exemplo</button>
        </div>
        <p id="sample-msg" class="settings-msg" role="status"></p>
      </section>
      <section class="card">
        <h2>Importações anteriores</h2>
        ${imports.length === 0
          ? '<p class="muted">Nenhuma importação feita ainda.</p>'
          : `<ul class="history">${imports.map((i) => `
            <li><strong>${escapeHtml(i.fileName)}</strong>
              <span class="muted">${new Date(i.importedAt).toLocaleString('pt-BR')} · ${i.savedCount} salva(s)${i.skippedDuplicates ? ` · ${i.skippedDuplicates} duplicada(s) não importada(s)` : ''}</span>
            </li>`).join('')}</ul>`}
      </section>`;

    const input = this.container.querySelector('#file-input');
    const zone = this.container.querySelector('#dropzone');
    input.addEventListener('change', () => input.files[0] && this.handleFile(input.files[0]));
    this.container.querySelector('#sample-btn').addEventListener('click', async () => {
      const msg = this.container.querySelector('#sample-msg');
      msg.textContent = 'Carregando o extrato de exemplo…';
      try {
        await this.handleFile(await fetchSampleFile());
      } catch (error) {
        msg.textContent = `Não consegui carregar o extrato de exemplo: ${error.message}`;
      }
    });
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('over');
      if (e.dataTransfer.files[0]) this.handleFile(e.dataTransfer.files[0]);
    });
  }

  // ------------------------------------------------------------------ 2) Leitura
  async handleFile(file) {
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (!isPdf) return this.showUpload('O arquivo escolhido não é um PDF.');
    if (file.size > MAX_SIZE) return this.showUpload('O arquivo é maior que 25 MB.');

    this.container.innerHTML = `${pageHeader('Importar extrato', escapeHtml(file.name))}
      <section class="card empty"><div class="spinner" aria-hidden="true"></div>
      <h2 id="progress">Lendo o PDF…</h2><p>Nada será salvo ainda.</p></section>`;
    const progress = this.container.querySelector('#progress');

    try {
      this.analysis = await analyzePdf(file, this.db, (page, total) => {
        progress.textContent = `Lendo página ${page} de ${total}…`;
      });
      this.existing = await loadExistingFingerprints(this.db);
      this.filter = 'todas';
      this.showReview();
    } catch (error) {
      console.error(error);
      const message = error instanceof ImportError ? error.message : `Erro inesperado ao ler o PDF: ${error.message}`;
      this.showUpload(message);
    }
  }

  // ------------------------------------------------------------------ 3) Revisão
  showReview() {
    this.rowEls = null; // a tabela é refeita: o cache de linhas precisa ser recriado
    const a = this.analysis;
    const needsYear = a.rows.some((r) => !r.date && r.day);
    const nothingFound = a.rows.length === 0;

    this.container.innerHTML = `
      ${pageHeader('Revisar importação', `${a.fileName} · ${a.pageCount} página(s) · formato: ${a.parserName || 'não reconhecido'}`)}
      <div id="summary" class="grid stats"></div>

      ${nothingFound ? `
        <section class="card warn" role="alert">
          <h2>Não encontrei movimentações neste PDF</h2>
          <p>O PDF tem texto, mas nenhuma linha no padrão <em>data + descrição + valor em R$</em>. O banco deste extrato pode usar outro formato
          (suportaremos novos formatos no futuro). Veja abaixo o texto lido para conferir.</p>
        </section>` : ''}

      ${needsYear ? `
        <section class="card warn" id="year-box">
          <h2>Informe o ano do extrato</h2>
          <p>Algumas datas não têm ano e o extrato não informa o período. Eu não vou chutar: digite o ano.</p>
          <div class="inline-form">
            <input type="number" id="year-input" min="1990" max="2100" placeholder="Ex.: 2026" aria-label="Ano do extrato">
            <button class="btn" id="year-apply" type="button">Aplicar às datas sem ano</button>
          </div>
        </section>` : ''}

      ${nothingFound ? '' : `
      <nav class="filters" id="filters" aria-label="Filtrar linhas"></nav>
      <section class="card table-card">
        <table class="review-table" id="review-table">
          <thead><tr><th>Salvar</th><th>Data</th><th>Descrição (como está no PDF)</th><th>Tipo</th><th>Entrada/Saída</th><th>Valor</th><th>Situação</th></tr></thead>
          <tbody>${a.rows.map((r) => this.rowHtml(r)).join('')}</tbody>
        </table>
      </section>`}

      ${this.extraSections()}

      <div class="action-bar" id="action-bar"></div>`;

    this.bindReview();
    this.refresh();
  }

  rowHtml(r) {
    const typeOptions = Object.entries(MOVEMENT_TYPES)
      .map(([value, label]) => `<option value="${value}" ${r.type === value ? 'selected' : ''}>${label}</option>`).join('');
    return `<tr data-id="${r.id}">
      <td data-label="Salvar"><input type="checkbox" class="f-select" aria-label="Salvar esta transação"></td>
      <td data-label="Data"><input type="date" class="f-date" value="${r.date || ''}" aria-label="Data">
        ${r.date ? '' : `<div class="micro">No PDF: ${escapeHtml(r.dateRaw)}</div>`}</td>
      <td data-label="Descrição" class="desc">
        <strong>${escapeHtml(r.originalDescription) || '<em>(sem descrição)</em>'}</strong>
        <div class="micro">Nome normalizado: ${escapeHtml(r.normalizedName) || '—'}</div>
        <div class="micro mono">Linha do PDF (pág. ${r.page}): ${escapeHtml(r.rawLine)}</div></td>
      <td data-label="Tipo"><select class="f-type" aria-label="Tipo">${typeOptions}</select></td>
      <td data-label="Entrada/Saída"><select class="f-direction" aria-label="Entrada ou saída">
        <option value="" ${r.direction ? '' : 'selected'}>— escolher —</option>
        <option value="entrada" ${r.direction === 'entrada' ? 'selected' : ''}>Entrada</option>
        <option value="saida" ${r.direction === 'saida' ? 'selected' : ''}>Saída</option></select></td>
      <td data-label="Valor"><input type="text" inputmode="decimal" class="f-amount" aria-label="Valor em reais" value="${r.absAmount ? centsToInput(r.absAmount) : ''}" placeholder="0,00"></td>
      <td data-label="Situação" class="status"></td>
    </tr>`;
  }

  extraSections() {
    const a = this.analysis;
    const list = (items) => items.map((u) => `<li><span class="mono">${escapeHtml(u.text)}</span> <span class="micro">(pág. ${u.page}) — ${escapeHtml(u.reason)}</span></li>`).join('');
    return `
      ${a.unrecognized.length ? `<details class="card" open><summary><strong>${a.unrecognized.length} linha(s) que não consegui interpretar</strong> — não serão salvas</summary>
        <ul class="plain-list">${list(a.unrecognized)}</ul></details>` : ''}
      ${a.ignored.length ? `<details class="card"><summary>${a.ignored.length} linha(s) de saldo ignoradas (não são movimentações)</summary>
        <ul class="plain-list">${list(a.ignored)}</ul></details>` : ''}
      <details class="card" ${a.rows.length ? '' : 'open'}><summary>Ver texto extraído do PDF (${a.extractedLines.length} linhas)</summary>
        <pre class="extracted">${escapeHtml(a.extractedLines.slice(0, 200).map((l) => l.text).join('\n'))}</pre></details>`;
  }

  rowOf(id) { return this.analysis.rows.find((r) => r.id === Number(id)); }

  bindReview() {
    const table = this.container.querySelector('#review-table');
    if (table) {
      table.addEventListener('change', (e) => {
        const tr = e.target.closest('tr[data-id]');
        if (!tr) return;
        const row = this.rowOf(tr.dataset.id);
        this.onFieldChange(row, tr, e.target);
      });
    }
    const yearApply = this.container.querySelector('#year-apply');
    if (yearApply) {
      yearApply.addEventListener('click', () => {
        const year = Number(this.container.querySelector('#year-input').value);
        if (!Number.isInteger(year) || year < 1990 || year > 2100) return;
        const changed = applyYear(this.analysis.rows, year);
        if (changed) { this.autoSelectNewlyComplete(); this.showReview(); }
      });
    }
    this.container.querySelector('#filters')?.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-filter]');
      if (btn) { this.filter = btn.dataset.filter; this.refresh(); }
    });
  }

  onFieldChange(row, tr, el) {
    const wasSavable = isSavable(row);
    if (el.classList.contains('f-select')) {
      row.selected = el.checked;
    } else if (el.classList.contains('f-date')) {
      row.date = el.value || null;
    } else if (el.classList.contains('f-type')) {
      row.type = el.value;
    } else if (el.classList.contains('f-direction')) {
      row.direction = el.value || null;
      row.directionSource = row.direction ? 'usuario' : null;
      row.warnings = row.warnings.filter((w) => w.code !== 'sem_direcao');
    } else if (el.classList.contains('f-amount')) {
      const parsed = parseMoneyBR(el.value);
      row.absAmount = parsed ? parsed.cents : null;
      row.amountInvalid = !parsed && el.value.trim() !== '';
    }
    syncSignedAmount(row);
    if (!isSavable(row)) row.selected = false;
    else if (!wasSavable && !el.classList.contains('f-select')) row.selected = true; // acabou de ficar completa
    markDuplicates(this.analysis.rows, this.existing);
    if (row.duplicate && !el.classList.contains('f-select') && row.selected) row.selected = false;
    this.refresh();
  }

  autoSelectNewlyComplete() {
    markDuplicates(this.analysis.rows, this.existing);
    for (const r of this.analysis.rows) if (isSavable(r) && !r.duplicate && !r.selected && r.warnings.some((w) => w.code === 'ano_informado')) r.selected = true;
  }

  /** Atualiza situação, filtros, resumo e botão salvar sem recriar os campos (preserva o foco). */
  refresh() {
    const rows = this.analysis.rows;
    // guarda as linhas da tabela uma vez só (buscar uma por uma ficava lento com extratos grandes)
    if (!this.rowEls) this.rowEls = new Map([...this.container.querySelectorAll('tr[data-id]')].map((tr) => [Number(tr.dataset.id), tr]));
    for (const r of rows) {
      const tr = this.rowEls.get(r.id);
      if (!tr) continue;
      const checkbox = tr.querySelector('.f-select');
      checkbox.checked = r.selected;
      checkbox.disabled = !isSavable(r);
      tr.querySelector('.status').innerHTML = this.statusHtml(r);
      tr.classList.toggle('is-duplicate', Boolean(r.duplicate));
      tr.classList.toggle('is-blocked', !isSavable(r));
      tr.hidden = !this.matchesFilter(r);
    }
    this.renderFilters();
    this.renderSummary();
    this.renderActionBar();
  }

  statusHtml(r) {
    const badges = [];
    const problems = blockingProblems(r);
    if (problems.length) badges.push(`<li class="w bloqueio"><b>Falta:</b> ${problems.join(', ')}</li>`);
    if (r.amountInvalid) badges.push('<li class="w bloqueio">Valor inválido: use o formato 1.234,56</li>');
    if (r.duplicate) badges.push('<li class="w atencao"><b>Possível duplicada:</b> já existe uma igual salva. Não será importada, a menos que você marque.</li>');
    else if (r.repeatedInFile) badges.push('<li class="w info">Aparece mais de uma vez neste extrato (pode ser legítimo).</li>');
    for (const w of r.warnings) {
      if (w.code === 'sem_direcao' || w.code === 'sem_ano' || w.code === 'data_invalida') {
        if (problems.length) badges.push(`<li class="w ${w.level}">${escapeHtml(w.message)}</li>`);
      } else {
        badges.push(`<li class="w ${w.level}">${escapeHtml(w.message)}</li>`);
      }
    }
    if (!badges.length) badges.push('<li class="w ok">Tudo certo</li>');
    return `<ul class="warnlist">${badges.join('')}</ul>`;
  }

  matchesFilter(r) {
    switch (this.filter) {
      case 'avisos': return r.warnings.some((w) => w.level !== 'info') || r.duplicate || !isSavable(r);
      case 'duplicadas': return r.duplicate;
      case 'incompletas': return !isSavable(r);
      default: return true;
    }
  }

  renderFilters() {
    const el = this.container.querySelector('#filters');
    if (!el) return;
    const rows = this.analysis.rows;
    const count = (f) => rows.filter((r) => {
      const prev = this.filter; this.filter = f; const ok = this.matchesFilter(r); this.filter = prev; return ok;
    }).length;
    const defs = [['todas', 'Todas'], ['avisos', 'Com avisos'], ['duplicadas', 'Duplicadas'], ['incompletas', 'Incompletas']];
    el.innerHTML = defs.map(([id, label]) =>
      `<button type="button" class="filter ${this.filter === id ? 'active' : ''}" data-filter="${id}" aria-pressed="${this.filter === id}">${label} (${count(id)})</button>`).join('');
  }

  renderSummary() {
    const rows = this.analysis.rows;
    const chosen = rows.filter((r) => r.selected);
    const inSum = chosen.filter((r) => r.signedAmount > 0).reduce((s, r) => s + r.signedAmount, 0);
    const outSum = chosen.filter((r) => r.signedAmount < 0).reduce((s, r) => s + Math.abs(r.signedAmount), 0);
    this.container.querySelector('#summary').innerHTML = [
      statCard({ label: 'Linhas lidas', value: String(rows.length), hint: `${this.analysis.unrecognized.length} não interpretadas` }),
      statCard({ label: 'Marcadas para salvar', value: String(chosen.length), hint: `${rows.filter((r) => r.duplicate).length} possíveis duplicadas` }),
      statCard({ label: 'Entradas marcadas', value: formatBRL(inSum), tone: 'positive' }),
      statCard({ label: 'Saídas marcadas', value: formatBRL(outSum), tone: 'negative' }),
    ].join('');
  }

  renderActionBar() {
    const chosen = this.analysis.rows.filter((r) => r.selected).length;
    const bar = this.container.querySelector('#action-bar');
    bar.innerHTML = `
      <div class="action-info">${chosen} transaç${chosen === 1 ? 'ão marcada' : 'ões marcadas'}. Nada foi salvo ainda.</div>
      <div class="action-buttons">
        ${this.analysis.rows.length ? `<button class="btn" id="btn-all" type="button">Marcar todas válidas</button>` : ''}
        <button class="btn" id="btn-cancel" type="button">Cancelar</button>
        <button class="btn primary" id="btn-save" type="button" ${chosen ? '' : 'disabled'}>Salvar ${chosen} transaç${chosen === 1 ? 'ão' : 'ões'}</button>
      </div>`;
    bar.querySelector('#btn-cancel').onclick = () => this.showUpload();
    const all = bar.querySelector('#btn-all');
    if (all) all.onclick = () => {
      for (const r of this.analysis.rows) r.selected = isSavable(r) && !r.duplicate;
      this.refresh();
    };
    bar.querySelector('#btn-save').onclick = () => this.save();
  }

  // ------------------------------------------------------------------ 4) Salvar
  async save() {
    const button = this.container.querySelector('#btn-save');
    button.disabled = true;
    try {
      const result = await saveReviewed(this.db, this.analysis);
      setSetting('dashboardPeriod', 'ultimo_extrato'); // o Painel abre direto no período deste extrato
      this.showDone(result);
    } catch (error) {
      console.error(error);
      button.disabled = false;
      alert(`Não consegui salvar: ${error.message}`);
    }
  }

  showDone({ savedCount, skippedDuplicates, period }) {
    this.container.innerHTML = `
      ${pageHeader('Importação concluída', this.analysis.fileName)}
      <section class="card empty">
        <span class="badge">Salvo</span>
        <h2>${savedCount} transaç${savedCount === 1 ? 'ão salva' : 'ões salvas'}</h2>
        ${period?.start && period?.end ? `<p>Período do extrato: <strong>${formatDate(period.start)} a ${formatDate(period.end)}</strong>${period.source === 'cabecalho' ? ' (lido do cabeçalho do PDF)' : ' (da primeira à última transação)'}. O Painel vai abrir neste período.</p>` : ''}
        <p>${skippedDuplicates ? `${skippedDuplicates} possível(is) duplicada(s) não foram importadas. ` : ''}As transações já foram <strong>categorizadas automaticamente</strong> pelas suas regras; as que ficaram incertas aparecem em <a href="#/transacoes/revisao">Transações › Revisão</a>.</p>
        <div class="action-buttons center">
          <a class="btn primary" href="#/painel">Ver painel</a>
          <button class="btn" id="again" type="button">Importar outro extrato</button>
        </div>
      </section>`;
    this.container.querySelector('#again').onclick = () => this.showUpload();
  }
}

function centsToInput(cents) {
  return new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
}
