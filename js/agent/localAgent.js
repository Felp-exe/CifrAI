// MODO LOCAL (sem IA generativa).
// Entende perguntas por REGRAS (palavras e padrões), escolhe uma ferramenta, executa e monta a resposta
// com texto fixo. NÃO é um modelo de linguagem e a interface nunca diz que é.
// Usa exatamente as mesmas ferramentas (e as mesmas proteções) do modo IA: executeToolCall.
import { normalizeText } from '../utils/format.js';
import { addDays, shiftMonth } from '../utils/dates.js';
import { executeToolCall } from './tools.js';
import { formatToolResult } from './formatters.js';
import { findCategory } from './snapshot.js';

const MONTH_NAMES = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

export const EXAMPLE_QUESTIONS = [
  'Quanto gastei com alimentação neste mês?',
  'Qual foi minha maior despesa nos últimos 30 dias?',
  'Quanto gastei a mais em relação ao mês passado?',
  'Quanto ainda tenho disponível no orçamento?',
  'Quais categorias estão próximas do limite?',
  'Quanto do meu próximo salário já está comprometido?',
  'Quais despesas ainda não foram alocadas?',
  'Quais estabelecimentos mais aparecem nos meus extratos?',
  'Quanto recebi e quanto gastei neste período?',
  'Quais foram minhas despesas recorrentes?',
];

const COMMANDS = {
  '/resumo': 'quanto recebi e gastei neste periodo',
  '/orcamento': 'quanto ainda tenho disponivel no orcamento',
  '/ciclos': 'detalhes do ciclo atual',
  '/pendencias': 'quais transacoes estao pendentes de categorizacao',
  '/alocacao': 'quais despesas ainda nao foram alocadas',
  '/recorrentes': 'quais foram minhas despesas recorrentes',
};

const has = (norm, ...parts) => parts.some((p) => (p instanceof RegExp ? p.test(norm) : norm.includes(p)));

// ------------------------------------------------------------------ períodos escritos no texto
/** Todos os meses citados no texto, NA ORDEM em que aparecem (ex.: "março com fevereiro" → [mar, fev]). */
export function monthsInText(norm, today) {
  const found = [];
  const thisYear = Number(today.slice(0, 4));
  for (let i = 0; i < 12; i++) {
    const m = new RegExp(`\\b${MONTH_NAMES[i]}\\b(?: de (\\d{4}))?`).exec(norm);
    if (!m) continue;
    const year = m[1] ? Number(m[1]) : (i + 1 <= Number(today.slice(5, 7)) ? thisYear : thisYear - 1);
    found.push({ at: m.index, param: { month: `${year}-${String(i + 1).padStart(2, '0')}` } });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.param);
}

function monthParam(norm, today) {
  return monthsInText(norm, today)[0] || null;
}

/** Procura um período no texto. Devolve o parâmetro da ferramenta ou null. */
export function extractPeriod(norm, snapshot) {
  const today = snapshot.today;
  const month = monthParam(norm, today);
  if (month) return month;
  if (has(norm, 'mes passado', 'mes anterior', 'ultimo mes')) return { preset: 'mes_anterior' };
  if (has(norm, 'neste mes', 'este mes', 'nesse mes', 'mes atual', 'do mes')) return { preset: 'mes_atual' };
  const days = norm.match(/ultimos? (\d{1,3}) dias/);
  if (days) {
    const n = Number(days[1]);
    if (n === 30) return { preset: 'ultimos_30' };
    if (n === 90) return { preset: 'ultimos_90' };
    if (n >= 1 && n <= 365) return { start: addDays(today, -(n - 1)), end: today };
  }
  if (has(norm, 'ultima semana', 'esta semana', 'essa semana', 'ultimos 7 dias')) return { start: addDays(today, -6), end: today };
  if (has(norm, 'ano passado')) { const y = Number(today.slice(0, 4)) - 1; return { start: `${y}-01-01`, end: `${y}-12-31` }; }
  if (has(norm, 'este ano', 'neste ano', 'ano atual', 'nesse ano')) return { preset: 'ano_atual' };
  if (has(norm, 'todo o historico', 'desde sempre', 'tudo que importei', 'todo historico')) return { preset: 'tudo' };
  if (has(norm, 'neste periodo', 'nesse periodo', 'no periodo', 'periodo selecionado')) return snapshot.defaultPeriod || { preset: 'ultimo_com_dados' };
  return null;
}

/** Período "anterior equivalente", usado nas comparações. */
function previousOf(param, today) {
  if (!param || param.preset === 'mes_atual') return { preset: 'mes_anterior' };
  if (param.month) return { month: shiftMonth(param.month, -1) };
  if (param.preset === 'mes_anterior') return { month: shiftMonth(today.slice(0, 7), -2) };
  if (param.start && param.end) {
    const length = Math.round((Date.parse(param.end) - Date.parse(param.start)) / 86400000) + 1;
    return { start: addDays(param.start, -length), end: addDays(param.start, -1) };
  }
  if (param.preset === 'ultimos_30') return { start: addDays(today, -59), end: addDays(today, -30) };
  if (param.preset === 'ultimos_90') return { start: addDays(today, -179), end: addDays(today, -90) };
  if (param.preset === 'ano_atual') { const y = Number(today.slice(0, 4)) - 1; return { start: `${y}-01-01`, end: `${y}-12-31` }; }
  return { preset: 'mes_anterior' };
}

function categoryInText(norm, snapshot) {
  return snapshot.categories.find((c) => new RegExp(`\\b${normalizeText(c.nome)}\\b`).test(norm)) || null;
}

function sourceInText(norm, snapshot) {
  const src = snapshot.sources.find((s) => norm.includes(normalizeText(s.name)));
  if (src) return src.name;
  return has(norm, 'salario') ? 'salario' : undefined;
}

// ------------------------------------------------------------------ intenções (em ordem de prioridade)
const INTENTS = [
  {
    id: 'ajuda',
    test: (n) => /^(ajuda|help|oi|ola)$/.test(n) || has(n, 'o que voce faz', 'o que voce sabe', 'como funciona', 'comandos'),
    run: () => ({ help: true }),
  },
  {
    id: 'categorizar',
    test: (n) => /\b(categoriz|classific|marc)\w*\b.*\b(como|para|em)\b/.test(n) && !has(n, 'sugir', 'sugest'),
    async run(ctx) {
      const m = ctx.norm.match(/(?:categoriz|classific|marc)\w*\s+(?:as\s+|os\s+)?(?:(?:transacoes|despesas|compras|gastos)\s+)?(?:de\s+|do\s+|da\s+)?(.+?)\s+(?:como|para|em)\s+(.+)$/);
      // aceita "como Saúde" e também "como Saúde e memorizar" (procura o nome da categoria no trecho)
      const cat = m && (findCategory(ctx.snapshot, m[2].trim()) || categoryInText(m[2], ctx.snapshot));
      if (!m || !cat) return { clarify: 'Para propor uma categorização, diga assim: "categorizar iFood como Alimentação". As categorias existentes são: ' + ctx.snapshot.categories.map((c) => c.nome).join(', ') + '.' };
      const found = ctx.call('search_transactions', { query: m[1].trim(), period: { preset: 'tudo' }, limit: 50 });
      if (!found.ok || !found.data.matched_count) return { clarify: `Não encontrei transações com "${m[1].trim()}".` };
      ctx.call('propose_categorization', {
        transaction_ids: found.data.transactions.map((t) => t.id), category: cat.nome, remember: has(ctx.norm, 'memoriz', 'lembr', 'regra'),
      });
      return {};
    },
  },
  {
    id: 'sugerir',
    test: (n) => has(n, 'sugir', 'sugest') && has(n, 'categor', 'classific'),
    run: (ctx) => { ctx.call('suggest_categorization', {}); },
  },
  {
    id: 'erros-categoria',
    test: (n) => has(n, 'errad', 'incorret', 'inconsist', 'erro') && has(n, 'categor', 'classific'),
    run: (ctx) => { ctx.call('find_categorization_issues', {}); },
  },
  {
    id: 'regras',
    test: (n) => has(n, /\bregras?\b/) && !has(n, 'orcamento'),
    run: (ctx) => { ctx.call('get_categorization_rules', {}); },
  },
  {
    id: 'nao-alocadas',
    test: (n) => has(n, 'alocad', 'alocacao') && has(n, 'nao', 'sem', 'ainda', 'pendent', 'falta'),
    run: (ctx) => { ctx.call('get_pending_allocations', { period: ctx.period || { preset: 'tudo' } }); },
  },
  {
    id: 'comprometimento',
    test: (n) => has(n, 'comprometid') && has(n, 'salario', 'recebimento', 'renda', 'proximo'),
    run: (ctx) => { ctx.call('get_upcoming_commitment', { source: sourceInText(ctx.norm, ctx.snapshot) }); },
  },
  {
    id: 'projecao',
    test: (n) => has(n, 'projec', 'estimar', 'estimativa', 'vai estourar', /quando .*(estour|atingir|chegar)/) && has(n, 'orcamento', 'limite', 'categoria'),
    run: (ctx) => { ctx.call('project_budget', { category: categoryInText(ctx.norm, ctx.snapshot)?.nome }); },
  },
  {
    id: 'orcamento-alertas',
    test: (n) => has(n, 'proxim', 'limite', 'estour', 'alerta', 'ultrapass') && has(n, 'categoria', 'orcamento', 'limite'),
    run: (ctx) => { ctx.call('get_budget_status', { only_alerts: true, ...(ctx.period?.month ? { month: ctx.period.month } : {}) }); },
  },
  {
    id: 'orcamento',
    test: (n) => has(n, 'orcamento') || (has(n, 'disponivel') && !has(n, 'salario', 'ciclo')),
    run: (ctx) => {
      const cat = categoryInText(ctx.norm, ctx.snapshot);
      ctx.call('get_budget_status', { ...(cat ? { category: cat.nome } : {}), ...(ctx.period?.month ? { month: ctx.period.month } : {}) });
    },
  },
  {
    id: 'ciclo',
    test: (n) => has(n, /\bciclos?\b/),
    run: (ctx) => {
      const when = has(ctx.norm, 'proximo') ? 'next' : has(ctx.norm, 'anterior', 'passado') ? 'last' : ctx.period?.month ? 'month' : 'current';
      ctx.call('get_cycle_details', { when, ...(when === 'month' ? { month: ctx.period.month } : {}), source: sourceInText(ctx.norm, ctx.snapshot) });
    },
  },
  {
    id: 'proximos-recebimentos',
    test: (n) => has(n, 'proximo', 'quando') && has(n, 'recebimento', 'receber', 'salario', 'recebo', 'renda'),
    run: (ctx) => { ctx.call('get_upcoming_income', { source: sourceInText(ctx.norm, ctx.snapshot) }); },
  },
  {
    id: 'fontes',
    test: (n) => has(n, 'fontes de renda', 'minhas rendas', 'minha renda'),
    run: (ctx) => { ctx.call('list_income_sources', {}); },
  },
  {
    id: 'recorrentes',
    test: (n) => has(n, 'recorrent', 'assinatura', 'se repetem', 'despesas fixas'),
    run: (ctx) => { ctx.call('get_recurring_expenses', {}); },
  },
  {
    id: 'estabelecimentos',
    test: (n) => has(n, 'estabelecimento', 'onde mais gasto', 'lojas'),
    run: (ctx) => { ctx.call('get_top_merchants', { period: ctx.period || { preset: 'tudo' }, limit: 10 }); },
  },
  {
    id: 'comparar',
    test: (n) => has(n, 'a mais', 'a menos', 'em relacao', 'comparar', 'compare', 'comparacao', 'versus', 'diferenca'),
    run: (ctx) => {
      const months = monthsInText(ctx.norm, ctx.snapshot.today);
      let a; let b;
      if (months.length >= 2) {
        [a, b] = months; // "compare março com fevereiro": o 1º citado é o período A
      } else {
        const explicitPrevious = ctx.period && ctx.period.preset === 'mes_anterior';
        a = explicitPrevious ? { preset: 'mes_atual' } : (ctx.period || { preset: 'mes_atual' });
        b = explicitPrevious ? { preset: 'mes_anterior' } : previousOf(a, ctx.snapshot.today);
      }
      ctx.call('compare_periods', { period_a: a, period_b: b });
    },
  },
  {
    id: 'maior-despesa',
    test: (n) => /maior(es)? (despesa|gasto|compra)/.test(n),
    run: (ctx) => { ctx.call('search_transactions', { direction: 'saida', sort: 'amount_desc', limit: 5, period: ctx.period || { preset: 'mes_atual' } }); },
  },
  {
    id: 'tendencia',
    test: (n) => has(n, 'tendencia', 'evolucao', 'evoluindo', 'aumentando', 'diminuindo'),
    run: (ctx) => { ctx.call('get_spending_trend', { category: categoryInText(ctx.norm, ctx.snapshot)?.nome }); },
  },
  {
    id: 'padroes',
    test: (n) => has(n, 'padrao', 'padroes', 'habito', 'ticket medio', 'dia da semana'),
    run: (ctx) => { ctx.call('get_spending_patterns', { period: ctx.period || { preset: 'mes_atual' } }); },
  },
  {
    id: 'pendentes-categoria',
    test: (n) => has(n, 'pendente', 'sem categoria', 'revisar', 'para revisao') && has(n, 'categor', 'transac', 'despesa', 'revis', 'sem categoria'),
    run: (ctx) => { ctx.call('get_pending_transactions', {}); },
  },
  {
    id: 'gasto-categoria',
    test: (n, ctx) => has(n, 'gast', 'despesa', 'quanto') && Boolean(categoryInText(n, ctx.snapshot)),
    run: (ctx) => { ctx.call('get_expenses_by_category', { category: categoryInText(ctx.norm, ctx.snapshot).nome, period: ctx.period || { preset: 'mes_atual' } }); },
  },
  {
    id: 'gasto-estabelecimento',
    // "quanto gastei no iFood" → estabelecimento. "quanto gastei em março / neste mês / nos últimos dias" → período, não estabelecimento.
    test: (n) => {
      const m = n.match(/quanto (?:gastei|paguei) (?:com|no|na|em|de|do|da) (\w+)/);
      return Boolean(m) && !MONTH_NAMES.includes(m[1]) && !['categoria', 'neste', 'nesse', 'este', 'esta', 'nos', 'nas', 'ano', 'mes', 'periodo', 'ultimos', 'ultimo', 'semana', 'todo', 'total'].includes(m[1]);
    },
    run: (ctx) => {
      const m = ctx.norm.match(/quanto (?:gastei|paguei) (?:com|no|na|em|de|do|da) (.+?)(?: neste| nesse| nos| no mes| em | este|$)/);
      ctx.call('search_transactions', { query: m[1].trim(), direction: 'saida', limit: 10, period: ctx.period || { preset: 'tudo' } });
    },
  },
  {
    id: 'por-categoria',
    test: (n) => has(n, 'por categoria', 'categorias', 'onde gastei', 'maior categoria') && has(n, 'gast', 'despesa', 'maior', 'onde', 'por categoria'),
    run: (ctx) => { ctx.call('get_expenses_by_category', { period: ctx.period || { preset: 'mes_atual' } }); },
  },
  {
    id: 'resumo',
    test: (n) => has(n, 'recebi', 'gastei', 'saldo', 'resumo', 'receita', 'despesa', 'quanto sobrou', 'balanco'),
    run: (ctx) => { ctx.call('get_financial_summary', { period: ctx.period || undefined }); },
  },
];

const HELP_TEXT = {
  paragraphs: [
    '**Modo local (sem IA generativa).** Eu entendo perguntas por regras e palavras-chave e consulto os seus dados reais com as ferramentas do app. Não invento valores: se não houver dados, eu aviso.',
    'Experimente perguntar, por exemplo:',
  ],
  list: EXAMPLE_QUESTIONS,
  notes: ['Também funcionam os comandos /resumo, /orcamento, /ciclos, /pendencias, /alocacao e /recorrentes.', 'Para propor uma categorização: "categorizar iFood como Alimentação". Nada é alterado sem você confirmar.'],
};

/**
 * Responde uma pergunta no modo local.
 * @returns {{ paragraphs, table?, list?, notes, tools: Array, proposals: string[], unrecognized?: boolean }}
 */
export async function answerLocally(text, { snapshot }) {
  const raw = String(text || '').trim();
  const command = COMMANDS[raw.toLowerCase().split(/\s+/)[0]];
  const norm = normalizeText(raw.startsWith('/') && !command ? raw.slice(1) : (command || raw));
  const calls = [];

  const ctx = {
    norm, snapshot, period: extractPeriod(norm, snapshot),
    call(name, args) {
      const clean = JSON.parse(JSON.stringify(args, (k, v) => (v === undefined ? undefined : v)));
      const result = executeToolCall(snapshot, name, clean);
      calls.push({ name, args: clean, result });
      return result;
    },
  };

  if (!norm) return { ...HELP_TEXT, tools: [], proposals: [], help: true };
  const intent = INTENTS.find((i) => i.test(norm, ctx));
  if (!intent) {
    return {
      paragraphs: ['Não entendi essa pergunta. No modo local eu só reconheço alguns tipos de consulta.'],
      list: EXAMPLE_QUESTIONS.slice(0, 5), notes: ['Digite "ajuda" para ver tudo o que sei fazer, ou conecte uma IA (veja as configurações acima) para perguntas livres.'],
      tools: [], proposals: [], unrecognized: true,
    };
  }
  const outcome = (await intent.run(ctx)) || {};
  if (outcome.help) return { ...HELP_TEXT, tools: [], proposals: [], help: true };
  if (outcome.clarify) return { paragraphs: [outcome.clarify], notes: [], tools: calls.map(({ name, args, result }) => ({ name, args, ok: result.ok })), proposals: [] };

  const last = calls[calls.length - 1];
  const formatted = formatToolResult(last.name, last.result, last.args);
  const proposals = calls.filter((c) => c.name === 'propose_categorization' && c.result.ok).map((c) => c.result.data.proposal_id);
  return {
    ...formatted,
    intent: intent.id,
    tools: calls.map(({ name, args, result }) => ({ name, args, ok: result.ok, result })),
    proposals,
  };
}
