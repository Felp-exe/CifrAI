// Registro e execução das ferramentas do agente.
//
// REGRAS DE SEGURANÇA (garantidas aqui):
//  - só existem as ferramentas declaradas nas skills; qualquer outro nome é recusado;
//  - todos os parâmetros são validados contra o esquema antes de executar;
//  - as ferramentas recebem uma FOTOGRAFIA somente leitura dos dados, nunca o banco;
//  - nenhuma ferramenta grava dados. Mudanças só acontecem por "propostas" que o usuário confirma na tela;
//  - erros internos nunca vazam detalhes: voltam como { ok: false, error }.
import { SKILLS } from './skills/index.js';
import { validateParams } from './validate.js';
import { fail, ToolError } from './results.js';

export const TOOLS = new Map();
for (const skill of SKILLS) {
  for (const tool of skill.tools) {
    if (TOOLS.has(tool.name)) throw new Error(`Ferramenta duplicada: ${tool.name}`);
    TOOLS.set(tool.name, { ...tool, skill: skill.id });
  }
}

/** Definições que podem ser enviadas ao modelo: nome, descrição e esquema de parâmetros (nunca o código). */
export function publicToolDefinitions() {
  return [...TOOLS.values()].map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    read_only: true,
  }));
}

/**
 * Executa UMA chamada de ferramenta. Nunca lança erro.
 * @returns {{ok:true,data,notes}|{ok:false,error:{code,message}}}
 */
export function executeToolCall(snapshot, name, args) {
  const tool = typeof name === 'string' ? TOOLS.get(name) : undefined;
  if (!tool) {
    return fail('unknown_tool', `A ferramenta "${String(name).slice(0, 60)}" não existe. Ferramentas disponíveis: ${[...TOOLS.keys()].join(', ')}.`);
  }
  const validation = validateParams(tool.parameters, args);
  if (!validation.ok) return fail('invalid_parameters', `Parâmetros inválidos para ${name}: ${validation.errors.join('; ')}`, { details: validation.errors });
  try {
    return tool.handler(snapshot, validation.value);
  } catch (error) {
    if (error instanceof ToolError) return fail(error.code, error.message, error.extra);
    console.error(`Erro interno na ferramenta ${name}`, error);
    return fail('internal_error', 'Erro interno ao executar a ferramenta.');
  }
}

/**
 * Prepara o resultado para ir ao modelo: limita o tamanho (privacidade e custo).
 * Listas muito longas são cortadas e o resultado ganha "truncated: true".
 */
export function sanitizeForModel(result, maxChars = 12000) {
  if (JSON.stringify(result).length <= maxChars) return result;
  const copy = JSON.parse(JSON.stringify(result));
  const shrink = (node) => {
    let changed = false;
    for (const key of Object.keys(node || {})) {
      const v = node[key];
      if (Array.isArray(v) && v.length > 5) { node[key] = v.slice(0, Math.ceil(v.length / 2)); changed = true; }
      else if (v && typeof v === 'object') changed = shrink(v) || changed;
    }
    return changed;
  };
  while (JSON.stringify(copy).length > maxChars && shrink(copy.data ?? copy)) { /* corta até caber */ }
  copy.truncated = true;
  return copy;
}
