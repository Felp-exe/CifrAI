// Cliente do BACKEND de IA (camada independente do provedor de LLM).
//
// O navegador NUNCA fala direto com um provedor (OpenAI, Anthropic, Google...). Ele fala com um
// backend seu, que guarda a chave de API em segredo e conversa com o provedor. Este arquivo:
//  - NÃO tem chaves, tokens ou cabeçalhos de autorização;
//  - só aceita endereços https:// (ou http://localhost, para testes), sem usuário/senha e sem "?parâmetros";
//  - valida TODA resposta do backend antes de usá-la (o backend é "não confiável" para o app);
//  - tem tempo limite e erros claros.
// O contrato completo está em docs/API-BACKEND.md.
export const PROTOCOL_VERSION = 1;
export const LIMITS = { maxToolCallsPerStep: 5, maxMessageChars: 8000, maxIdChars: 64, timeoutMs: 30000 };

export class BackendError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BackendError';
    this.code = code;
  }
}

/** Valida e normaliza o endereço do backend. Devolve a URL sem barra no final. */
export function normalizeEndpoint(input) {
  let url;
  try { url = new URL(String(input || '').trim()); } catch { throw new BackendError('invalid_endpoint', 'Endereço inválido. Exemplo: https://meu-backend.exemplo.com'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new BackendError('insecure_endpoint', 'Use um endereço https:// (http:// só é aceito para localhost, em testes).');
  }
  if (url.username || url.password) throw new BackendError('invalid_endpoint', 'O endereço não pode conter usuário ou senha.');
  if (url.search || url.hash) throw new BackendError('invalid_endpoint', 'O endereço não pode ter "?parâmetros" nem "#": nunca coloque chaves ou tokens na URL.');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

/** Confere se a resposta do backend segue o contrato. Lança BackendError se não seguir. */
export function validateTurnResponse(body) {
  const bad = (msg) => { throw new BackendError('invalid_response', `Resposta do backend fora do contrato: ${msg}`); };
  if (!body || typeof body !== 'object' || Array.isArray(body)) bad('não é um objeto JSON.');
  if (body.type === 'message') {
    if (typeof body.content !== 'string' || !body.content.trim()) bad('"content" deve ser um texto não vazio.');
    if (body.content.length > LIMITS.maxMessageChars) bad('mensagem longa demais.');
    return { type: 'message', content: body.content, usage: typeof body.usage === 'object' ? body.usage : undefined };
  }
  if (body.type === 'tool_calls') {
    if (!Array.isArray(body.calls) || !body.calls.length) bad('"calls" deve ser uma lista não vazia.');
    if (body.calls.length > LIMITS.maxToolCallsPerStep) bad(`mais de ${LIMITS.maxToolCallsPerStep} chamadas de ferramenta de uma vez.`);
    const calls = body.calls.map((c, i) => {
      if (!c || typeof c !== 'object') bad(`chamada ${i} inválida.`);
      if (typeof c.id !== 'string' || !c.id || c.id.length > LIMITS.maxIdChars) bad(`chamada ${i}: "id" inválido.`);
      if (typeof c.name !== 'string' || !c.name || c.name.length > 80) bad(`chamada ${i}: "name" inválido.`);
      const args = c.arguments === undefined ? {} : c.arguments;
      if (!args || typeof args !== 'object' || Array.isArray(args)) bad(`chamada ${i}: "arguments" deve ser um objeto.`);
      return { id: c.id, name: c.name, arguments: args };
    });
    return { type: 'tool_calls', calls, usage: typeof body.usage === 'object' ? body.usage : undefined };
  }
  return bad('"type" deve ser "message" ou "tool_calls".');
}

export class AgentBackendClient {
  /**
   * @param endpoint endereço do backend
   * @param fetchImpl função fetch (injetável para testes)
   */
  constructor(endpoint, { fetchImpl = (...a) => globalThis.fetch(...a), timeoutMs = LIMITS.timeoutMs } = {}) {
    this.endpoint = normalizeEndpoint(endpoint);
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async #request(path, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetch(this.endpoint + path, { ...init, credentials: 'omit', signal: controller.signal });
    } catch (error) {
      if (error?.name === 'AbortError') throw new BackendError('timeout', 'O backend demorou demais para responder.');
      throw new BackendError('network', 'Não consegui falar com o backend (rede, CORS ou servidor desligado).');
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new BackendError('http_error', `O backend respondeu com erro ${response.status}.`);
    try { return await response.json(); } catch { throw new BackendError('invalid_response', 'O backend não devolveu um JSON válido.'); }
  }

  /** Testa se o backend está de pé e fala o mesmo protocolo. */
  async health() {
    const body = await this.#request('/v1/health', { method: 'GET', headers: { Accept: 'application/json' } });
    if (!body || body.ok !== true) throw new BackendError('invalid_response', 'O backend respondeu, mas não confirmou que está pronto.');
    if (body.protocolVersion !== PROTOCOL_VERSION) throw new BackendError('protocol_mismatch', `Versão de protocolo incompatível (backend: ${body.protocolVersion}, app: ${PROTOCOL_VERSION}).`);
    return { provider: typeof body.provider === 'string' ? body.provider.slice(0, 40) : 'desconhecido', model: typeof body.model === 'string' ? body.model.slice(0, 60) : null };
  }

  /** Envia a conversa e as ferramentas; devolve a resposta já validada. */
  async turn({ sessionId, messages, tools, today }) {
    const body = await this.#request('/v1/agent/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION, sessionId, locale: 'pt-BR', currency: 'BRL', today,
        limits: { maxToolCallsPerStep: LIMITS.maxToolCallsPerStep }, messages, tools,
      }),
    });
    return validateTurnResponse(body);
  }
}
