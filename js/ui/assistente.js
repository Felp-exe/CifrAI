// Tela "Assistente": conversa com os seus dados (modo local ou IA conectada).
import { pageHeader } from './components.js';
import { escapeHtml } from '../utils/format.js';
import { todayISO } from '../utils/dates.js';
import { getSetting } from '../storage.js';
import { statementPeriod } from '../dashboard/period.js';
import { EXAMPLE_QUESTIONS } from '../agent/localAgent.js';
import {
  ask, getAssistantConfig, saveEndpoint, clearEndpoint, setAssistantMode, testConnection,
} from '../agent/orchestrator.js';
import { getProposal, cancelProposal } from '../agent/proposals.js';
import { applyProposal } from '../agent/proposalApply.js';

const conversation = []; // fica só na memória desta página (some ao fechar ou atualizar)

/** Texto simples com **negrito**, sempre escapado (nunca interpreta HTML vindo da IA). */
export function richText(text) {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

const PRESETS = ['mes_atual', 'mes_anterior', 'ultimos_30', 'ultimos_90', 'ano_atual', 'ultimo_com_dados'];

/** "Neste período" = o filtro que você usa no Painel. */
async function dashboardPeriod(db) {
  const saved = getSetting('dashboardPeriod');
  if (saved === 'ultimo_extrato') {
    const sp = statementPeriod(await db.getAll('imports'), await db.getAll('transactions'));
    return sp ? { start: sp.start, end: sp.end } : { preset: 'ultimo_com_dados' };
  }
  if (PRESETS.includes(saved)) return { preset: saved };
  const custom = getSetting('dashboardCustom');
  if (saved === 'personalizado' && custom?.start && custom?.end) return { start: custom.start, end: custom.end };
  return null;
}

export async function render(container, ctx) {
  container.innerHTML = '<div></div>';
  new AssistantView(container.firstElementChild, ctx.db).start();
}

class AssistantView {
  constructor(root, db) {
    this.root = root;
    this.db = db;
    this.busy = false;
    this.connection = null; // resultado do último "Testar conexão"
  }

  start() {
    this.draw();
    this.root.addEventListener('click', (e) => this.onClick(e));
    this.root.addEventListener('submit', (e) => this.onSubmit(e));
    this.root.addEventListener('change', (e) => this.onChange(e));
  }

  // ------------------------------------------------------------------ desenho
  draw() {
    const cfg = getAssistantConfig();
    this.root.innerHTML = `
      ${pageHeader('Assistente financeiro', 'Pergunte sobre os seus dados em linguagem natural')}
      ${this.statusHtml(cfg)}
      ${this.settingsHtml(cfg)}
      <section class="card chat-card" aria-label="Conversa">
        <div id="chat-log" class="chat-log" role="log" aria-live="polite" aria-relevant="additions">
          ${conversation.length ? conversation.map((m, i) => this.messageHtml(m, i)).join('') : this.welcomeHtml()}
        </div>
        <div id="chat-busy" class="chat-busy" role="status" hidden><span class="spinner small" aria-hidden="true"></span> <span id="busy-text"></span></div>
        <form id="chat-form" class="chat-form" autocomplete="off">
          <label class="sr-only" for="chat-input">Sua pergunta</label>
          <input id="chat-input" type="text" maxlength="400" placeholder="Ex.: Quanto gastei com alimentação neste mês?" ${this.busy ? 'disabled' : ''}>
          <button class="btn primary" type="submit" ${this.busy ? 'disabled' : ''}>Enviar</button>
        </form>
        <details class="chat-examples"><summary>Exemplos de perguntas</summary>
          <div class="chips-row">${EXAMPLE_QUESTIONS.map((q) => `<button type="button" class="chip-btn" data-ask="${escapeHtml(q)}">${escapeHtml(q)}</button>`).join('')}</div>
        </details>
        ${conversation.length ? '<div class="chat-tools"><button type="button" class="btn small" data-act="clear">Limpar conversa</button></div>' : ''}
      </section>`;
    const log = this.root.querySelector('#chat-log');
    log.scrollTop = log.scrollHeight;
  }

  statusHtml(cfg) {
    const ai = cfg.effectiveMode === 'llm';
    const host = ai ? new URL(cfg.endpoint).host : '';
    return `<section class="mode-banner ${ai ? 'ai' : 'local'}" aria-label="Modo do assistente">
      <span class="mode-badge">${ai ? `IA conectada · ${escapeHtml(host)}` : 'Modo local · sem IA generativa'}</span>
      <p>${ai
        ? 'As perguntas são interpretadas por um modelo de linguagem através do seu backend. Ele escolhe ferramentas; <strong>os cálculos são feitos aqui no app</strong>, com os seus dados.'
        : 'Respostas montadas por regras e consultas estruturadas aos seus dados. <strong>Não há inteligência artificial generativa</strong> neste modo; ele funciona sem internet.'}</p>
    </section>`;
  }

  settingsHtml(cfg) {
    return `<details class="card assistant-settings" ${cfg.mode === 'llm' && !cfg.endpointValid ? 'open' : ''}>
      <summary><strong>Configurações do assistente</strong> <span class="muted">(modo local ou IA conectada)</span></summary>
      <div class="settings-body">
        <fieldset class="mode-box">
          <legend>Modo de funcionamento</legend>
          <label class="check"><input type="radio" name="assistant-mode" value="local" ${cfg.mode === 'local' ? 'checked' : ''}> <span>Local <small>(sem IA generativa; padrão)</small></span></label>
          <label class="check"><input type="radio" name="assistant-mode" value="llm" ${cfg.mode === 'llm' ? 'checked' : ''} ${cfg.endpointValid ? '' : 'disabled'}>
            <span>IA conectada <small>${cfg.endpointValid ? '(usa o backend configurado abaixo)' : '(indisponível: configure um backend primeiro)'}</small></span></label>
        </fieldset>

        <form id="endpoint-form" class="form-grid single">
          <label class="field wide"><span>Endereço do backend de IA</span>
            <input id="endpoint-input" type="url" placeholder="https://seu-backend.exemplo.com" value="${escapeHtml(cfg.endpoint)}" autocomplete="off"></label>
          <div class="action-buttons wide">
            <button class="btn" type="submit">Salvar endereço</button>
            <button class="btn" type="button" data-act="test" ${cfg.endpointValid ? '' : 'disabled'}>Testar conexão</button>
            ${cfg.endpoint ? '<button class="btn danger-outline" type="button" data-act="remove-endpoint">Remover</button>' : ''}
          </div>
          <p id="settings-msg" class="settings-msg" role="status">${this.connectionHtml(cfg)}</p>
        </form>

        <div class="privacy-box">
          <strong>Privacidade e segurança</strong>
          <ul>
            <li>Este app <strong>não tem campo para chave de API</strong>, e nenhuma chave é guardada no navegador. A chave fica só no seu backend.</li>
            <li>Ao backend vão: o texto da conversa, a lista de ferramentas e os <strong>resultados resumidos</strong> das ferramentas. Nunca PDFs, extratos completos nem o banco de dados.</li>
            <li>O modelo só pode usar ferramentas de <strong>leitura</strong>. Alterar categorias exige o seu clique em "Confirmar".</li>
            <li>Sem backend configurado, a IA não está disponível: o app não finge que ela existe.</li>
          </ul>
        </div>
      </div>
    </details>`;
  }

  connectionHtml(cfg) {
    if (!cfg.endpoint) return 'Nenhum backend configurado. O modo IA conectada está indisponível.';
    if (!cfg.endpointValid) return 'O endereço salvo é inválido.';
    if (!this.connection) return 'Endereço salvo. Use "Testar conexão" para verificar se o backend responde.';
    return this.connection.ok
      ? `✓ Backend respondeu. Provedor: ${escapeHtml(this.connection.provider)}${this.connection.model ? ` · modelo: ${escapeHtml(this.connection.model)}` : ''}.`
      : `✕ Falha: ${escapeHtml(this.connection.message)}`;
  }

  welcomeHtml() {
    return `<div class="msg assistant"><div class="bubble">
      <p>Olá! Eu consulto os seus dados reais (transações, orçamentos, rendas e ciclos) e respondo com números calculados pelo app.</p>
      <p>Digite uma pergunta ou toque em um dos exemplos abaixo. Digite <strong>ajuda</strong> para ver tudo o que sei fazer.</p>
    </div></div>`;
  }

  messageHtml(m, index) {
    if (m.role === 'user') return `<div class="msg user"><div class="bubble">${escapeHtml(m.text)}</div></div>`;
    const r = m.reply;
    const badge = r.mode === 'ai'
      ? '<span class="msg-badge ai">Resposta da IA · cálculos feitos pelo app</span>'
      : '<span class="msg-badge local">Resposta do modo local · sem IA generativa</span>';
    return `<div class="msg assistant" data-msg="${index}"><div class="bubble">
      ${r.fallbackNotice ? `<p class="w atencao">${escapeHtml(r.fallbackNotice)}</p>` : ''}
      ${(r.paragraphs || []).map((p) => `<p>${richText(p)}</p>`).join('')}
      ${r.list ? `<ul class="plain-list">${r.list.map((q) => `<li><button type="button" class="link-btn" data-ask="${escapeHtml(q)}">${escapeHtml(q)}</button></li>`).join('')}</ul>` : ''}
      ${r.table ? this.tableHtml(r.table) : ''}
      ${(r.proposals || []).map((id) => this.proposalHtml(id)).join('')}
      ${(r.notes || []).length ? `<ul class="notes">${r.notes.map((n) => `<li>${richText(n)}</li>`).join('')}</ul>` : ''}
      ${this.sourcesHtml(r)}
      <div class="msg-foot">${badge}</div>
    </div></div>`;
  }

  tableHtml(t) {
    return `<div class="table-card chat-table"><table class="data-table">
      <thead><tr>${t.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
      <tbody>${t.rows.map((row) => `<tr>${row.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  sourcesHtml(r) {
    const tools = (r.tools || []).filter((t) => t.name);
    if (!tools.length) return '';
    const body = r.mode === 'ai'
      ? `<p class="micro">Estes foram os resultados enviados ao modelo (limitados em tamanho):</p>
         ${(r.dataViews || []).map((v) => `<div><strong>${escapeHtml(v.tool)}</strong>${v.table ? this.tableHtml(v.table) : `<p>${(v.paragraphs || []).map(richText).join(' ')}</p>`}</div>`).join('')}`
      : '<p class="micro">Consulta executada no seu navegador, somente leitura.</p>';
    return `<details class="sources"><summary>Dados consultados (${tools.map((t) => t.name).join(', ')})</summary>
      ${tools.map((t) => `<p class="micro mono">${escapeHtml(t.name)}(${escapeHtml(JSON.stringify(t.args))}) → ${t.ok ? 'ok' : 'erro'}</p>`).join('')}${body}</details>`;
  }

  proposalHtml(id) {
    const p = getProposal(id);
    if (!p) return '';
    const done = p.status !== 'pending';
    const label = { applied: '✓ Aplicada', cancelled: 'Cancelada' }[p.status];
    return `<div class="proposal" data-proposal="${escapeHtml(id)}">
      <strong>Proposta aguardando sua confirmação</strong>
      <p>Mover ${p.preview.transactions} transação(ões) para <strong>${escapeHtml(p.categoryName)}</strong>${p.remember ? ' e memorizar uma regra' : ''}.</p>
      ${done ? `<p class="proposal-status">${label}</p>` : `<div class="action-buttons">
        <button type="button" class="btn primary" data-act="confirm-proposal">Confirmar alteração</button>
        <button type="button" class="btn" data-act="cancel-proposal">Cancelar</button></div>`}
    </div>`;
  }

  // ------------------------------------------------------------------ perguntas
  setBusy(on, text = '') {
    this.busy = on;
    const el = this.root.querySelector('#chat-busy');
    el.hidden = !on;
    this.root.querySelector('#busy-text').textContent = text;
    this.root.querySelector('#chat-input').disabled = on;
    this.root.querySelector('#chat-form button').disabled = on;
  }

  async send(text) {
    const question = text.trim();
    if (!question || this.busy) return;
    conversation.push({ role: 'user', text: question });
    this.draw();
    const cfg = getAssistantConfig();
    this.setBusy(true, cfg.effectiveMode === 'llm' ? 'Consultando a IA e os seus dados…' : 'Consultando os seus dados…');
    const history = conversation.slice(0, -1).map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.role === 'user' ? m.text : (m.reply.paragraphs || []).join(' '),
    }));
    let reply;
    try {
      reply = await ask(question, { db: this.db, history, today: todayISO(), defaultPeriod: await dashboardPeriod(this.db) });
    } catch (error) {
      console.error(error);
      reply = { mode: 'local', paragraphs: [`Tive um problema ao consultar os dados: ${error.message}`], notes: [], tools: [], proposals: [] };
    }
    conversation.push({ role: 'assistant', reply });
    this.busy = false;
    this.draw();
    this.root.querySelector('#chat-input').focus();
  }

  async onSubmit(e) {
    e.preventDefault();
    if (e.target.id === 'chat-form') {
      const input = this.root.querySelector('#chat-input');
      const text = input.value;
      input.value = '';
      return this.send(text);
    }
    if (e.target.id === 'endpoint-form') {
      const msg = this.root.querySelector('#settings-msg');
      try {
        saveEndpoint(this.root.querySelector('#endpoint-input').value);
        this.connection = null;
        this.draw();
        this.root.querySelector('.assistant-settings').open = true;
      } catch (error) { msg.textContent = `✕ ${error.message}`; }
    }
    return undefined;
  }

  async onClick(e) {
    const ask1 = e.target.closest('[data-ask]');
    if (ask1) return this.send(ask1.dataset.ask);
    const btn = e.target.closest('[data-act]');
    if (!btn) return undefined;
    const act = btn.dataset.act;

    if (act === 'clear') { conversation.length = 0; return this.draw(); }

    if (act === 'test') {
      const msg = this.root.querySelector('#settings-msg');
      msg.textContent = 'Testando conexão…';
      try {
        const info = await testConnection();
        this.connection = { ok: true, ...info };
      } catch (error) { this.connection = { ok: false, message: error.message }; }
      this.draw();
      this.root.querySelector('.assistant-settings').open = true;
      return undefined;
    }
    if (act === 'remove-endpoint') { clearEndpoint(); this.connection = null; return this.draw(); }

    if (act === 'confirm-proposal' || act === 'cancel-proposal') {
      // Só um clique REAL do usuário vale; cliques simulados por scripts são ignorados.
      if (!e.isTrusted) return undefined;
      const id = btn.closest('[data-proposal]').dataset.proposal;
      if (act === 'cancel-proposal') { cancelProposal(id); return this.draw(); }
      try {
        const result = await applyProposal(this.db, id, { userConfirmed: true });
        conversation.push({ role: 'assistant', reply: { mode: 'local', paragraphs: [`Pronto: **${result.changed}** transação(ões) categorizada(s)${result.rules ? ` e ${result.rules} regra(s) memorizada(s)` : ''}. A correção ficou protegida contra sobrescrita automática.`], notes: [], tools: [], proposals: [] } });
      } catch (error) {
        conversation.push({ role: 'assistant', reply: { mode: 'local', paragraphs: [`Não foi possível aplicar: ${error.message}`], notes: [], tools: [], proposals: [] } });
      }
      return this.draw();
    }
    return undefined;
  }

  onChange(e) {
    if (e.target.name === 'assistant-mode') {
      try { setAssistantMode(e.target.value); } catch (error) { this.root.querySelector('#settings-msg').textContent = `✕ ${error.message}`; return; }
      this.draw();
      this.root.querySelector('.assistant-settings').open = true;
    }
  }
}
