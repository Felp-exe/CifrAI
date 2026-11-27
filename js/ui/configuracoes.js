// Tela "Configurações": backup e restauração, privacidade, armazenamento e informações do app.
import { pageHeader } from './components.js';
import { escapeHtml, formatDate } from '../utils/format.js';
import { getSetting, setSetting } from '../storage.js';
import { STORES, PERSONAL_DATA_WARNING } from '../backup/backupFormat.js';
import { buildBackup } from '../backup/backupExport.js';
import { saveBackupFile, readBackupFile } from '../backup/backupFile.js';
import { MODES, currentCounts, planRestore, restoreBackup } from '../backup/backupRestore.js';
import { getAssistantConfig } from '../agent/orchestrator.js';
import { listImports, previewDeleteImport, deleteImport, wipeAllData } from '../data/dataService.js';
import { showDialog } from './dialog.js';
import { DB_VERSION } from '../db.js';
import { BACKUP_VERSION } from '../backup/backupFormat.js';

const STORE_LABEL = {
  transactions: 'Transações', categories: 'Categorias', rules: 'Regras de categorização', budgets: 'Orçamentos',
  incomes: 'Fontes de renda', allocations: 'Alocações manuais de despesas', receiptLinks: 'Vínculos de recebimentos', imports: 'Histórico de importações',
};
const ORDER = ['transactions', 'categories', 'rules', 'budgets', 'incomes', 'allocations', 'receiptLinks', 'imports'];
const CONFIRM_WORD = 'SUBSTITUIR';
const WIPE_WORD = 'APAGAR';

const dateTime = (iso) => new Date(iso).toLocaleString('pt-BR');
const bytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export async function render(container, ctx) {
  container.innerHTML = '<div></div>';
  await new SettingsView(container.firstElementChild, ctx.db).start();
}

class SettingsView {
  constructor(root, db) {
    this.root = root;
    this.db = db;
    this.analysis = null;   // resultado da validação do arquivo escolhido
    this.fileName = '';
    this.mode = 'merge';
    this.exportMessage = '';
    this.restoreResult = null;
    this.busy = false;
    this.imports = [];
    this.cleanMessage = '';  // resultado da última exclusão (mostrado na seção de importações)
    this.wipeMessage = '';
  }

  async start() {
    this.counts = await currentCounts(this.db);
    this.imports = await listImports(this.db);
    this.storage = await this.readStorage();
    this.draw();
    this.root.addEventListener('click', (e) => this.onClick(e));
    this.root.addEventListener('change', (e) => this.onChange(e));
    this.root.addEventListener('input', (e) => this.onInput(e));
  }

  async readStorage() {
    const info = { supported: Boolean(navigator.storage?.estimate), usage: null, quota: null, persisted: null, canPersist: Boolean(navigator.storage?.persist) };
    try {
      if (info.supported) { const e = await navigator.storage.estimate(); info.usage = e.usage; info.quota = e.quota; }
      if (navigator.storage?.persisted) info.persisted = await navigator.storage.persisted();
    } catch { /* o navegador não informou: mostramos "indisponível" */ }
    return info;
  }

  // ------------------------------------------------------------------ desenho
  draw() {
    this.root.innerHTML = `
      ${pageHeader('Configurações', 'Backup dos seus dados, privacidade e informações do app')}
      ${this.backupHtml()}
      ${this.restoreHtml()}
      ${this.importsHtml()}
      ${this.wipeHtml()}
      ${this.privacyHtml()}
      ${this.aboutHtml()}`;
    this.syncRestoreButton();
    this.syncWipeButton();
  }

  /** Lista dos extratos importados, cada um com o botão "Excluir importação". */
  importsHtml() {
    const rows = this.imports.map((m) => `<tr>
        <td>${escapeHtml(m.fileName || 'Sem nome')}</td>
        <td>${m.firstDate && m.lastDate ? `${formatDate(m.firstDate)} a ${formatDate(m.lastDate)}` : '—'}</td>
        <td>${m.transactionCount}</td>
        <td>${escapeHtml(dateTime(m.importedAt))}</td>
        <td><button class="btn small danger" type="button" data-act="delete-import" data-id="${escapeHtml(m.id)}" aria-label="Excluir importação ${escapeHtml(m.fileName || '')}">Excluir importação</button></td>
      </tr>`).join('');
    return `<section class="card" aria-labelledby="h-imports">
      <h2 id="h-imports">Importações salvas</h2>
      <p>Cada extrato que você importou aparece aqui. Excluir uma importação remove <strong>só as transações dela</strong> (e os vínculos delas com recebimentos e alocações). Suas regras, categorias, orçamentos e fontes de renda ficam como estão.</p>
      ${this.imports.length ? `<div class="table-card"><table class="data-table">
        <thead><tr><th>Arquivo</th><th>Período</th><th>Transações</th><th>Importado em</th><th>Ação</th></tr></thead>
        <tbody>${rows}</tbody></table></div>` : '<p class="muted">Nenhuma importação salva ainda.</p>'}
      <p id="clean-msg" class="settings-msg" role="status">${escapeHtml(this.cleanMessage)}</p>
    </section>`;
  }

  /** "Zona de perigo": apagar tudo, com confirmação por digitação. */
  wipeHtml() {
    return `<section class="card danger-zone" aria-labelledby="h-wipe">
      <h2 id="h-wipe">Apagar todos os dados</h2>
      <p>Remove <strong>tudo</strong> o que está salvo neste navegador: ${this.counts.transactions} transação(ões), ${this.counts.imports} importação(ões), orçamentos, fontes de renda, alocações e as categorias e regras que você criou. O app volta ao estado de recém-instalado, só com as categorias e regras iniciais. <strong>Não dá para desfazer.</strong></p>
      <div class="privacy-box warn-box" role="note">Antes de apagar, <button type="button" class="link-btn" data-act="export-first">exporte um backup agora</button> se quiser guardar seus dados.</div>
      <label class="check"><input type="checkbox" id="wipe-confirm"> <span>Entendi que todos os meus dados serão apagados.</span></label>
      <label class="field"><span>Para confirmar, digite ${WIPE_WORD}</span>
        <input type="text" id="wipe-word" autocomplete="off" placeholder="${WIPE_WORD}"></label>
      <div class="action-buttons">
        <button class="btn danger" type="button" id="wipe-btn" data-act="wipe" disabled>Apagar todos os dados</button>
      </div>
      <p id="wipe-msg" class="settings-msg" role="status">${escapeHtml(this.wipeMessage)}</p>
    </section>`;
  }

  syncWipeButton() {
    const btn = this.root.querySelector('#wipe-btn');
    if (!btn) return;
    const confirmed = this.root.querySelector('#wipe-confirm')?.checked;
    const word = this.root.querySelector('#wipe-word')?.value.trim().toUpperCase() === WIPE_WORD;
    btn.disabled = this.busy || !(confirmed && word);
  }

  async askDeleteImport(id) {
    const imp = this.imports.find((m) => m.id === id);
    if (!imp) return;
    const p = await previewDeleteImport(this.db, id);
    const values = await showDialog({
      title: 'Excluir esta importação?',
      confirmLabel: 'Excluir importação',
      danger: true,
      bodyHtml: `<p><strong>${escapeHtml(imp.fileName || 'Sem nome')}</strong>${imp.firstDate ? ` (${formatDate(imp.firstDate)} a ${formatDate(imp.lastDate)})` : ''}</p>
        <p>Serão removidas <strong>${p.transactions} transação(ões)</strong>${p.manual ? `, sendo ${p.manual} com categoria corrigida por você` : ''}${p.allocations || p.receiptLinks ? `, além de ${p.allocations} alocação(ões) e ${p.receiptLinks} vínculo(s) de recebimento ligados a elas` : ''}.</p>
        <p>Regras, categorias, orçamentos e rendas não serão alterados. Você poderá importar o mesmo extrato de novo depois. Não dá para desfazer.</p>`,
    });
    if (!values) return;
    this.busy = true;
    try {
      const r = await deleteImport(this.db, id);
      this.cleanMessage = `✓ Importação excluída: ${r.transactions} transação(ões) removida(s).`;
      // O Painel não deve abrir num extrato que não existe mais.
      setSetting('dashboardPeriod', null);
    } catch (error) {
      console.error(error);
      this.cleanMessage = `Não foi possível excluir: ${error.message} Nada foi alterado.`;
    }
    this.busy = false;
    await this.reload();
  }

  async wipeNow() {
    this.busy = true;
    this.syncWipeButton();
    this.say('#wipe-msg', 'Apagando… não feche a página.');
    try {
      const removed = await wipeAllData(this.db);
      this.wipeMessage = `✓ Tudo foi apagado (${removed.transactions} transação(ões) e ${removed.imports} importação(ões)). O app voltou ao estado inicial.`;
      this.cleanMessage = '';
      this.restoreResult = null;
      this.analysis = null;
    } catch (error) {
      console.error(error);
      this.wipeMessage = `Não foi possível apagar tudo: ${error.message} Recarregue a página e confira seus dados.`;
    }
    this.busy = false;
    await this.reload();
  }

  async reload() {
    this.counts = await currentCounts(this.db);
    this.imports = await listImports(this.db);
    this.draw();
  }

  backupHtml() {
    const last = getSetting('lastBackup');
    return `<section class="card" aria-labelledby="h-backup">
      <h2 id="h-backup">Backup dos seus dados</h2>
      <p>Seus dados ficam só neste navegador. Se você limpar os dados do site, trocar de computador ou o navegador falhar, eles podem ser perdidos. O backup é um arquivo que você guarda e pode restaurar depois.</p>
      <div class="privacy-box warn-box" role="note"><strong>Atenção:</strong> ${escapeHtml(PERSONAL_DATA_WARNING)}</div>
      <ul class="plain-list">
        <li>O arquivo é gerado <strong>no seu computador</strong>. Nada é enviado para servidores ou serviços externos.</li>
        <li>Não inclui chaves de API nem credenciais (o app não usa nenhuma) e não inclui o texto bruto dos PDFs.</li>
        <li>Recomendado: guarde em uma pasta protegida (ou criptografada) e faça um backup de tempos em tempos.</li>
      </ul>
      <p class="muted">${last ? `Último backup exportado neste navegador: <strong>${escapeHtml(dateTime(last))}</strong>.` : 'Você ainda não exportou nenhum backup neste navegador.'}</p>
      <p class="muted">Será exportado: ${ORDER.map((s) => `${this.counts[s]} ${STORE_LABEL[s].toLowerCase()}`).join(' · ')}.</p>
      <div class="action-buttons">
        <button class="btn primary" type="button" data-act="export" ${this.busy ? 'disabled' : ''}>Exportar backup (.json)</button>
      </div>
      <p id="export-msg" class="settings-msg" role="status">${escapeHtml(this.exportMessage)}</p>
    </section>`;
  }

  restoreHtml() {
    const a = this.analysis;
    return `<section class="card" aria-labelledby="h-restore">
      <h2 id="h-restore">Restaurar um backup</h2>
      <p>Escolha um arquivo de backup exportado por este app. Nada é alterado até você conferir o resumo e confirmar.</p>
      <label class="field"><span>Arquivo de backup (.json)</span>
        <input type="file" id="backup-file" accept="application/json,.json"></label>
      ${a ? (a.ok ? this.analysisOkHtml(a) : this.analysisErrorHtml(a)) : ''}
      ${this.restoreResult ? this.resultHtml(this.restoreResult) : ''}
      <p id="restore-msg" class="settings-msg" role="status"></p>
    </section>`;
  }

  analysisErrorHtml(a) {
    return `<div class="w bloqueio" role="alert"><strong>${a.incompatible ? 'Backup incompatível.' : 'Arquivo inválido.'} Nada foi restaurado.</strong>
      <ul class="plain-list">${a.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul></div>`;
  }

  analysisOkHtml(a) {
    const s = a.summary;
    const cur = this.counts;
    return `<div class="restore-summary">
      <h3>Resumo do arquivo "${escapeHtml(this.fileName)}"</h3>
      <p class="muted">Exportado em ${escapeHtml(dateTime(s.exportedAt))} · formato versão ${s.formatVersion}${s.firstDate ? ` · transações de ${formatDate(s.firstDate)} a ${formatDate(s.lastDate)}` : ''}.</p>
      <div class="table-card"><table class="data-table">
        <thead><tr><th>Dados</th><th>No backup</th><th>Atualmente no app</th></tr></thead>
        <tbody>${ORDER.map((st) => `<tr><td>${STORE_LABEL[st]}</td><td>${s.counts[st]}</td><td>${cur[st]}</td></tr>`).join('')}</tbody>
      </table></div>
      ${a.warnings.length ? `<ul class="notes">${a.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>` : ''}

      <fieldset class="mode-box">
        <legend>Como restaurar</legend>
        ${Object.entries(MODES).map(([value, label]) => `<label class="check"><input type="radio" name="restore-mode" value="${value}" ${this.mode === value ? 'checked' : ''}>
          <span>${label}<small>${value === 'replace'
            ? ' — apaga tudo o que existe agora e coloca os dados do arquivo'
            : ' — acrescenta só o que ainda não existe; o que já existe é mantido'}</small></span></label>`).join('')}
      </fieldset>

      <div class="privacy-box ${this.mode === 'replace' ? 'warn-box' : ''}" role="note">
        ${this.mode === 'replace'
          ? `<strong>Atenção:</strong> os ${cur.transactions} transação(ões) e todos os outros dados atuais serão <strong>apagados</strong> e substituídos. Não dá para desfazer. Se ainda não tem backup dos dados atuais, <button type="button" class="link-btn" data-act="export-first">exporte um agora</button>.`
          : 'Transações repetidas (mesma data, valor e descrição) não são duplicadas. Suas correções manuais atuais são mantidas; correções manuais do backup são trazidas para transações que você ainda não corrigiu.'}
      </div>

      <label class="check"><input type="checkbox" id="restore-confirm"> <span>Entendi e quero restaurar este backup.</span></label>
      ${this.mode === 'replace' ? `<label class="field"><span>Para confirmar a substituição, digite ${CONFIRM_WORD}</span>
        <input type="text" id="restore-word" autocomplete="off" placeholder="${CONFIRM_WORD}"></label>` : ''}
      <div class="action-buttons">
        <button class="btn ${this.mode === 'replace' ? 'danger' : 'primary'}" type="button" data-act="restore" id="restore-btn" disabled>Restaurar backup</button>
        <button class="btn" type="button" data-act="cancel-restore">Cancelar</button>
      </div>
    </div>`;
  }

  resultHtml(r) {
    const rows = ORDER.filter((s) => (r.added[s] || 0) + (r.skipped[s] || 0) + (r.removed[s] || 0) > 0)
      .map((s) => [STORE_LABEL[s], r.added[s] || 0, r.skipped[s] || 0, r.removed[s] || 0]);
    return `<div class="w ok" role="status"><strong>✓ Backup restaurado com sucesso.</strong>
      <div class="table-card"><table class="data-table"><thead><tr><th>Dados</th><th>Restaurados</th><th>Já existiam (mantidos)</th><th>Substituídos</th></tr></thead>
      <tbody>${rows.map((x) => `<tr>${x.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      ${(r.notes || []).map((n) => `<p class="micro">${escapeHtml(n)}</p>`).join('')}
      <p><a class="btn small primary" href="#/painel">Ver o Painel</a></p></div>`;
  }

  privacyHtml() {
    const st = this.storage;
    const cfg = getAssistantConfig();
    return `<section class="card" aria-labelledby="h-priv">
      <h2 id="h-priv">Privacidade e armazenamento</h2>
      <ul class="plain-list">
        <li>Sem login, sem cadastro e sem banco de dados online: tudo fica no <strong>IndexedDB deste navegador</strong>.</li>
        <li>Os PDFs são lidos no seu navegador e <strong>não são enviados</strong> a lugar nenhum.</li>
        <li>Os dados não são criptografados: <strong>quem usar este mesmo navegador no mesmo computador consegue vê-los</strong>. Em computador compartilhado ou público, use "Apagar todos os dados" ao terminar.</li>
        <li>O site só carrega e executa código dele mesmo (regra de segurança do navegador), e este é um projeto acadêmico, sem auditoria de segurança independente.</li>
        <li>Assistente: ${cfg.effectiveMode === 'llm'
          ? 'IA conectada — resultados resumidos das consultas vão ao seu backend de IA (veja a faixa na tela do Assistente).'
          : 'modo local, sem IA generativa; nenhuma pergunta sai do navegador.'} <a href="#/assistente">Abrir o Assistente</a>.</li>
      </ul>
      <h3>Armazenamento do navegador</h3>
      ${st.supported && st.usage !== null ? `<p>Uso estimado: <strong>${bytes(st.usage)}</strong> de ${bytes(st.quota)} disponíveis (inclui bibliotecas em cache).</p>` : '<p class="muted">Este navegador não informa o uso de armazenamento.</p>'}
      <p>Armazenamento persistente: <strong id="persist-state">${st.persisted === null ? 'indisponível neste navegador' : st.persisted ? 'ativado (o navegador não apaga seus dados sozinho)' : 'não ativado (o navegador pode apagar os dados se faltar espaço)'}</strong></p>
      ${st.canPersist && st.persisted === false ? '<div class="action-buttons"><button class="btn" type="button" data-act="persist">Pedir armazenamento persistente</button></div>' : ''}
      <p id="persist-msg" class="settings-msg" role="status"></p>
    </section>`;
  }

  aboutHtml() {
    return `<section class="card" aria-labelledby="h-about">
      <h2 id="h-about">Sobre</h2>
      <ul class="plain-list">
        <li><strong>CifrAI</strong> — controle financeiro pessoal que roda inteiro no navegador.</li>
        <li>Banco de dados: versão ${DB_VERSION} · formato de backup: versão ${BACKUP_VERSION}</li>
        <li>Bibliotecas locais: PDF.js 4.10.38 (leitura de PDF) e Chart.js 4.4.7 (gráficos).</li>
      </ul>
    </section>`;
  }

  // ------------------------------------------------------------------ eventos
  say(id, text) {
    const el = this.root.querySelector(id);
    if (el) el.textContent = text;
  }

  syncRestoreButton() {
    const btn = this.root.querySelector('#restore-btn');
    if (!btn) return;
    const confirmed = this.root.querySelector('#restore-confirm')?.checked;
    const word = this.root.querySelector('#restore-word');
    const wordOk = this.mode !== 'replace' || (word && word.value.trim().toUpperCase() === CONFIRM_WORD);
    btn.disabled = this.busy || !(confirmed && wordOk);
  }

  async onChange(e) {
    if (e.target.id === 'backup-file') {
      const file = e.target.files[0];
      this.restoreResult = null;
      this.fileName = file?.name || '';
      this.analysis = await readBackupFile(file);
      this.draw();
      this.root.querySelector('#h-restore').scrollIntoView({ block: 'start' });
    } else if (e.target.name === 'restore-mode') {
      this.mode = e.target.value;
      this.draw();
    } else if (e.target.id === 'restore-confirm') {
      this.syncRestoreButton();
    } else if (e.target.id === 'wipe-confirm') {
      this.syncWipeButton();
    }
  }

  onInput(e) {
    if (e.target.id === 'restore-word') this.syncRestoreButton();
    if (e.target.id === 'wipe-word') this.syncWipeButton();
  }

  async exportNow() {
    this.busy = true;
    this.say('#export-msg', 'Preparando o backup…');
    try {
      const backup = await buildBackup(this.db);
      const result = await saveBackupFile(backup);
      this.exportMessage = result.cancelled
        ? 'Exportação cancelada: nenhum arquivo foi salvo.'
        : `✓ Backup ${result.method === 'picker' ? 'salvo' : 'baixado'}: ${result.fileName} (${backup.counts.transactions} transações). Guarde-o em local seguro: ele contém dados financeiros pessoais.`;
    } catch (error) {
      console.error(error);
      this.exportMessage = `Não consegui gerar o backup: ${error.message}`;
    }
    this.busy = false;
    this.draw();
  }

  async restoreNow() {
    const a = this.analysis;
    this.busy = true;
    this.syncRestoreButton();
    this.say('#restore-msg', 'Restaurando… não feche a página.');
    try {
      const plan = await planRestore(this.db, a.backup, this.mode);
      const summary = await restoreBackup(this.db, a.backup, { mode: this.mode, confirmed: true, plan });
      this.restoreResult = summary;
      this.analysis = null;
      this.counts = await currentCounts(this.db);
    } catch (error) {
      console.error(error);
      this.busy = false;
      this.draw();
      this.say('#restore-msg', `Não foi possível restaurar: ${error.message}. Nenhum dado foi alterado.`);
      return;
    }
    this.busy = false;
    this.draw();
  }

  async onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'export' || act === 'export-first') return this.exportNow();
    if (act === 'cancel-restore') { this.analysis = null; this.draw(); return; }
    if (act === 'delete-import') {
      if (!e.isTrusted || this.busy) return; // só um clique real do usuário exclui
      await this.askDeleteImport(btn.dataset.id);
      return;
    }
    if (act === 'wipe') {
      if (!e.isTrusted || this.busy) return;
      await this.wipeNow();
      return;
    }
    if (act === 'restore') {
      if (!e.isTrusted) return; // só um clique real do usuário restaura
      await this.restoreNow();
      return;
    }
    if (act === 'persist') {
      let granted = false;
      try { granted = await navigator.storage.persist(); } catch { granted = false; }
      this.storage = await this.readStorage();
      this.draw();
      this.say('#persist-msg', granted ? '✓ Armazenamento persistente ativado.' : 'O navegador não concedeu (ele decide com base no uso do site). Mantenha seus backups em dia.');
    }
  }
}
