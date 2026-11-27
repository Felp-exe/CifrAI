// Motor de categorização: funções PURAS (não mexem no banco), fáceis de testar.
//
// Como funciona, em ordem:
//  1. Regras do USUÁRIO vencem as regras INICIAIS do sistema.
//  2. Dentro de cada grupo, vence a regra mais específica: primeiro o nome EXATO; depois o texto MAIS LONGO
//     (ex.: "99 pop" vence "99"; um nome completo vence "farma"); só então o tipo de comparação.
//     Regras podem ter variações (alternatives: "livepix" para "live pix") e marcar "aproximar: false"
//     para nunca serem sugeridas por semelhança.
//  3. Primeiro tentamos correspondência exata de texto. Se nada combinar, tentamos correspondência
//     APROXIMADA (tolera 1 letra errada, ex.: "ifod" ~ "ifood"). Aproximada = confiança média,
//     e a transação fica pendente para você confirmar.
//  4. Sem regra: entrada de dinheiro não recebe categoria de gasto; saída desconhecida vira "Outros"
//     com confiança baixa e fica pendente de revisão.
import { normalizeText } from '../utils/format.js';
import { extractMerchant } from './merchant.js';

export const MATCH_TYPES = {
  contains: 'Contém o texto',
  word: 'Contém a palavra inteira',
  startsWith: 'Começa com',
  exact: 'Nome exato do estabelecimento',
};

const ORIGIN_RANK = { usuario: 0, inicial: 1 };
const TYPE_RANK = { exact: 0, startsWith: 1, word: 2, contains: 3 };

const hasWord = (text, word) => ` ${text} `.includes(` ${word} `);

/**
 * "Contém": o texto aparece dentro da descrição. Padrões que começam com NÚMERO (ex.: "99 negocia")
 * não podem estar no meio de outro número ("1999 negocia" não vale).
 */
function containsAt(text, pattern) {
  let from = 0;
  for (;;) {
    const at = text.indexOf(pattern, from);
    if (at === -1) return false;
    if (!/\d/.test(pattern[0]) || at === 0 || !/[a-z0-9]/.test(text[at - 1])) return true;
    from = at + 1;
  }
}

/**
 * Textos usados na comparação: descrição normalizada inteira e nome do estabelecimento.
 */
export function buildTarget(tx) {
  const text = normalizeText(tx.normalizedName || tx.originalDescription || '');
  const merchant = tx.merchantName || extractMerchant(tx.originalDescription || text);
  return { text, merchant };
}

/** Palavras curtas (até 4 letras, ex.: "uber", "99") só valem como palavra inteira, para não
 *  confundir "UBER" com "UBERLANDIA". */
function effectiveType(rule, pattern) {
  // regras com "substring: true" (ex.: FUPE) valem como texto solto mesmo sendo curtas
  if (rule.matchType === 'contains' && pattern.length <= 4 && !pattern.includes(' ') && !rule.substring) return 'word';
  return rule.matchType;
}

/** Todos os textos que uma regra reconhece: o principal e as variações (ex.: "livepix" para "live pix"). */
const patternsOf = (rule) => [rule.pattern, ...(rule.alternatives || [])].map(normalizeText).filter(Boolean);

export function strictMatch(rule, target) {
  const { text, merchant } = target;
  return patternsOf(rule).some((p) => {
    switch (effectiveType(rule, p)) {
      case 'exact': return merchant === p || text === p;
      case 'startsWith': return merchant.startsWith(p) || text.startsWith(p);
      case 'word': return hasWord(text, p) || hasWord(merchant, p);
      default: return containsAt(text, p) || containsAt(merchant, p);
    }
  });
}

function levenshtein(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = temp;
    }
  }
  return prev[b.length];
}

/**
 * Correspondência aproximada: só para padrões de uma palavra com 5+ letras, tolerando UMA letra
 * diferente. A primeira letra precisa ser igual: digitação errada raramente erra a primeira letra,
 * e isso evita falsos positivos como "FOOD" (iFood), "MEETA" ou "BEETA" (Keeta).
 */
export function approxMatch(rule, target) {
  if (rule.aproximar === false) return false; // regras marcadas como precisas nunca "adivinham"
  const p = normalizeText(rule.pattern);
  if (p.length < 5 || p.includes(' ')) return false;
  if (rule.matchType !== 'contains' && rule.matchType !== 'word') return false;
  const tokens = `${target.text} ${target.merchant}`.split(' ').filter(Boolean);
  return tokens.some((t) => t[0] === p[0] && Math.abs(t.length - p.length) <= 1 && levenshtein(t, p) === 1);
}

export function sortRules(rules) {
  return rules
    .filter((r) => r.ativa !== false)
    .slice()
    .sort((a, b) =>
      (ORIGIN_RANK[a.origem] ?? 1) - (ORIGIN_RANK[b.origem] ?? 1)
      || (b.matchType === 'exact') - (a.matchType === 'exact')                              // nome exato é o mais específico
      || normalizeText(b.pattern).length - normalizeText(a.pattern).length                   // depois, o texto mais longo (mais específico)
      || TYPE_RANK[a.matchType] - TYPE_RANK[b.matchType]
      || (a.id ?? 0) - (b.id ?? 0));
}

const sourceOf = (rule) => (rule.origem === 'usuario' ? 'regra_usuario' : 'regra_inicial');

function describe(rule, how) {
  const who = rule.origem === 'usuario' ? 'sua regra' : 'regra inicial';
  return `${how} ${who} "${normalizeText(rule.pattern)}"`;
}

/**
 * Decide a categoria de UMA transação.
 * @param tx { originalDescription, normalizedName, merchantName?, amount }
 * @param rules lista de regras do banco
 * @param categoryIds Set com os ids de categorias existentes
 * @returns campos de classificação (nunca mexe em data, valor ou descrição)
 */
export function categorize(tx, rules, categoryIds) {
  const target = buildTarget(tx);
  const ordered = sortRules(rules);
  const usable = (rule) => rule.categoryId === null || categoryIds.has(rule.categoryId);

  for (const rule of ordered) {
    if (!usable(rule) || !strictMatch(rule, target)) continue;
    if (rule.categoryId === null) {
      return {
        categoryId: null, status: 'pendente', categorySource: sourceOf(rule), confidence: 'baixa',
        reason: `${describe(rule, 'Casou com')}: ${rule.observacao || 'enviada para revisão manual'}`,
        ruleId: rule.id ?? null, suggestedCategoryId: null,
      };
    }
    return {
      categoryId: rule.categoryId, status: 'classificada', categorySource: sourceOf(rule), confidence: 'alta',
      reason: describe(rule, 'Casou com'), ruleId: rule.id ?? null, suggestedCategoryId: rule.categoryId,
    };
  }

  for (const rule of ordered) {
    if (!usable(rule) || rule.categoryId === null || !approxMatch(rule, target)) continue;
    return {
      categoryId: rule.categoryId, status: 'pendente', categorySource: sourceOf(rule), confidence: 'media',
      reason: `${describe(rule, 'Parecido com')} (correspondência aproximada). Confirme se está certo.`,
      ruleId: rule.id ?? null, suggestedCategoryId: rule.categoryId,
    };
  }

  if (tx.amount > 0) {
    return {
      categoryId: null, status: 'classificada', categorySource: 'entrada', confidence: 'alta',
      reason: 'Entrada de dinheiro: não recebe categoria de gasto (você pode escolher uma, se quiser).',
      ruleId: null, suggestedCategoryId: null,
    };
  }
  return {
    categoryId: categoryIds.has('outros') ? 'outros' : null, status: 'pendente',
    categorySource: 'desconhecido', confidence: 'baixa',
    reason: 'Estabelecimento desconhecido: colocado em "Outros" até você revisar.',
    ruleId: null, suggestedCategoryId: categoryIds.has('outros') ? 'outros' : null,
  };
}

/**
 * Aplica o resultado a uma transação SEM tocar nos dados originais.
 * Correções manuais (manual === true) nunca são sobrescritas.
 */
export function applyCategorization(tx, result, now = new Date().toISOString()) {
  const merchantName = tx.merchantName || extractMerchant(tx.originalDescription || tx.normalizedName || '');
  if (tx.manual) return tx.merchantName ? tx : { ...tx, merchantName };
  return { ...tx, ...result, merchantName, categorizedAt: now };
}
