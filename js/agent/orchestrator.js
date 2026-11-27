// Orquestrador do assistente: decide entre MODO LOCAL e MODO IA CONECTADA.
//
//  - Modo local (padrão): regras locais, sem IA generativa. Funciona sem internet e sem configuração.
//  - Modo IA conectada: só fica ativo se você configurou o endereço de um backend. Se o backend falhar,
//    a resposta é gerada pelo modo local e a mensagem diz CLARAMENTE que a IA não respondeu.
// Nada aqui grava no banco: o orquestrador só LÊ (loadSnapshot). Alterações só por proposta + confirmação.
import { getSetting, setSetting } from '../storage.js';
import { loadSnapshot } from './snapshot.js';
import { answerLocally } from './localAgent.js';
import { runAiTurn } from './llm/aiAgent.js';
import { AgentBackendClient, BackendError, normalizeEndpoint } from './llm/backendClient.js';
import { formatToolResult } from './formatters.js';

/** Configuração atual. `effectiveMode` é o que realmente será usado. */
export function getAssistantConfig() {
  const endpoint = getSetting('llmEndpoint') || '';
  let endpointValid = false;
  if (endpoint) { try { normalizeEndpoint(endpoint); endpointValid = true; } catch { /* inválido */ } }
  const mode = getSetting('assistantMode') === 'llm' ? 'llm' : 'local';
  return { mode, endpoint, endpointValid, effectiveMode: mode === 'llm' && endpointValid ? 'llm' : 'local' };
}

/** Salva o endereço do backend (validado). A chave de API NÃO é salva em lugar nenhum do app. */
export function saveEndpoint(url) {
  const normalized = normalizeEndpoint(url);
  setSetting('llmEndpoint', normalized);
  return normalized;
}

export function clearEndpoint() {
  setSetting('llmEndpoint', '');
  setSetting('assistantMode', 'local');
}

export function setAssistantMode(mode) {
  if (mode === 'llm' && !getAssistantConfig().endpointValid) {
    throw new BackendError('not_configured', 'Configure o endereço do backend antes de ativar a IA conectada.');
  }
  setSetting('assistantMode', mode === 'llm' ? 'llm' : 'local');
}

export async function testConnection(options = {}) {
  const cfg = getAssistantConfig();
  if (!cfg.endpointValid) throw new BackendError('not_configured', 'Nenhum backend configurado.');
  return new AgentBackendClient(cfg.endpoint, options).health();
}

function splitParagraphs(text) {
  return String(text).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
}

/**
 * Responde uma pergunta do usuário.
 * @param options { db, history, today, defaultPeriod, fetchImpl, sessionId }
 * @returns mensagem do assistente: { mode: 'local'|'ai', paragraphs, table?, list?, notes, tools, proposals, ... }
 */
export async function ask(text, { db, history = [], today, defaultPeriod = null, fetchImpl, sessionId } = {}) {
  const snapshot = await loadSnapshot(db, { today, defaultPeriod });
  const cfg = getAssistantConfig();
  let fallbackReason = null;

  if (cfg.effectiveMode === 'llm') {
    try {
      const client = new AgentBackendClient(cfg.endpoint, fetchImpl ? { fetchImpl } : {});
      const ai = await runAiTurn({ client, text, history, snapshot, sessionId });
      const dataViews = ai.trace.filter((t) => t.ok).map((t) => ({ tool: t.name, ...formatToolResult(t.name, t.result, t.args) }));
      return {
        mode: 'ai', paragraphs: splitParagraphs(ai.content), notes: [], tools: ai.trace, dataViews, sentToModel: ai.sentToModel,
        proposals: ai.trace.filter((t) => t.name === 'propose_categorization' && t.ok).map((t) => t.result.data.proposal_id),
      };
    } catch (error) {
      fallbackReason = error instanceof BackendError ? error.message : 'Erro inesperado ao usar a IA.';
      if (!(error instanceof BackendError)) console.error(error);
    }
  }

  const local = await answerLocally(text, { snapshot });
  const notice = fallbackReason
    ? `A IA conectada não respondeu (${fallbackReason}) Esta resposta foi gerada pelo modo local, sem IA generativa.`
    : (cfg.mode === 'llm' ? 'O modo IA está selecionado, mas o backend não está configurado: resposta do modo local.' : null);
  return { ...local, mode: 'local', fallbackReason, fallbackNotice: notice };
}
