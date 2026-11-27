// Regras de categorização guardadas no banco (tabela "rules").
// Regras do usuário: criar, editar, ativar/desativar, excluir.
// Regras iniciais do sistema: só podem ser ativadas/desativadas (para nunca perder o padrão).
import { normalizeText } from '../utils/format.js';
import { MATCH_TYPES } from './categorizer.js';

export async function listRules(db) {
  return db.getAll('rules');
}

async function validate(db, { pattern, matchType, categoryId }) {
  const p = normalizeText(pattern);
  if (!p) throw new Error('Digite o texto da regra.');
  if (!(matchType in MATCH_TYPES)) throw new Error('Tipo de correspondência inválido.');
  if (categoryId !== null && !(await db.get('categories', categoryId))) {
    throw new Error('A categoria escolhida não existe.');
  }
  return p;
}

export async function createRule(db, { pattern, matchType, categoryId, observacao = '' }) {
  const p = await validate(db, { pattern, matchType, categoryId });
  const all = await db.getAll('rules');
  if (all.some((r) => r.origem === 'usuario' && normalizeText(r.pattern) === p && r.matchType === matchType)) {
    throw new Error('Você já tem uma regra igual (mesmo texto e mesmo tipo). Edite a existente.');
  }
  const rule = { pattern: p, matchType, categoryId, origem: 'usuario', ativa: true, observacao, createdAt: new Date().toISOString() };
  rule.id = await db.add('rules', rule);
  return rule;
}

export async function updateRule(db, id, { pattern, matchType, categoryId, observacao }) {
  const rule = await db.get('rules', id);
  if (!rule) throw new Error('Regra não encontrada.');
  if (rule.origem !== 'usuario') throw new Error('Regras iniciais não podem ser editadas (apenas desativadas).');
  const p = await validate(db, { pattern, matchType, categoryId });
  const all = await db.getAll('rules');
  if (all.some((r) => r.id !== id && r.origem === 'usuario' && normalizeText(r.pattern) === p && r.matchType === matchType)) {
    throw new Error('Já existe outra regra igual.');
  }
  const updated = { ...rule, pattern: p, matchType, categoryId, observacao: observacao ?? rule.observacao };
  await db.put('rules', updated);
  return updated;
}

export async function setRuleActive(db, id, ativa) {
  const rule = await db.get('rules', id);
  if (!rule) throw new Error('Regra não encontrada.');
  await db.put('rules', { ...rule, ativa: Boolean(ativa) });
}

export async function deleteRule(db, id) {
  const rule = await db.get('rules', id);
  if (!rule) return;
  if (rule.origem !== 'usuario') throw new Error('Regras iniciais não podem ser excluídas (apenas desativadas).');
  await db.delete('rules', id);
}

/**
 * "Memoriza" uma correção: cria (ou atualiza) uma regra do usuário de nome exato para o estabelecimento.
 * Retorna a regra, ou null se o nome for curto/genérico demais para virar regra.
 */
export async function rememberMerchant(db, merchant, categoryId) {
  const name = normalizeText(merchant);
  if (name.length < 3) return null;
  const all = await db.getAll('rules');
  const existing = all.find((r) => r.origem === 'usuario' && r.matchType === 'exact' && normalizeText(r.pattern) === name);
  if (existing) {
    const updated = { ...existing, categoryId, ativa: true };
    await db.put('rules', updated);
    return updated;
  }
  return createRule(db, {
    pattern: name, matchType: 'exact', categoryId, observacao: 'Memorizada de uma correção manual.',
  });
}
