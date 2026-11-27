// Laço de "tool calling" (modo IA conectada):
//   usuário → backend/LLM → [pede ferramenta] → executamos AQUI, em JavaScript, sobre a fotografia
//   somente leitura dos dados → enviamos só o resultado resumido → LLM → resposta final.
//
// O LLM nunca calcula nada: ele só escolhe ferramentas e explica os resultados que elas devolvem.
// Privacidade: ao backend vão apenas (1) o texto da conversa, (2) a lista de ferramentas e
// (3) os RESULTADOS das ferramentas (limitados em tamanho). Nunca PDFs, nunca o banco de dados.
import { publicToolDefinitions, executeToolCall, sanitizeForModel } from '../tools.js';
import { BackendError } from './backendClient.js';

export const MAX_STEPS = 5;
const MAX_HISTORY = 12;

/**
 * @param client AgentBackendClient
 * @param text pergunta do usuário
 * @param history mensagens anteriores [{ role: 'user'|'assistant', content }]
 * @param snapshot fotografia somente leitura dos dados
 * @returns {{ content, trace: Array, sentToModel: Array }} (lança BackendError se o backend falhar)
 */
export async function runAiTurn({ client, text, history = [], snapshot, sessionId = 'sessao' }) {
  const tools = publicToolDefinitions();
  const messages = [
    ...history.slice(-MAX_HISTORY).map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) })),
    { role: 'user', content: String(text).slice(0, 1000) },
  ];
  const trace = [];
  const sentToModel = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await client.turn({ sessionId, messages, tools, today: snapshot.today });

    if (response.type === 'message') return { content: response.content, trace, sentToModel };

    messages.push({ role: 'assistant', tool_calls: response.calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })) });
    for (const call of response.calls) {
      // A mesma execução segura do modo local: ferramenta desconhecida ou parâmetro inválido → erro estruturado.
      const result = executeToolCall(snapshot, call.name, call.arguments);
      const forModel = sanitizeForModel(result);
      trace.push({ name: call.name, args: call.arguments, ok: result.ok, result });
      sentToModel.push({ tool: call.name, result: forModel });
      messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: JSON.stringify(forModel) });
    }
  }
  throw new BackendError('too_many_steps', `O modelo pediu ferramentas ${MAX_STEPS} vezes seguidas sem responder. Interrompi para evitar um laço.`);
}
