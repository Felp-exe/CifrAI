// SKILL 1: Categorização.
// Identifica transações sem categoria, consulta as regras, sugere classificações, aponta possíveis
// erros e PROPÕE correções. Quem decide é o usuário: nenhuma ferramenta aqui altera dados.
// Reutiliza o motor de categorização da Etapa 3 (categorize / extractMerchant).
import { categorize } from '../../categorization/categorizer.js';
import { MATCH_TYPES } from '../../categorization/categorizer.js';
import { extractMerchant } from '../../categorization/merchant.js';
import { isExpense } from '../../dashboard/analytics.js';
import { money, ok, ToolError } from '../results.js';
import { findCategory } from '../snapshot.js';
import { createProposal } from '../proposals.js';

const catName = (s, id) => (id ? s.categoriesById.get(id)?.nome || id : null);
const merchantOf = (t) => t.merchantName || extractMerchant(t.originalDescription || t.normalizedName || '');
const idsOf = (s) => new Set(s.categories.map((c) => c.id));

function suggestionFor(s, t) {
  return categorize({ ...t, merchantName: merchantOf(t) }, s.rules, idsOf(s));
}

function txView(s, t, extra = {}) {
  return {
    id: t.id, date: t.date, description: t.originalDescription, amount: money(t.amount),
    current_category: catName(s, t.categoryId), status: t.status, protected_by_user: Boolean(t.manual), ...extra,
  };
}

const tools = [
  {
    name: 'get_pending_transactions',
    description: 'Transações pendentes de revisão/categorização, com a categoria atual e a sugestão automática.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 15 },
        only_uncategorized: { type: 'boolean', default: false, description: 'Só as que estão sem nenhuma categoria.' },
      },
    },
    handler(s, { limit, only_uncategorized }) {
      let pending = s.transactions.filter((t) => t.status === 'pendente');
      if (only_uncategorized) pending = pending.filter((t) => !t.categoryId);
      pending = pending.slice().sort((a, b) => b.date.localeCompare(a.date));
      const expenses = pending.filter(isExpense);
      return ok({
        pending_count: pending.length, pending_expense_total: money(expenses.reduce((sum, t) => sum + -t.amount, 0)),
        transactions: pending.slice(0, limit).map((t) => txView(s, t, {
          suggested_category: catName(s, t.suggestedCategoryId), confidence: t.confidence || null, reason: t.reason || null,
        })),
      }, pending.length ? [] : ['Nenhuma transação pendente de revisão.']);
    },
  },

  {
    name: 'suggest_categorization',
    description: 'Recalcula a sugestão de categoria (com motivo e confiança) para transações específicas ou para as pendentes. Não altera nada.',
    parameters: {
      type: 'object',
      properties: {
        transaction_ids: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 20 },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
      },
    },
    handler(s, { transaction_ids, limit }) {
      let targets;
      const notes = [];
      if (transaction_ids) {
        targets = transaction_ids.map((id) => s.transactions.find((t) => t.id === id)).filter(Boolean);
        const missing = transaction_ids.length - targets.length;
        if (missing) notes.push(`${missing} id(s) não correspondem a nenhuma transação.`);
      } else {
        targets = s.transactions.filter((t) => t.status === 'pendente' && !t.manual);
      }
      const rows = targets.slice(0, limit).map((t) => {
        const sug = suggestionFor(s, t);
        return txView(s, t, {
          suggestion: {
            category: catName(s, sug.categoryId), confidence: sug.confidence, reason: sug.reason,
            needs_review: sug.status === 'pendente',
          },
          differs_from_current: sug.categoryId !== t.categoryId,
          note: t.manual ? 'Categoria definida por você: o sistema não a altera sozinho.' : undefined,
        });
      });
      return ok({ count: rows.length, suggestions: rows }, [...notes, ...(rows.length ? ['Sugestões não são aplicadas. Para alterar, use propose_categorization e aguarde a confirmação do usuário.'] : ['Nada para sugerir.'])]);
    },
  },

  {
    name: 'find_categorization_issues',
    description: 'Aponta possíveis erros: mesmo estabelecimento em categorias diferentes, correção manual que contradiz uma regra forte, despesas sem categoria.',
    parameters: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 } } },
    handler(s, { limit }) {
      const issues = [];

      const byMerchant = new Map();
      for (const t of s.transactions) {
        if (!t.categoryId) continue;
        const key = merchantOf(t);
        if (!key) continue;
        if (!byMerchant.has(key)) byMerchant.set(key, new Map());
        const m = byMerchant.get(key);
        m.set(t.categoryId, (m.get(t.categoryId) || 0) + 1);
      }
      for (const [merchant, cats] of byMerchant) {
        if (cats.size >= 2) {
          issues.push({
            type: 'inconsistent_merchant', merchant,
            categories: [...cats].map(([id, count]) => ({ category: catName(s, id), transactions: count })),
            hint: 'O mesmo estabelecimento aparece em categorias diferentes. Pode ser legítimo ou um erro.',
          });
        }
      }

      for (const t of s.transactions.filter((x) => x.manual && x.categoryId)) {
        const sug = suggestionFor(s, t);
        if (sug.confidence === 'alta' && sug.categoryId && sug.categoryId !== t.categoryId && sug.categorySource.startsWith('regra')) {
          issues.push({
            type: 'manual_vs_rule', ...txView(s, t),
            rule_suggests: catName(s, sug.categoryId), reason: sug.reason,
            hint: 'Você escolheu uma categoria diferente da que a regra indicaria. Pode ser proposital.',
          });
        }
      }

      const uncategorized = s.transactions.filter((t) => isExpense(t) && !t.categoryId);
      const lowConfidence = s.transactions.filter((t) => !t.manual && t.status === 'pendente' && t.categoryId && t.confidence === 'baixa');
      const counts = {
        inconsistent_merchants: issues.filter((i) => i.type === 'inconsistent_merchant').length,
        manual_vs_rule: issues.filter((i) => i.type === 'manual_vs_rule').length,
        uncategorized_expenses: uncategorized.length,
        low_confidence_pending: lowConfidence.length,
      };
      return ok({
        counts, uncategorized_total: money(uncategorized.reduce((sum, t) => sum + -t.amount, 0)),
        issues: issues.slice(0, limit),
      }, Object.values(counts).some(Boolean) ? [] : ['Nenhum problema de categorização encontrado.']);
    },
  },

  {
    name: 'get_categorization_rules',
    description: 'Regras de categorização existentes (iniciais e do usuário).',
    parameters: {
      type: 'object',
      properties: {
        origin: { type: 'string', enum: ['usuario', 'inicial'] },
        only_active: { type: 'boolean', default: false },
      },
    },
    handler(s, { origin, only_active }) {
      const rules = s.rules.filter((r) => (!origin || r.origem === origin) && (!only_active || r.ativa !== false));
      return ok({
        count: rules.length,
        rules: rules.slice(0, 50).map((r) => ({
          pattern: r.pattern, match: MATCH_TYPES[r.matchType] || r.matchType,
          category: r.categoryId === null ? '(vai para revisão)' : catName(s, r.categoryId),
          origin: r.origem, active: r.ativa !== false,
        })),
      }, ['Regras do usuário têm prioridade sobre as iniciais.']);
    },
  },

  {
    name: 'propose_categorization',
    description: 'PROPÕE mudar a categoria de transações. NÃO altera nada: cria uma proposta que o usuário precisa confirmar na tela. Avise o usuário que a confirmação é necessária.',
    parameters: {
      type: 'object',
      required: ['transaction_ids', 'category'],
      properties: {
        transaction_ids: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, maxItems: 50 },
        category: { type: 'string', maxLength: 40 },
        remember: { type: 'boolean', default: false, description: 'Criar também uma regra para o estabelecimento (memorizar).' },
      },
    },
    handler(s, { transaction_ids, category, remember }) {
      const cat = findCategory(s, category);
      if (!cat) throw new ToolError('unknown_category', `Não existe a categoria "${category}".`, { valid_categories: s.categories.map((c) => c.nome) });
      const ids = [...new Set(transaction_ids)];
      const txs = ids.map((id) => s.transactions.find((t) => t.id === id));
      const unknown = ids.filter((_, i) => !txs[i]);
      if (unknown.length) throw new ToolError('unknown_transactions', `Transações inexistentes: ${unknown.join(', ')}.`, { unknown_ids: unknown });

      const alreadyThere = txs.filter((t) => t.categoryId === cat.id).length;
      const preview = {
        transactions: txs.length, category: cat.nome, already_in_category: alreadyThere,
        will_change: txs.length - alreadyThere,
        user_corrected_that_will_change: txs.filter((t) => t.manual && t.categoryId !== cat.id).length,
        rule_would_be_created_for: remember ? [...new Set(txs.map(merchantOf).filter((m) => m.length >= 3))] : [],
        total_amount: money(txs.reduce((sum, t) => sum + t.amount, 0)),
      };
      const proposal = createProposal({ transactionIds: ids, categoryId: cat.id, categoryName: cat.nome, remember, preview });
      return ok({
        proposal_id: proposal.id, requires_user_confirmation: true, applied: false, preview,
      }, ['NADA foi alterado. O usuário precisa clicar em "Confirmar" na tela para aplicar esta proposta.']);
    },
  },
];

export default {
  id: 'categorizacao',
  name: 'Categorização de transações',
  description: 'Identifica transações sem categoria, consulta regras, sugere classificações, aponta possíveis erros e propõe correções (aplicadas só com confirmação).',
  tools,
};
