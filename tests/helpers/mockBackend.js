// APENAS PARA TESTES: um "backend de IA" falso, para testar o cliente e o laço de ferramentas SEM usar
// nenhum LLM real, sem internet e sem chave. Ele NÃO é o backend de produção e não está em js/.
//
// `fakeLlm` imita o comportamento de um modelo: escolhe uma ferramenta pela pergunta e, quando recebe
// os resultados, escreve uma resposta usando SOMENTE valores que vieram nos resultados.

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Junta os textos "brl" encontrados dentro de um JSON (o "modelo" só repete o que as ferramentas devolveram). */
function collectBrl(node, out = []) {
  if (node && typeof node === 'object') {
    if (typeof node.brl === 'string') out.push(node.brl);
    Object.values(node).forEach((v) => collectBrl(v, out));
  }
  return out;
}

/** Modelo falso: pergunta → pedido de ferramenta; resultados → resposta final com os valores recebidos. */
export function fakeLlm(body) {
  const last = body.messages[body.messages.length - 1];
  if (last.role === 'tool') {
    const results = body.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
    const failed = results.find((r) => !r.ok);
    if (failed) return { type: 'message', content: `Não consegui consultar: ${failed.error.message}` };
    const values = results.flatMap((r) => collectBrl(r.data));
    return { type: 'message', content: values.length ? `Pelos seus dados: ${values.slice(0, 2).join(' e ')}.` : 'Os dados consultados não trazem valores.' };
  }
  const q = String(last.content).toLowerCase();
  const call = (name, args) => ({ type: 'tool_calls', calls: [{ id: `call_${name}`, name, arguments: args }] });
  if (q.includes('alimenta')) return call('get_expenses_by_category', { category: 'Alimentação', period: { preset: 'mes_atual' } });
  if (q.includes('orçamento') || q.includes('orcamento')) return call('get_budget_status', {});
  if (q.includes('apagar')) return call('delete_all_transactions', {});
  if (q.includes('aplicar')) return call('apply_categorization', { transaction_ids: [1], category: 'Saúde' });
  if (q.includes('parametro-ruim')) return call('get_expenses_by_category', { limit: 9999, extra: true });
  if (q.includes('propor')) return call('propose_categorization', { transaction_ids: [8], category: 'Saúde' });
  return { type: 'message', content: 'Posso ajudar com suas finanças.' };
}

/**
 * Cria uma função `fetch` falsa.
 * @param handler (path, body) => objeto de resposta | Response | lança erro
 * @returns { fetchImpl, requests } — `requests` guarda tudo o que o app enviou.
 */
export function createMockFetch(handler = (path, body) => (path === '/v1/health'
  ? { ok: true, protocolVersion: 1, provider: 'mock', model: 'modelo-de-teste' } : fakeLlm(body))) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ url, path, method: init.method, headers: init.headers, credentials: init.credentials, body, rawBody: init.body || '' });
    // como o fetch de verdade: se o app cancelar (tempo esgotado), a chamada falha com AbortError
    const aborted = new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
    const out = await Promise.race([Promise.resolve(handler(path, body)), aborted]);
    return out instanceof Response ? out : jsonResponse(out);
  };
  return { fetchImpl, requests };
}
