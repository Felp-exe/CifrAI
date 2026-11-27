import { test, assert, assertEqual } from './runner.js';
import { Database, deleteDatabase } from '../js/db.js';
import { seedDefaults } from '../js/seed.js';
import { normalizeText } from '../js/utils/format.js';
import { getSetting, setSetting } from '../js/storage.js';
import { validateParams } from '../js/agent/validate.js';
import { buildSnapshot, loadSnapshot } from '../js/agent/snapshot.js';
import { TOOLS, executeToolCall, publicToolDefinitions, sanitizeForModel } from '../js/agent/tools.js';
import { SKILLS } from '../js/agent/skills/index.js';
import { answerLocally, extractPeriod, EXAMPLE_QUESTIONS } from '../js/agent/localAgent.js';
import { getProposal, cancelProposal, clearProposals } from '../js/agent/proposals.js';
import { applyProposal } from '../js/agent/proposalApply.js';
import {
  AgentBackendClient, BackendError, normalizeEndpoint, validateTurnResponse,
} from '../js/agent/llm/backendClient.js';
import { runAiTurn, MAX_STEPS } from '../js/agent/llm/aiAgent.js';
import {
  ask, getAssistantConfig, saveEndpoint, clearEndpoint, setAssistantMode, testConnection,
} from '../js/agent/orchestrator.js';
import { richText } from '../js/ui/assistente.js';
import { recategorize } from '../js/categorization/transactionService.js';
import { listRules } from '../js/categorization/ruleService.js';
import { createMockFetch, jsonResponse, fakeLlm } from './helpers/mockBackend.js';

// ------------------------------------------------------------ dados de teste (valores em centavos)
let cache = null;
async function baseData() {
  if (!cache) {
    const [categories, rules] = await Promise.all([
      fetch('../data/categories.json').then((r) => r.json()),
      fetch('../data/merchant-rules.json').then((r) => r.json()),
    ]);
    cache = { categories, rules: rules.map((r, i) => ({ ...r, id: i + 1 })) };
  }
  return cache;
}

let nextId = 1;
const T = (date, amount, categoryId = null, extra = {}) => {
  const desc = extra.desc || 'LOJA X';
  const { desc: _d, merchant, ...rest } = extra;
  return {
    id: nextId++, date, amount, categoryId, status: 'classificada', type: amount > 0 ? 'pix_recebido' : 'compra',
    originalDescription: desc, normalizedName: normalizeText(desc), merchantName: merchant || normalizeText(desc), ...rest,
  };
};

function fixtureTransactions() {
  nextId = 1;
  return [
    T('2026-02-05', 500000, null, { desc: 'SALARIO EMPRESA' }),                                   // 1
    T('2026-02-10', -20000, 'alimentacao', { desc: 'IFOOD PIZZA', merchant: 'ifood' }),            // 2
    T('2026-02-12', -10000, 'transporte', { desc: 'UBER TRIP', merchant: 'uber' }),                // 3
    T('2026-02-20', -3990, 'assinaturas', { desc: 'NETFLIX', merchant: 'netflix' }),               // 4
    T('2026-03-05', 450000, null, { desc: 'SALARIO EMPRESA' }),                                    // 5
    T('2026-03-06', -30000, 'alimentacao', { desc: 'IFOOD PIZZA', merchant: 'ifood' }),            // 6
    T('2026-03-07', -8000, 'transporte', { desc: 'UBER TRIP', merchant: 'uber' }),                 // 7
    T('2026-03-08', -15000, 'compras', { desc: 'LOJA Y', status: 'pendente' }),                    // 8
    T('2026-03-09', 6000, 'alimentacao', { desc: 'ESTORNO IFOOD', type: 'estorno', merchant: 'ifood' }), // 9
    T('2026-03-12', -3990, 'assinaturas', { desc: 'NETFLIX', merchant: 'netflix' }),               // 10
    T('2026-03-14', -9000, null, { desc: 'PAGAMENTO 99 APP', status: 'pendente' }),                // 11
  ];
}

const SOURCES = [
  { id: 1, name: 'Adiantamento', frequency: 'mensal', day: 15, amount: 150000 },
  { id: 2, name: 'Salário', frequency: 'mensal', day: 30, amount: 450000 },
];
const BUDGETS = [{ id: 1, categoryId: 'alimentacao', limit: 25000 }, { id: 2, categoryId: 'transporte', limit: 50000 }];

async function snap(overrides = {}) {
  const { categories, rules } = await baseData();
  return buildSnapshot({
    today: '2026-03-15', transactions: fixtureTransactions(), categories, rules, budgets: BUDGETS, sources: SOURCES, ...overrides,
  });
}
const run = (s, name, args = {}) => executeToolCall(s, name, args);

let counter = 0;
async function freshDb() {
  const name = `mfa-test-agent-${Date.now()}-${counter++}`;
  const db = await new Database(name).open();
  await seedDefaults(db, '../data/');
  db._testName = name;
  return db;
}
async function dispose(db) { db.close(); await deleteDatabase(db._testName); }
async function addDbTx(db, desc, amount, date = '2026-03-10') {
  return db.add('transactions', {
    date, amount, type: amount > 0 ? 'pix_recebido' : 'compra', originalDescription: desc, normalizedName: normalizeText(desc),
    categoryId: null, status: 'pendente', fingerprint: `a${counter++}`, importId: 't',
  });
}

async function withSettings(fn) {
  const before = { endpoint: getSetting('llmEndpoint'), mode: getSetting('assistantMode') };
  try { return await fn(); } finally { setSetting('llmEndpoint', before.endpoint || ''); setSetting('assistantMode', before.mode || 'local'); }
}

// ============================================================ validação e segurança das ferramentas
test('validação de parâmetros: tipos, valores permitidos, limites, formato, obrigatórios e padrões', () => {
  const schema = {
    type: 'object', required: ['n'],
    properties: {
      n: { type: 'integer', minimum: 1, maximum: 5 }, mode: { type: 'string', enum: ['a', 'b'], default: 'a' },
      day: { type: 'string', pattern: '^\\d{4}-\\d{2}$' }, ids: { type: 'array', items: { type: 'integer' }, maxItems: 2 },
      flag: { type: 'boolean' }, sub: { type: 'object', properties: { x: { type: 'string' } } },
    },
  };
  assertEqual(validateParams(schema, { n: 3 }).value.mode, 'a', 'padrão aplicado:');
  assert(!validateParams(schema, {}).ok, 'obrigatório');
  assert(!validateParams(schema, { n: 0 }).ok, 'mínimo');
  assert(!validateParams(schema, { n: 9 }).ok, 'máximo');
  assert(!validateParams(schema, { n: 1.5 }).ok, 'inteiro');
  assert(!validateParams(schema, { n: '3' }).ok, 'tipo errado');
  assert(!validateParams(schema, { n: 1, mode: 'c' }).ok, 'enum');
  assert(!validateParams(schema, { n: 1, day: '2026-3' }).ok, 'formato');
  assert(!validateParams(schema, { n: 1, ids: [1, 2, 3] }).ok, 'itens demais');
  assert(!validateParams(schema, { n: 1, ids: ['a'] }).ok, 'tipo do item');
  assert(!validateParams(schema, { n: 1, extra: 1 }).ok, 'parâmetro desconhecido');
  assert(!validateParams(schema, { n: 1, sub: { y: 1 } }).ok, 'desconhecido aninhado');
  assert(!validateParams(schema, 'texto').ok, 'não é objeto');
  assert(validateParams(schema, { n: 1, flag: true, sub: { x: 'ok' }, ids: [1] }).ok);
});

test('registro: 20 ferramentas, 4 skills, todas somente leitura, nomes únicos e sem ferramentas de escrita', () => {
  assertEqual(SKILLS.length, 4);
  assertEqual(TOOLS.size, 20);
  const defs = publicToolDefinitions();
  assertEqual(new Set(defs.map((d) => d.name)).size, 20);
  for (const d of defs) {
    assertEqual(d.read_only, true, d.name);
    assertEqual(d.parameters.type, 'object', d.name);
    assert(d.description.length > 20, `${d.name}: descrição`);
    assert(!/^(apply|delete|update|create|set|write|remove|save)_/.test(d.name), `${d.name} parece ferramenta de escrita`);
  }
  assert(!JSON.stringify(defs).includes('handler'), 'o código das ferramentas nunca vai para o modelo');
  const required = ['get_financial_summary', 'get_expenses_by_category', 'compare_periods', 'search_transactions', 'get_budget_status', 'get_upcoming_income', 'get_cycle_details', 'get_pending_transactions', 'suggest_categorization'];
  for (const name of required) assert(TOOLS.has(name), `faltou ${name}`);
});

test('executar ferramenta: desconhecida, escrita inventada e parâmetros inválidos são recusadas sem executar', async () => {
  const s = await snap();
  for (const name of ['apply_categorization', 'delete_all_transactions', 'update_budget', '__proto__', 'constructor', 42, undefined]) {
    const r = run(s, name, {});
    assertEqual(r.ok, false, String(name));
    assertEqual(r.error.code, 'unknown_tool', String(name));
  }
  const bad = run(s, 'get_expenses_by_category', { limit: 9999, extra: true });
  assertEqual(bad.error.code, 'invalid_parameters');
  assert(bad.error.details.length >= 2, 'lista todos os problemas');
  assertEqual(run(s, 'get_financial_summary', { period: { preset: 'xxx' } }).error.code, 'invalid_parameters');
  assertEqual(run(s, 'get_financial_summary', { period: { start: '2026-03-10', end: '2026-03-01' } }).error.code, 'invalid_period');
  assertEqual(run(s, 'get_financial_summary', { period: { start: '2026-03-10' } }).error.code, 'invalid_period', 'start sem end:');
  assertEqual(run(s, 'get_expenses_by_category', { category: 'Xablau' }).error.code, 'unknown_category');
  assert(run(s, 'get_expenses_by_category', { category: 'Xablau' }).error.valid_categories.includes('Alimentação'), 'lista as categorias válidas');
});

test('erros internos não vazam detalhes', async () => {
  const r = executeToolCall({ today: '2026-03-15' }, 'get_financial_summary', {}); // fotografia quebrada de propósito
  assertEqual(r.ok, false);
  assertEqual(r.error.code, 'internal_error');
  assert(!/TypeError|undefined|at /.test(r.error.message), 'sem stack nem detalhes: ' + r.error.message);
});

test('ferramentas recebem uma fotografia congelada (não conseguem alterar dados)', async () => {
  const s = await snap();
  assert(Object.isFrozen(s.transactions) && Object.isFrozen(s.transactions[0]), 'transações congeladas');
  let threw = false;
  try { s.transactions[0].amount = 1; } catch { threw = true; }
  assert(threw, 'alterar deve falhar (modo estrito)');
  const before = JSON.stringify(s.transactions);
  for (const name of TOOLS.keys()) run(s, name, name === 'compare_periods' ? { period_a: { preset: 'mes_atual' }, period_b: { preset: 'mes_anterior' } } : name === 'propose_categorization' ? { transaction_ids: [8], category: 'Saúde' } : {});
  assertEqual(JSON.stringify(s.transactions), before, 'nenhuma ferramenta altera os dados:');
});

test('varredura estática: nenhum código das ferramentas/agente contém operações de escrita no banco', async () => {
  const files = [
    ...['analiseFinanceira', 'monitoramentoOrcamento', 'ciclosRecebimento', 'categorizacao', 'index'].map((f) => `../js/agent/skills/${f}.js`),
    ...['tools', 'snapshot', 'localAgent', 'formatters', 'validate', 'results', 'periodParam', 'orchestrator'].map((f) => `../js/agent/${f}.js`),
    '../js/agent/llm/aiAgent.js', '../js/agent/llm/backendClient.js',
  ];
  const forbidden = [/\.put\(/, /\.add\(/, /\.delete\(/, /\.clear\(/, /\.transact\(/, /bulkPut/, /setCategory\(/, /createRule\(/, /updateRule\(/, /deleteRule\(/, /indexedDB/, /proposalApply/, /applyProposal/, /localStorage/];
  for (const file of files) {
    const text = await (await fetch(file)).text();
    const code = text.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    for (const re of forbidden) assert(!re.test(code), `${file} contém ${re}`);
  }
});

test('sanitizeForModel: resultados enormes são encurtados e marcados', () => {
  const big = { ok: true, data: { rows: Array.from({ length: 400 }, (_, i) => ({ i, text: 'x'.repeat(40) })) }, notes: [] };
  const out = sanitizeForModel(big, 3000);
  assert(JSON.stringify(out).length <= 3000, 'coube no limite');
  assertEqual(out.truncated, true);
  assert(out.data.rows.length < 400);
  const small = { ok: true, data: { a: 1 } };
  assertEqual(sanitizeForModel(small), small, 'resultado pequeno passa intacto:');
});

// ============================================================ SKILL 2: análise financeira
test('Skill 2 — resumo financeiro com valores reais; estorno abate; saldo não é saldo bancário', async () => {
  const r = run(await snap(), 'get_financial_summary', {});
  const d = r.data;
  assertEqual(d.income.cents, 450000);
  assertEqual(d.expenses_gross.cents, 65990);
  assertEqual(d.refunds.cents, 6000);
  assertEqual(d.expenses_net.cents, 59990);
  assertEqual(d.balance.cents, 390010);
  assertEqual(d.balance.brl, 'R$ 3.900,10');
  assertEqual(d.pending_expenses.count, 2);
  assert(r.notes.some((n) => /não é o saldo da conta/i.test(n)), 'aviso sobre saldo bancário');
  const fev = run(await snap(), 'get_financial_summary', { period: { preset: 'mes_anterior' } }).data;
  assertEqual(fev.income.cents, 500000);
  assertEqual(fev.expenses_net.cents, 33990);
});

test('Skill 2 — períodos diferentes: mês, intervalo, últimos 30 dias, ano e histórico', async () => {
  const s = await snap();
  const inc = (period) => run(s, 'get_financial_summary', { period }).data.income.cents;
  assertEqual(inc({ month: '2026-02' }), 500000);
  assertEqual(inc({ start: '2026-03-01', end: '2026-03-31' }), 450000);
  assertEqual(inc({ preset: 'ultimos_30' }), 450000, '14/02 a 15/03:');
  assertEqual(inc({ preset: 'ano_atual' }), 950000);
  assertEqual(inc({ preset: 'tudo' }), 950000);
  assertEqual(run(s, 'get_financial_summary', { period: { start: '2026-03-06', end: '2026-03-08' } }).data.expenses_net.cents, 53000);
});

test('Skill 2 — sem dados no período: avisa e aponta o mês mais recente, sem inventar', async () => {
  const s = await snap({ today: '2026-11-26' });
  const r = run(s, 'get_financial_summary', {});
  assertEqual(r.data.empty, true);
  assertEqual(r.data.latest_month_with_data.month, '2026-03');
  assert(/novembro de 2026/.test(r.notes[0]) && /março de 2026/.test(r.notes[0]), r.notes[0]);
  assertEqual(r.data.income, undefined, 'não devolve valores inventados:');
  const vazio = run(await snap({ transactions: [] }), 'get_financial_summary', {});
  assertEqual(vazio.data.empty, true);
  assertEqual(vazio.data.latest_month_with_data, null);
  assert(/Ainda não há transações/.test(vazio.notes[0]));
});

test('Skill 2 — despesas por categoria (total, percentual e uma categoria)', async () => {
  const s = await snap();
  const all = run(s, 'get_expenses_by_category', {}).data;
  assertEqual(all.total_expenses.cents, 59990);
  assertEqual(all.categories[0].category, 'Alimentação');
  assertEqual(all.categories[0].total.cents, 24000, '30000 − 6000 de estorno:');
  assertEqual(all.categories[0].percent, 40);
  assert(all.categories.some((c) => c.category === 'Sem categoria' && c.total.cents === 9000), 'despesa sem categoria aparece à parte');
  assertEqual(all.categories.at(-1).category, 'Assinaturas', 'ordenado do maior para o menor:');
  const one = run(s, 'get_expenses_by_category', { category: 'alimentação' }).data;
  assertEqual(one.total.brl, 'R$ 240,00');
  assertEqual(one.expense_count, 1);
  const none = run(s, 'get_expenses_by_category', { category: 'Saúde' });
  assertEqual(none.data.total.cents, 0);
  assert(/Nenhuma despesa em Saúde/.test(none.notes[0]));
  assertEqual(run(s, 'get_expenses_by_category', { limit: 2 }).data.omitted_categories, 3);
});

test('Skill 2 — comparar períodos: diferença, direção e categorias que mudaram', async () => {
  const s = await snap();
  const r = run(s, 'compare_periods', { period_a: { preset: 'mes_atual' }, period_b: { preset: 'mes_anterior' } }).data;
  assertEqual(r.comparable, true);
  assertEqual(r.expenses_difference.delta.cents, 26000);
  assertEqual(r.expenses_difference.direction, 'more');
  assertEqual(r.expenses_difference.percent, 76.5);
  assertEqual(r.income_difference.cents, -50000);
  assertEqual(r.biggest_increases[0].category, 'Compras');
  assertEqual(r.biggest_increases.find((c) => c.category === 'Alimentação').delta.cents, 4000);
  assert(r.biggest_decreases.length === 0 || r.biggest_decreases[0].delta.cents < 0);
  const down = run(s, 'compare_periods', { period_a: { preset: 'mes_anterior' }, period_b: { preset: 'mes_atual' } }).data;
  assertEqual(down.expenses_difference.direction, 'less');
  const same = run(s, 'compare_periods', { period_a: { preset: 'mes_atual' }, period_b: { preset: 'mes_atual' } }).data;
  assertEqual(same.expenses_difference.direction, 'same');
  const noData = run(s, 'compare_periods', { period_a: { preset: 'mes_atual' }, period_b: { month: '2025-01' } });
  assertEqual(noData.data.comparable, false);
  assert(/Não dá para comparar/.test(noData.notes[0]));
  assertEqual(run(s, 'compare_periods', { period_a: { preset: 'mes_atual' } }).error.code, 'invalid_parameters', 'period_b obrigatório:');
});

test('Skill 2 — buscar movimentações: maior despesa, estabelecimento, categoria e limites', async () => {
  const s = await snap();
  const big = run(s, 'search_transactions', { direction: 'saida', sort: 'amount_desc', limit: 2, period: { preset: 'ultimos_30' } }).data;
  assertEqual(big.transactions[0].amount.cents, -30000);
  assertEqual(big.transactions[0].description, 'IFOOD PIZZA');
  assertEqual(big.returned, 2);
  const q = run(s, 'search_transactions', { query: 'netflix', period: { preset: 'tudo' } }).data;
  assertEqual(q.matched_count, 2);
  assertEqual(q.net_total_of_matches.cents, -7980);
  assertEqual(run(s, 'search_transactions', { category: 'sem_categoria', direction: 'saida', period: { preset: 'tudo' } }).data.matched_count, 1);
  assertEqual(run(s, 'search_transactions', { direction: 'estorno', period: { preset: 'tudo' } }).data.matched_count, 1);
  assertEqual(run(s, 'search_transactions', { direction: 'entrada', period: { preset: 'tudo' } }).data.matched_count, 2, 'estorno não é entrada:');
  assertEqual(run(s, 'search_transactions', { min_amount_cents: 20000, direction: 'saida', period: { preset: 'tudo' } }).data.matched_count, 2);
  const none = run(s, 'search_transactions', { query: 'inexistente', period: { preset: 'tudo' } });
  assertEqual(none.data.matched_count, 0);
  assert(/Nenhuma transação/.test(none.notes[0]));
  assertEqual(run(s, 'search_transactions', { limit: 51 }).error.code, 'invalid_parameters', 'limite máximo de 50 linhas:');
  assert(!JSON.stringify(big).includes('sourceLine'), 'não expõe a linha bruta do extrato');
});

test('Skill 2 — estabelecimentos, recorrentes, tendência e padrões', async () => {
  const s = await snap();
  const top = run(s, 'get_top_merchants', { period: { preset: 'tudo' } }).data;
  assertEqual(top.merchants[0].merchant, 'ifood');
  assertEqual(top.merchants[0].count, 2);
  assertEqual(top.merchants[0].total.cents, 50000);
  const rec = run(s, 'get_recurring_expenses', {}).data;
  assertEqual(rec.enough_data, true);
  assertEqual(rec.items.length, 1, 'só a Netflix tem valor parecido:');
  assertEqual(rec.items[0].merchant, 'netflix');
  const oneMonth = run(await snap({ transactions: fixtureTransactions().filter((t) => t.date >= '2026-03-01') }), 'get_recurring_expenses', {});
  assertEqual(oneMonth.data.enough_data, false);
  assert(/2 meses/.test(oneMonth.notes[0]));

  const trend = run(s, 'get_spending_trend', {});
  assertEqual(trend.data.enough_data, true);
  assertEqual(trend.data.until_month, '2026-03');
  assertEqual(trend.data.series.length, 3);
  assertEqual(trend.data.last_month_change.direction, 'increasing');
  assert(trend.notes.some((n) => /em andamento/.test(n)), 'avisa mês em andamento');
  assertEqual(run(s, 'get_spending_trend', { category: 'Alimentação' }).data.last_month_change.percent, 20);
  const estavel = run(await snap({ transactions: [T('2026-01-10', -10000, 'compras'), T('2026-02-10', -10500, 'compras')], today: '2026-03-20' }), 'get_spending_trend', { months: 2 });
  assertEqual(estavel.data.last_month_change.direction, 'stable', '5% é estável:');
  const insuf = run(await snap({ transactions: [T('2026-03-10', -10000, 'compras')] }), 'get_spending_trend', {});
  assertEqual(insuf.data.enough_data, false);
  assertEqual(insuf.data.last_month_change, null);

  const pat = run(s, 'get_spending_patterns', { period: { preset: 'tudo' } }).data;
  assertEqual(pat.enough_data, true);
  assertEqual(pat.expense_count, 8);
  assertEqual(pat.biggest_expense.amount.cents, -30000);
  assertEqual(pat.by_weekday.length, 7);
  assertEqual(run(s, 'get_spending_patterns', { period: { month: '2026-02' } }).data.enough_data, false, 'só 3 despesas:');
});

// ============================================================ SKILL 3: orçamento
test('Skill 3 — situação dos orçamentos: limite, gasto, disponível e alertas', async () => {
  const s = await snap();
  const r = run(s, 'get_budget_status', {}).data;
  assertEqual(r.month.key, '2026-03');
  const by = Object.fromEntries(r.rows.map((x) => [x.category, x]));
  assertEqual(by['Alimentação'].spent.cents, 24000);
  assertEqual(by['Alimentação'].available.brl, 'R$ 10,00');
  assertEqual(by['Alimentação'].percent_used, 96);
  assertEqual(by['Alimentação'].level, 'atencao');
  assertEqual(by.Transporte.level, 'ok');
  assertEqual(r.totals.limit.cents, 75000);
  assertEqual(r.totals.spent.cents, 32000);
  assertEqual(r.totals.remaining.cents, 43000);
  assertEqual(r.totals.alerts, 1);
  assertEqual(r.uncategorized_expenses.count, 1, 'despesa sem categoria sinalizada:');
  assertEqual(by['Alimentação'].pending_review, null);
  assertEqual(r.rows[0].category, 'Alimentação', 'ordenado do mais consumido:');
});

test('Skill 3 — categorias próximas do limite, acima do limite e filtros', async () => {
  const s = await snap();
  const alerts = run(s, 'get_budget_status', { only_alerts: true }).data;
  assertEqual(alerts.rows.length, 1);
  assertEqual(alerts.rows[0].category, 'Alimentação');
  const over = await snap({ budgets: [{ id: 1, categoryId: 'alimentacao', limit: 20000 }] });
  const o = run(over, 'get_budget_status', {}).data.rows[0];
  assertEqual(o.level, 'excedido');
  assertEqual(o.exceeded_by.cents, 4000);
  assertEqual(o.available.cents, 0);
  const calm = await snap({ budgets: [{ id: 1, categoryId: 'transporte', limit: 50000 }] });
  const none = run(calm, 'get_budget_status', { only_alerts: true });
  assertEqual(none.data.rows.length, 0);
  assert(/Nenhuma categoria está próxima/.test(none.notes.join(' ')));
  assertEqual(run(s, 'get_budget_status', { category: 'Transporte' }).data.rows.length, 1);
  assert(/não tem orçamento/.test(run(s, 'get_budget_status', { category: 'Saúde' }).notes[0]));
  assertEqual(run(s, 'get_budget_status', { category: 'Inexistente' }).error.code, 'unknown_category');
  assertEqual(run(s, 'get_budget_status', { month: '2026-02' }).data.rows[0].spent.cents, 20000, 'outro mês:');
});

test('Skill 3 — sem orçamentos ou sem dados no mês: não inventa valor disponível', async () => {
  const semOrc = run(await snap({ budgets: [] }), 'get_budget_status', {});
  assertEqual(semOrc.data.no_budgets, true);
  const novembro = run(await snap({ today: '2026-11-26' }), 'get_budget_status', {});
  assertEqual(novembro.data.empty, true);
  assertEqual(novembro.data.rows, undefined, 'sem linhas "restam R$ 250" de um mês sem dados:');
  assert(/março de 2026/.test(novembro.notes[0]));
});

test('Skill 3 — projeção do mês: rotulada como projeção, com ritmo, total estimado e data', async () => {
  const s = await snap();
  const r = run(s, 'project_budget', {});
  const d = r.data;
  assertEqual(d.is_projection, true);
  assert(r.notes[0].includes('PROJEÇÃO'), 'aviso de projeção');
  assertEqual(d.days_elapsed, 15);
  const by = Object.fromEntries(d.rows.map((x) => [x.category, x]));
  assertEqual(by['Alimentação'].status, 'will_exceed');
  assertEqual(by['Alimentação'].daily_pace.cents, 1600);
  assertEqual(by['Alimentação'].projected_month_total.cents, 49600);
  assertEqual(by['Alimentação'].estimated_limit_date, '2026-03-16');
  assertEqual(by.Transporte.status, 'on_track');
  assertEqual(by.Transporte.estimated_limit_date, null);
  assertEqual(by.Transporte.projected_month_total.cents, 16533);
});

test('Skill 3 — projeção: já estourou, poucos dados, mês que não é o atual e dados desatualizados', async () => {
  const estourou = run(await snap({ budgets: [{ id: 1, categoryId: 'alimentacao', limit: 20000 }] }), 'project_budget', {}).data.rows[0];
  assertEqual(estourou.status, 'already_exceeded');
  assertEqual(estourou.exceeded_by.cents, 4000);
  const inicio = run(await snap({ today: '2026-03-03' }), 'project_budget', {}).data.rows[0];
  assertEqual(inicio.status, 'insufficient_data');
  const outro = run(await snap(), 'project_budget', { month: '2026-02' });
  assertEqual(outro.data.not_applicable, true);
  assert(/mês em andamento/.test(outro.notes[0]));
  const velho = run(await snap({ today: '2026-03-25' }), 'project_budget', {});
  assert(velho.notes.some((n) => /último lançamento/.test(n)), 'avisa dados desatualizados');
  assertEqual(run(await snap({ budgets: [] }), 'project_budget', {}).data.no_budgets, true);
  assertEqual(run(await snap({ today: '2026-11-26' }), 'project_budget', {}).data.empty, true);
});

// ============================================================ SKILL 4: ciclos
test('Skill 4 — fontes de renda e próximos recebimentos (inclui dia 30 em fevereiro)', async () => {
  const s = await snap();
  const list = run(s, 'list_income_sources', {}).data.sources;
  assertEqual(list.length, 2);
  assertEqual(list[0].schedule, 'Mensal, todo dia 15');
  const up = run(s, 'get_upcoming_income', {}).data;
  assertEqual(up.upcoming.map((u) => u.date).join(), '2026-03-15,2026-03-30,2026-04-15,2026-04-30', 'janela padrão de 60 dias:');
  assertEqual(run(s, 'get_upcoming_income', { days: 90 }).data.upcoming.length, 5);
  assertEqual(up.upcoming[0].days_until, 0);
  assertEqual(up.upcoming[1].days_until, 15);
  assertEqual(run(s, 'get_upcoming_income', { source: 'salário', limit: 2 }).data.upcoming.map((u) => u.source).join(), 'Salário,Salário');
  const fev = run(await snap({ today: '2026-02-10' }), 'get_upcoming_income', { source: 'Salário', limit: 1 }).data;
  assertEqual(fev.upcoming[0].date, '2026-02-28', 'dia 30 em fevereiro = último dia:');
  assert(/Nenhum recebimento/.test(run(s, 'get_upcoming_income', { days: 5, source: 'inexistente' }).notes[0]));
  assertEqual(run(await snap({ sources: [] }), 'get_upcoming_income', {}).error.code, 'no_income_sources');
  assertEqual(run(await snap({ sources: [] }), 'list_income_sources', {}).data.sources.length, 0);
});

test('Skill 4 — detalhes do ciclo atual, próximo, anterior e de um mês (valores reais)', async () => {
  const s = await snap();
  const cur = run(s, 'get_cycle_details', {}).data.cycles;
  const salario = cur.find((c) => c.source === 'Salário');
  assertEqual(salario.date, '2026-02-28', 'último recebimento já ocorrido (dia 30 de fev → 28):');
  assertEqual(salario.expected.cents, 450000);
  assertEqual(salario.received.cents, 450000, 'o salário de 05/03 foi ligado ao ciclo:');
  assertEqual(salario.allocated_total.cents, 59990);
  assertEqual(salario.realized.cents, 59990);
  assertEqual(salario.committed.cents, 0);
  assertEqual(salario.available_planned.cents, 390010);
  assertEqual(salario.available_real.cents, 390010);
  assertEqual(salario.commitment_percent, 13.3);
  assert(salario.expenses.length <= 10 && salario.expenses[0].part.cents === 30000, 'maiores despesas primeiro');
  const next = run(s, 'get_cycle_details', { when: 'next' }).data.cycles;
  assertEqual(next.map((c) => c.date).join(), '2026-03-30,2026-04-15');
  assertEqual(next[0].status, 'previsto');
  const last = run(s, 'get_cycle_details', { when: 'last', source: 'Salário' }).data.cycles;
  assertEqual(last[0].date, '2026-01-30');
  const month = run(s, 'get_cycle_details', { when: 'month', month: '2026-03' }).data.cycles;
  assertEqual(month.map((c) => c.date).join(), '2026-03-15,2026-03-30');
  assertEqual(run(s, 'get_cycle_details', { when: 'month' }).error.code, 'invalid_parameters', 'month obrigatório:');
  assert(/Nenhum ciclo/.test(run(s, 'get_cycle_details', { source: 'inexistente' }).notes[0]));
  assertEqual(run(await snap({ sources: [] }), 'get_cycle_details', {}).error.code, 'no_income_sources');
});

test('Skill 4 — quanto do próximo recebimento já está comprometido (modo atual x simulação)', async () => {
  const extra = [...fixtureTransactions(), T('2026-03-16', -10000, 'alimentacao', { desc: 'MERCADO' })];
  const auto = run(await snap({ today: '2026-03-20', transactions: extra }), 'get_upcoming_commitment', { source: 'Salário' });
  const d = auto.data;
  assertEqual(d.cycle.date, '2026-03-30');
  assertEqual(d.allocation_mode_in_use, 'auto');
  assertEqual(d.committed_in_current_mode.cents, 0, 'no modo automático nada vai para o recebimento futuro:');
  assertEqual(d.committed_if_next_receipt_pays_recent_expenses.cents, 10000);
  assertEqual(d.percent_committed_if_next_receipt_pays_recent_expenses, 2.2);
  assertEqual(d.available_if_next_receipt_pays_recent_expenses.cents, 440000);
  assert(auto.notes.some((n) => /simulação/.test(n)), 'explica que é simulação');
  const prox = run(await snap({ today: '2026-03-20', transactions: extra, allocationMode: 'proximo' }), 'get_upcoming_commitment', { source: 'Salário' }).data;
  assertEqual(prox.committed_in_current_mode.cents, 10000, 'no modo "próximo recebimento":');
  assert(/Nenhum recebimento futuro/.test(run(await snap(), 'get_upcoming_commitment', { source: 'inexistente' }).notes[0]));
});

test('Skill 4 — despesas sem alocação a ciclo', async () => {
  const tarde = [{ id: 1, name: 'A', frequency: 'mensal', day: 15, amount: 100000, startDate: '2026-03-01' }];
  const r = run(await snap({ sources: tarde }), 'get_pending_allocations', { period: { preset: 'tudo' } }).data;
  assertEqual(r.pending_count, 9, '8 despesas + 1 estorno antes do 1º recebimento:');
  assert(r.items.every((i) => i.reason.length > 10), 'cada item tem motivo');
  assertEqual(r.items.some((i) => i.description === 'PAGAMENTO 99 APP'), true);
  const mesmo = run(await snap({ sources: tarde }), 'get_pending_allocations', { period: { month: '2026-03' } }).data;
  assertEqual(mesmo.pending_count, 6, 'só março:');
  const nenhum = run(await snap({ sources: [] }), 'get_pending_allocations', { period: { preset: 'tudo' } });
  assertEqual(nenhum.data.pending_count, 9);
  assert(nenhum.notes.some((n) => /Sem fontes de renda/.test(n)));
  assertEqual(run(await snap(), 'get_pending_allocations', { period: { preset: 'tudo' } }).data.pending_count, 0, 'tudo alocado:');
  assert(run(await snap({ today: '2026-11-26' }), 'get_pending_allocations', {}).data.no_data_in_period);
});

// ============================================================ SKILL 1: categorização
test('Skill 1 — transações pendentes e sem categoria', async () => {
  const s = await snap();
  const all = run(s, 'get_pending_transactions', {}).data;
  assertEqual(all.pending_count, 2);
  assertEqual(all.pending_expense_total.cents, 24000);
  const sem = run(s, 'get_pending_transactions', { only_uncategorized: true }).data;
  assertEqual(sem.pending_count, 1);
  assertEqual(sem.transactions[0].description, 'PAGAMENTO 99 APP');
  assertEqual(sem.transactions[0].current_category, null);
  const limpo = run(await snap({ transactions: [T('2026-03-01', -100, 'compras')] }), 'get_pending_transactions', {});
  assertEqual(limpo.data.pending_count, 0);
  assert(/Nenhuma transação pendente/.test(limpo.notes[0]));
});

test('Skill 1 — sugestões usam as regras reais; 99 vai para revisão; manual é protegido; ids inexistentes', async () => {
  const s = await snap();
  const r = run(s, 'suggest_categorization', {}).data;
  assertEqual(r.count, 2);
  const n99 = r.suggestions.find((x) => x.description === 'PAGAMENTO 99 APP');
  assertEqual(n99.suggestion.category, null);
  assertEqual(n99.suggestion.needs_review, true);
  assert(/99/.test(n99.suggestion.reason), 'motivo cita a regra do 99');
  const loja = r.suggestions.find((x) => x.description === 'LOJA Y');
  assertEqual(loja.suggestion.category, 'Outros');
  assertEqual(loja.suggestion.confidence, 'baixa');
  assertEqual(loja.differs_from_current, true);
  const ifood = run(s, 'suggest_categorization', { transaction_ids: [6, 999] });
  assertEqual(ifood.data.suggestions[0].suggestion.category, 'Alimentação');
  assertEqual(ifood.data.suggestions[0].suggestion.confidence, 'alta');
  assertEqual(ifood.data.suggestions[0].differs_from_current, false);
  assert(ifood.notes.some((n) => /não correspondem/.test(n)));
  nextId = 1;
  const manual = await snap({ transactions: [T('2026-03-08', -15000, 'saude', { desc: 'LOJA Y', manual: true })] });
  const m = run(manual, 'suggest_categorization', { transaction_ids: [1] }).data.suggestions[0];
  assertEqual(m.protected_by_user, true);
  assert(/não a altera sozinho/.test(m.note));
  assertEqual(run(s, 'suggest_categorization', { transaction_ids: Array.from({ length: 21 }, (_, i) => i + 1) }).error.code, 'invalid_parameters');
});

test('Skill 1 — possíveis erros: estabelecimento em categorias diferentes e correção manual x regra', async () => {
  const txs = [
    T('2026-03-01', -1000, 'alimentacao', { desc: 'IFOOD A', merchant: 'ifood' }),
    T('2026-03-02', -2000, 'compras', { desc: 'IFOOD B', merchant: 'ifood' }),
    T('2026-03-03', -3000, 'saude', { desc: 'IFOOD C', merchant: 'ifood2', manual: true }),
    T('2026-03-04', -4000, null, { desc: 'ALGO' }),
  ];
  const r = run(await snap({ transactions: txs }), 'find_categorization_issues', {}).data;
  assertEqual(r.counts.inconsistent_merchants, 1);
  assertEqual(r.issues.find((i) => i.type === 'inconsistent_merchant').merchant, 'ifood');
  assertEqual(r.counts.manual_vs_rule, 1, 'manual contra a regra do iFood:');
  assertEqual(r.issues.find((i) => i.type === 'manual_vs_rule').rule_suggests, 'Alimentação');
  assertEqual(r.counts.uncategorized_expenses, 1);
  assertEqual(r.uncategorized_total.cents, 4000);
  const limpo = run(await snap({ transactions: [T('2026-03-01', -100, 'compras')] }), 'find_categorization_issues', {});
  assert(/Nenhum problema/.test(limpo.notes[0]));
});

test('Skill 1 — consultar regras existentes', async () => {
  const s = await snap();
  const all = run(s, 'get_categorization_rules', {}).data;
  assertEqual(all.count, (await baseData()).rules.length, 'todas as regras iniciais:');
  assert(all.rules.some((r) => r.pattern === '99' && r.category.includes('revisão')));
  assertEqual(run(s, 'get_categorization_rules', { origin: 'usuario' }).data.count, 0);
  assertEqual(run(s, 'get_categorization_rules', { origin: 'xx' }).error.code, 'invalid_parameters');
});

test('Skill 1 — propor correção: cria PROPOSTA, não altera nada e pede confirmação', async () => {
  clearProposals();
  const s = await snap();
  const r = run(s, 'propose_categorization', { transaction_ids: [8, 8, 11], category: 'saúde', remember: true });
  assertEqual(r.ok, true);
  assertEqual(r.data.requires_user_confirmation, true);
  assertEqual(r.data.applied, false);
  assertEqual(r.data.preview.transactions, 2, 'ids repetidos contam uma vez:');
  assertEqual(r.data.preview.will_change, 2);
  assertEqual(r.data.preview.rule_would_be_created_for.length, 2);
  assert(/NADA foi alterado/.test(r.notes[0]));
  const p = getProposal(r.data.proposal_id);
  assertEqual(p.status, 'pending');
  assertEqual(s.transactions.find((t) => t.id === 8).categoryId, 'compras', 'dados intactos:');
  const jaLa = run(s, 'propose_categorization', { transaction_ids: [8], category: 'Compras' }).data.preview;
  assertEqual(jaLa.already_in_category, 1);
  assertEqual(run(s, 'propose_categorization', { transaction_ids: [8], category: 'Inexistente' }).error.code, 'unknown_category');
  assertEqual(run(s, 'propose_categorization', { transaction_ids: [8, 777], category: 'Saúde' }).error.code, 'unknown_transactions');
  assertEqual(run(s, 'propose_categorization', { transaction_ids: [], category: 'Saúde' }).error.code, 'invalid_parameters');
  assertEqual(run(s, 'propose_categorization', { transaction_ids: Array.from({ length: 51 }, (_, i) => i + 1), category: 'Saúde' }).error.code, 'invalid_parameters');
  nextId = 1;
  const manual = await snap({ transactions: [T('2026-03-08', -100, 'saude', { desc: 'LOJA', manual: true })] });
  assertEqual(run(manual, 'propose_categorization', { transaction_ids: [1], category: 'Compras' }).data.preview.user_corrected_that_will_change, 1, 'avisa que sobrescreve correção manual:');
});

test('Alterações exigem confirmação: aplicar só com userConfirmed, uma vez, e respeitando as proteções', async () => {
  clearProposals();
  const db = await freshDb();
  const a = await addDbTx(db, 'COMPRA BAZAR DO ZE', -1500);
  const b = await addDbTx(db, 'COMPRA BAZAR DO ZE', -1800, '2026-03-11');
  await recategorize(db);
  const before = JSON.stringify(await db.getAll('transactions'));

  const s = await loadSnapshot(db, { today: '2026-03-15' });
  const proposal = executeToolCall(s, 'propose_categorization', { transaction_ids: [a], category: 'Alimentação', remember: true }).data.proposal_id;
  assertEqual(JSON.stringify(await db.getAll('transactions')), before, 'propor não grava nada:');

  const fails = async (fn) => { try { await fn(); return false; } catch { return true; } };
  assert(await fails(() => applyProposal(db, proposal)), 'sem confirmação');
  assert(await fails(() => applyProposal(db, proposal, { userConfirmed: 'sim' })), 'confirmação precisa ser exatamente true');
  assert(await fails(() => applyProposal(db, 'prop-inexistente', { userConfirmed: true })), 'proposta inexistente');
  assertEqual(JSON.stringify(await db.getAll('transactions')), before, 'tentativas recusadas não gravam nada:');

  const result = await applyProposal(db, proposal, { userConfirmed: true });
  assertEqual(result.changed, 1);
  assertEqual(result.rules, 1);
  const ta = await db.get('transactions', a);
  assertEqual(ta.categoryId, 'alimentacao');
  assertEqual(ta.manual, true, 'ficou protegida:');
  assertEqual((await db.get('transactions', b)).categoryId, 'alimentacao', 'a regra memorizada atingiu a outra, não manual:');
  assertEqual((await listRules(db)).filter((r) => r.origem === 'usuario').length, 1);
  assert(await fails(() => applyProposal(db, proposal, { userConfirmed: true })), 'não aplica duas vezes');

  const second = executeToolCall(await loadSnapshot(db, { today: '2026-03-15' }), 'propose_categorization', { transaction_ids: [b], category: 'Saúde' }).data.proposal_id;
  cancelProposal(second);
  assert(await fails(() => applyProposal(db, second, { userConfirmed: true })), 'proposta cancelada não aplica');
  assertEqual((await db.get('transactions', b)).categoryId, 'alimentacao');
  await dispose(db);
});

// ============================================================ MODO LOCAL: as 10 perguntas
const ask1 = async (q, s) => answerLocally(q, { snapshot: s || (await snap()) });
const toolOf = (a) => a.tools[0];

test('modo local — seleciona a ferramenta certa e responde com valores reais (as 10 perguntas)', async () => {
  const s = await snap();
  let a = await ask1('Quanto gastei com alimentação neste mês?', s);
  assertEqual(toolOf(a).name, 'get_expenses_by_category');
  assertEqual(toolOf(a).args.category, 'Alimentação');
  assertEqual(toolOf(a).args.period.preset, 'mes_atual');
  assert(a.paragraphs[0].includes('R$ 240,00'), a.paragraphs[0]);

  a = await ask1('Qual foi minha maior despesa nos últimos 30 dias?', s);
  assertEqual(toolOf(a).name, 'search_transactions');
  assertEqual(toolOf(a).args.sort, 'amount_desc');
  assertEqual(toolOf(a).args.period.preset, 'ultimos_30');
  assert(a.paragraphs[0].includes('R$ 300,00') && a.paragraphs[0].includes('IFOOD PIZZA'), a.paragraphs[0]);

  a = await ask1('Quanto gastei a mais em relação ao mês passado?', s);
  assertEqual(toolOf(a).name, 'compare_periods');
  assertEqual(toolOf(a).args.period_a.preset, 'mes_atual');
  assertEqual(toolOf(a).args.period_b.preset, 'mes_anterior');
  assert(a.paragraphs[0].includes('R$ 260,00** a mais'), a.paragraphs[0]);

  a = await ask1('Quanto ainda tenho disponível no orçamento?', s);
  assertEqual(toolOf(a).name, 'get_budget_status');
  assert(a.paragraphs[0].includes('R$ 430,00'), a.paragraphs[0]);

  a = await ask1('Quais categorias estão próximas do limite?', s);
  assertEqual(toolOf(a).name, 'get_budget_status');
  assertEqual(toolOf(a).args.only_alerts, true);
  assertEqual(a.table.rows.length, 1);
  assertEqual(a.table.rows[0][0], 'Alimentação');

  a = await ask1('Quanto do meu próximo salário já está comprometido?', s);
  assertEqual(toolOf(a).name, 'get_upcoming_commitment');
  assertEqual(toolOf(a).args.source, 'Salário');
  assert(a.paragraphs[0].includes('30/03/2026') && a.paragraphs[0].includes('R$ 4.500,00'), a.paragraphs[0]);

  a = await ask1('Quais despesas ainda não foram alocadas?', s);
  assertEqual(toolOf(a).name, 'get_pending_allocations');

  a = await ask1('Quais estabelecimentos mais aparecem nos meus extratos?', s);
  assertEqual(toolOf(a).name, 'get_top_merchants');
  assertEqual(a.table.rows[0][0], 'ifood');

  a = await ask1('Quanto recebi e quanto gastei neste período?', s);
  assertEqual(toolOf(a).name, 'get_financial_summary');
  assert(a.paragraphs[0].includes('R$ 4.500,00') && a.paragraphs[0].includes('R$ 599,90'), a.paragraphs[0]);

  a = await ask1('Quais foram minhas despesas recorrentes?', s);
  assertEqual(toolOf(a).name, 'get_recurring_expenses');
  assertEqual(a.table.rows[0][0], 'netflix');

  for (const q of EXAMPLE_QUESTIONS) assertEqual((await ask1(q, s)).unrecognized, undefined, q);
});

test('modo local — outras consultas, comandos, ajuda e perguntas que não entende', async () => {
  const s = await snap();
  assertEqual(toolOf(await ask1('quais transações estão pendentes de categorização?', s)).name, 'get_pending_transactions');
  assertEqual(toolOf(await ask1('sugira categorias para as pendentes', s)).name, 'suggest_categorization');
  assertEqual(toolOf(await ask1('há erros de categorização?', s)).name, 'find_categorization_issues');
  assertEqual(toolOf(await ask1('quais são minhas regras?', s)).name, 'get_categorization_rules');
  assertEqual(toolOf(await ask1('quais são os próximos recebimentos?', s)).name, 'get_upcoming_income');
  assertEqual(toolOf(await ask1('como está o ciclo atual?', s)).args.when, 'current');
  assertEqual(toolOf(await ask1('detalhes do próximo ciclo', s)).args.when, 'next');
  assertEqual(toolOf(await ask1('quais são minhas fontes de renda?', s)).name, 'list_income_sources');
  assertEqual(toolOf(await ask1('quando vou estourar o orçamento de alimentação?', s)).name, 'project_budget');
  assertEqual(toolOf(await ask1('meus gastos estão aumentando?', s)).name, 'get_spending_trend');
  assertEqual(toolOf(await ask1('quanto gastei no ifood?', s)).name, 'search_transactions');
  assertEqual(toolOf(await ask1('/resumo', s)).name, 'get_financial_summary');
  assertEqual(toolOf(await ask1('/orcamento', s)).name, 'get_budget_status');
  assertEqual((await ask1('ajuda', s)).help, true);
  assertEqual((await ask1('', s)).help, true);
  const x = await ask1('qual a capital da França?', s);
  assertEqual(x.unrecognized, true);
  assertEqual(x.tools.length, 0, 'não chama ferramenta nenhuma:');
  assert(!x.paragraphs.some((p) => /França|Paris/.test(p)), 'não inventa resposta');
});

test('modo local — períodos escritos no texto', async () => {
  const s = await snap({ defaultPeriod: { preset: 'ultimos_90' } });
  const p = (text) => extractPeriod(normalizeText(text), s);
  assertEqual(JSON.stringify(p('em fevereiro')), '{"month":"2026-02"}');
  assertEqual(JSON.stringify(p('em novembro de 2025')), '{"month":"2025-11"}');
  assertEqual(p('em dezembro').month, '2025-12', 'dezembro ainda não chegou em 2026:');
  assertEqual(p('no mês passado').preset, 'mes_anterior');
  assertEqual(p('neste mês').preset, 'mes_atual');
  assertEqual(p('nos últimos 90 dias').preset, 'ultimos_90');
  assertEqual(JSON.stringify(p('nos últimos 15 dias')), '{"start":"2026-03-01","end":"2026-03-15"}');
  assertEqual(JSON.stringify(p('ano passado')), '{"start":"2025-01-01","end":"2025-12-31"}');
  assertEqual(p('este ano').preset, 'ano_atual');
  assertEqual(p('neste período').preset, 'ultimos_90', 'usa o filtro do Painel:');
  assertEqual(p('quanto gastei'), null);
  const cmp = await ask1('Compare março com fevereiro');
  assertEqual(toolOf(cmp).name, 'compare_periods');
  assertEqual(JSON.stringify([toolOf(cmp).args.period_a, toolOf(cmp).args.period_b]), '[{"month":"2026-03"},{"month":"2026-02"}]', 'ordem citada no texto:');
  assert(cmp.paragraphs[0].includes('R$ 260,00** a mais'), cmp.paragraphs[0]);
  const resumoMes = await ask1('Quanto recebi e quanto gastei em março?');
  assertEqual(toolOf(resumoMes).name, 'get_financial_summary', '"em março" é período, não estabelecimento:');
  assertEqual(toolOf(resumoMes).args.period.month, '2026-03');
  assertEqual(toolOf(await ask1('Quanto gastei neste mês?')).name, 'get_financial_summary');
  assertEqual(toolOf(await ask1('Quanto gastei nos últimos 30 dias?')).name, 'get_financial_summary');
  assertEqual(toolOf(await ask1('Quanto gastei no iFood em março?')).name, 'search_transactions');
  const cmp1 = await ask1('Quanto gastei a mais em março?');
  assertEqual(JSON.stringify(toolOf(cmp1).args.period_b), '{"month":"2026-02"}', 'um mês só: compara com o anterior:');
  const feb = await ask1('Quanto gastei com alimentação no mês passado?');
  assert(feb.paragraphs[0].includes('R$ 200,00'), feb.paragraphs[0]);
  const feb2 = await ask1('Quanto gastei com alimentação em fevereiro?');
  assertEqual(toolOf(feb2).args.period.month, '2026-02');
  const dias = await ask1('Quanto gastei com alimentação nos últimos 15 dias?');
  assert(dias.paragraphs[0].includes('R$ 240,00'), dias.paragraphs[0]);
});

test('modo local — sem dados suficientes: explica o que falta, sem números inventados', async () => {
  const vazio = await snap({ transactions: [], budgets: [], sources: [] });
  const check = async (q, re) => {
    const a = await ask1(q, vazio);
    const text = a.paragraphs.join(' ');
    assert(re.test(text), `${q} → ${text}`);
    assert(!/R\$ \d/.test(text), `${q} não pode ter valores: ${text}`);
  };
  await check('Quanto gastei com alimentação neste mês?', /Não encontrei transações/);
  await check('Quanto gastei a mais em relação ao mês passado?', /Não consigo comparar/);
  await check('Quanto recebi e quanto gastei neste período?', /Não encontrei transações/);
  await check('Quais foram minhas despesas recorrentes?', /Ainda não consigo/);
  await check('Quanto ainda tenho disponível no orçamento?', /não cadastrou orçamentos/);
  await check('Quanto do meu próximo salário já está comprometido?', /Cadastre|cadastr/);
  await check('Quais estabelecimentos mais aparecem nos meus extratos?', /Não encontrei transações/);
  const nov = await ask1('Quanto gastei com alimentação neste mês?', await snap({ today: '2026-11-26' }));
  assert(/novembro de 2026/.test(nov.paragraphs[0]) && /março de 2026/.test(nov.paragraphs[0]), 'sugere o mês com dados: ' + nov.paragraphs[0]);
});

test('modo local — categorizar por conversa gera proposta (sem alterar nada)', async () => {
  clearProposals();
  const s = await snap();
  const a = await ask1('categorizar netflix como entretenimento e memorizar', s);
  assertEqual(a.tools.map((t) => t.name).join(), 'search_transactions,propose_categorization');
  assertEqual(a.proposals.length, 1);
  const p = getProposal(a.proposals[0]);
  assertEqual(p.status, 'pending');
  assertEqual(p.categoryId, 'entretenimento');
  assertEqual(p.remember, true);
  assertEqual(p.transactionIds.length, 2);
  assert(a.paragraphs.join(' ').includes('Nada foi alterado ainda'));
  const none = await ask1('categorizar xyzinexistente como saúde', s);
  assertEqual(none.proposals.length, 0);
  assert(/Não encontrei/.test(none.paragraphs[0]));
  const semCat = await ask1('categorizar netflix como xablau', s);
  assert(/categorizar iFood como Alimentação/i.test(semCat.paragraphs[0]) || /Para propor/.test(semCat.paragraphs[0]));
});

// ============================================================ cliente do backend e modo IA
test('backend: o endereço é validado (https, sem senha, sem parâmetros)', () => {
  assertEqual(normalizeEndpoint('https://api.exemplo.com/'), 'https://api.exemplo.com');
  assertEqual(normalizeEndpoint('https://api.exemplo.com/app/'), 'https://api.exemplo.com/app');
  assertEqual(normalizeEndpoint('http://localhost:8787'), 'http://localhost:8787');
  const bad = (u) => { try { normalizeEndpoint(u); return false; } catch (e) { return e instanceof BackendError; } };
  assert(bad('http://api.exemplo.com'), 'http remoto');
  assert(bad('ftp://x.com'));
  assert(bad('https://user:pass@x.com'), 'usuário e senha');
  assert(bad('https://x.com/?key=abc'), 'chave na URL');
  assert(bad('https://x.com/#token'));
  assert(bad('não é url'));
  assert(bad(''));
});

test('backend: respostas fora do contrato são recusadas', () => {
  const ok = validateTurnResponse({ type: 'message', content: 'Olá' });
  assertEqual(ok.content, 'Olá');
  assertEqual(validateTurnResponse({ type: 'tool_calls', calls: [{ id: 'a', name: 'x', arguments: { n: 1 } }] }).calls.length, 1);
  assertEqual(validateTurnResponse({ type: 'tool_calls', calls: [{ id: 'a', name: 'x' }] }).calls[0].arguments.constructor, Object, 'arguments ausente vira {}:');
  const bad = (b) => { try { validateTurnResponse(b); return false; } catch (e) { return e.code === 'invalid_response'; } };
  assert(bad(null)); assert(bad('texto')); assert(bad([])); assert(bad({})); assert(bad({ type: 'outro' }));
  assert(bad({ type: 'message' }), 'sem content');
  assert(bad({ type: 'message', content: '   ' }));
  assert(bad({ type: 'message', content: 'x'.repeat(8001) }), 'longa demais');
  assert(bad({ type: 'tool_calls', calls: [] }));
  assert(bad({ type: 'tool_calls', calls: Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, name: 'x', arguments: {} })) }), 'mais de 5');
  assert(bad({ type: 'tool_calls', calls: [{ id: '', name: 'x', arguments: {} }] }));
  assert(bad({ type: 'tool_calls', calls: [{ id: 'a', name: 'x', arguments: [] }] }), 'arguments como lista');
  assert(bad({ type: 'tool_calls', calls: [{ id: 'a', name: 'x', arguments: 'texto' }] }));
});

test('backend: teste de conexão e falhas (HTTP, rede, JSON inválido, protocolo, tempo esgotado)', async () => {
  const mk = (handler, opts = {}) => new AgentBackendClient('https://api.exemplo.com', { fetchImpl: createMockFetch(handler).fetchImpl, ...opts });
  const info = await mk(undefined).health();
  assertEqual(info.provider, 'mock');
  const code = async (client, fn = (c) => c.health()) => { try { await fn(client); return 'sem erro'; } catch (e) { return e.code; } };
  assertEqual(await code(mk(() => jsonResponse({}, 500))), 'http_error');
  assertEqual(await code(mk(() => new Response('<html>', { status: 200 }))), 'invalid_response');
  assertEqual(await code(mk(() => ({ ok: true, protocolVersion: 99 }))), 'protocol_mismatch');
  assertEqual(await code(mk(() => ({ ok: false, protocolVersion: 1 }))), 'invalid_response');
  assertEqual(await code(mk(() => { throw new Error('rede caiu'); })), 'network');
  assertEqual(await code(mk(() => new Promise(() => {}), { timeoutMs: 40 })), 'timeout', 'sem resposta → tempo esgotado:');
  assertEqual(await code(mk(() => ({ type: 'lixo' })), (c) => c.turn({ sessionId: 's', messages: [], tools: [], today: '2026-03-15' })), 'invalid_response');
});

test('privacidade e segurança do pedido: sem chave, sem cookies, sem dados brutos antes das ferramentas', async () => {
  const { fetchImpl, requests } = createMockFetch();
  const client = new AgentBackendClient('https://api.exemplo.com', { fetchImpl });
  const s = await snap();
  const out = await runAiTurn({ client, text: 'Quanto gastei com alimentação neste mês?', snapshot: s });
  assertEqual(requests.length, 2, 'uma rodada de ferramenta + resposta final:');
  const first = requests[0];
  assertEqual(first.path, '/v1/agent/turn');
  assertEqual(first.credentials, 'omit');
  assertEqual(Object.keys(first.headers).sort().join(), 'Accept,Content-Type', 'nenhum cabeçalho de autorização:');
  assert(!/api[_-]?key|authorization|bearer|secret|token/i.test(first.rawBody), 'corpo sem chaves');
  assertEqual(first.body.protocolVersion, 1);
  assertEqual(first.body.tools.length, 20);
  assert(first.body.tools.every((t) => t.read_only === true && !('handler' in t)));
  for (const raw of ['IFOOD PIZZA', 'NETFLIX', 'SALARIO EMPRESA', 'LOJA Y', '500000', 'sourceLine']) {
    assert(!first.rawBody.includes(raw), `o 1º pedido não deve conter dados brutos: ${raw}`);
  }
  assertEqual(first.body.messages.length, 1);
  const second = requests[1].body.messages;
  assertEqual(second.map((m) => m.role).join(), 'user,assistant,tool');
  assert(second[2].content.includes('R$ 240,00'), 'só o resultado resumido da ferramenta é enviado');
  assert(!requests[1].rawBody.includes('NETFLIX'), 'nem os outros dados');
  assertEqual(out.sentToModel.length, 1);
  assert(out.content.includes('R$ 240,00'), 'resposta final baseada no valor real: ' + out.content);
  assertEqual(out.trace[0].name, 'get_expenses_by_category');
});

test('modo IA — ferramentas inexistentes, parâmetros inválidos e tentativa de escrita são contidos', async () => {
  const s = await snap();
  const before = JSON.stringify(s.transactions);
  clearProposals();
  for (const [text, code] of [['apagar tudo', 'unknown_tool'], ['aplicar categoria', 'unknown_tool'], ['parametro-ruim', 'invalid_parameters']]) {
    const { fetchImpl, requests } = createMockFetch();
    const out = await runAiTurn({ client: new AgentBackendClient('https://x.com', { fetchImpl }), text, snapshot: s });
    assertEqual(out.trace[0].ok, false, text);
    assertEqual(out.trace[0].result.error.code, code, text);
    const toolMsg = requests[1].body.messages.find((m) => m.role === 'tool');
    assertEqual(JSON.parse(toolMsg.content).ok, false, 'o erro volta ao modelo para ele corrigir:');
    assert(out.content.startsWith('Não consegui consultar'), out.content);
  }
  const { fetchImpl } = createMockFetch();
  const prop = await runAiTurn({ client: new AgentBackendClient('https://x.com', { fetchImpl }), text: 'propor categoria', snapshot: s });
  assertEqual(prop.trace[0].ok, true);
  assertEqual(prop.trace[0].result.data.applied, false);
  assertEqual(getProposal(prop.trace[0].result.data.proposal_id).status, 'pending', 'só proposta, nunca aplicada:');
  assertEqual(JSON.stringify(s.transactions), before, 'dados intactos:');
});

test('modo IA — laço de ferramentas tem limite (sem repetir para sempre)', async () => {
  const { fetchImpl, requests } = createMockFetch((path, body) => (path === '/v1/health' ? { ok: true, protocolVersion: 1 }
    : { type: 'tool_calls', calls: [{ id: `c${body.messages.length}`, name: 'get_financial_summary', arguments: {} }] }));
  let erro = null;
  try { await runAiTurn({ client: new AgentBackendClient('https://x.com', { fetchImpl }), text: 'oi', snapshot: await snap() }); } catch (e) { erro = e; }
  assertEqual(erro?.code, 'too_many_steps');
  assertEqual(requests.length, MAX_STEPS);
});

// ============================================================ orquestrador: modos, configuração e falhas
test('modos: padrão é local; IA só com backend configurado; endereço salvo sem chave', async () => {
  await withSettings(async () => {
    clearEndpoint();
    let cfg = getAssistantConfig();
    assertEqual(cfg.mode, 'local');
    assertEqual(cfg.effectiveMode, 'local');
    assertEqual(cfg.endpointValid, false);
    let erro = null;
    try { setAssistantMode('llm'); } catch (e) { erro = e; }
    assertEqual(erro?.code, 'not_configured', 'não dá para ligar a IA sem backend:');
    assertEqual(getAssistantConfig().mode, 'local');
    erro = null;
    try { saveEndpoint('http://remoto.com'); } catch (e) { erro = e; }
    assertEqual(erro?.code, 'insecure_endpoint');
    assertEqual(saveEndpoint('https://meu-backend.exemplo.com/'), 'https://meu-backend.exemplo.com');
    setAssistantMode('llm');
    cfg = getAssistantConfig();
    assertEqual(cfg.effectiveMode, 'llm');
    const stored = JSON.stringify(Object.fromEntries(Object.entries(localStorage).filter(([k]) => k.startsWith('mfa:'))));
    assert(!/key|secret|token|bearer|authorization/i.test(stored), 'nada parecido com chave guardado: ' + stored);
    clearEndpoint();
    assertEqual(getAssistantConfig().effectiveMode, 'local', 'remover o endereço volta ao modo local:');
  });
});

test('modo local não faz NENHUMA chamada de rede e não afirma usar IA', async () => {
  await withSettings(async () => {
    clearEndpoint();
    const db = await freshDb();
    await addDbTx(db, 'COMPRA IFOOD *PIZZA', -3000, '2026-03-10');
    await recategorize(db);
    const { fetchImpl, requests } = createMockFetch();
    const reply = await ask('Quanto gastei com alimentação neste mês?', { db, today: '2026-03-15', fetchImpl });
    assertEqual(requests.length, 0, 'nenhuma requisição:');
    assertEqual(reply.mode, 'local');
    assert(reply.paragraphs[0].includes('R$ 30,00'), reply.paragraphs[0]);
    assertEqual(reply.fallbackNotice, null);
    assert(!/\bIA\b|inteligência artificial|modelo de linguagem|LLM/i.test(reply.paragraphs.join(' ')), 'não finge ser IA');
    await dispose(db);
  });
});

test('modo IA conectada: o app consulta o backend, executa as ferramentas e responde com valores reais', async () => {
  await withSettings(async () => {
    saveEndpoint('https://meu-backend.exemplo.com');
    setAssistantMode('llm');
    const db = await freshDb();
    await addDbTx(db, 'COMPRA IFOOD *PIZZA', -3000, '2026-03-10');
    await recategorize(db);
    const before = JSON.stringify(await db.getAll('transactions'));
    const { fetchImpl, requests } = createMockFetch();
    const reply = await ask('Quanto gastei com alimentação neste mês?', { db, today: '2026-03-15', fetchImpl });
    assertEqual(reply.mode, 'ai');
    assert(reply.paragraphs[0].includes('R$ 30,00'), reply.paragraphs[0]);
    assertEqual(reply.tools[0].name, 'get_expenses_by_category');
    assertEqual(reply.sentToModel.length, 1);
    assert(reply.dataViews.length === 1 && reply.dataViews[0].paragraphs[0].includes('R$ 30,00'), 'mostra os dados consultados');
    assertEqual(requests.length, 2);
    assertEqual(JSON.stringify(await db.getAll('transactions')), before, 'consulta não altera dados:');
    const info = await testConnection({ fetchImpl });
    assertEqual(info.model, 'modelo-de-teste');
    await dispose(db);
  });
});

test('falha do backend: cai no modo local COM aviso claro (HTTP, rede, resposta inválida)', async () => {
  await withSettings(async () => {
    saveEndpoint('https://meu-backend.exemplo.com');
    setAssistantMode('llm');
    const db = await freshDb();
    await addDbTx(db, 'COMPRA IFOOD *PIZZA', -3000, '2026-03-10');
    await recategorize(db);
    const cenarios = {
      'erro HTTP': () => jsonResponse({}, 503),
      'rede': () => { throw new Error('offline'); },
      'resposta inválida': () => ({ type: 'invenção' }),
      'JSON quebrado': () => new Response('não é json', { status: 200 }),
    };
    for (const [nome, handler] of Object.entries(cenarios)) {
      const { fetchImpl } = createMockFetch(handler);
      const reply = await ask('Quanto gastei com alimentação neste mês?', { db, today: '2026-03-15', fetchImpl });
      assertEqual(reply.mode, 'local', nome);
      assert(/A IA conectada não respondeu/.test(reply.fallbackNotice), `${nome}: ${reply.fallbackNotice}`);
      assert(/sem IA generativa/.test(reply.fallbackNotice), 'diz que a resposta é do modo local');
      assert(reply.fallbackReason.length > 10, 'informa o motivo');
      assert(reply.paragraphs[0].includes('R$ 30,00'), `${nome}: a pergunta ainda é respondida: ${reply.paragraphs[0]}`);
    }
    await dispose(db);
  });
});

test('segurança do front-end: nenhuma chave de API em HTML, CSS ou JavaScript do navegador', async () => {
  const files = [
    '../index.html', '../css/styles.css', '../js/app.js', '../js/storage.js', '../js/ui/assistente.js', '../js/ui/dashboard.js',
    ...['validate', 'snapshot', 'tools', 'results', 'periodParam', 'localAgent', 'formatters', 'proposals', 'proposalApply', 'orchestrator'].map((f) => `../js/agent/${f}.js`),
    '../js/agent/llm/backendClient.js', '../js/agent/llm/aiAgent.js',
    ...['analiseFinanceira', 'monitoramentoOrcamento', 'ciclosRecebimento', 'categorizacao'].map((f) => `../js/agent/skills/${f}.js`),
  ];
  const keyPatterns = [/sk-[A-Za-z0-9_-]{16,}/, /sk-ant-[A-Za-z0-9_-]{10,}/, /AIza[0-9A-Za-z_-]{20,}/, /AKIA[0-9A-Z]{16}/, /(api[_-]?key|secret|bearer)\s*[:=]\s*['"][^'"]{8,}['"]/i, /ghp_[A-Za-z0-9]{20,}/];
  for (const file of files) {
    const text = await (await fetch(file)).text();
    for (const re of keyPatterns) assert(!re.test(text), `${file} contém algo parecido com uma chave (${re})`);
  }
  const client = await (await fetch('../js/agent/llm/backendClient.js')).text();
  assert(!/Authorization/i.test(client.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')), 'o cliente não envia Authorization');
  const ui = await (await fetch('../js/ui/assistente.js')).text();
  assert(!/type="password"/.test(ui) && !/api-?key/i.test(ui.replace(/chave de API/gi, '')), 'a tela não tem campo de chave');
  const storage = await (await fetch('../js/storage.js')).text();
  assert(!/apiKey|api_key/i.test(storage), 'configurações não têm campo de chave');
});

test('segurança da tela: texto vindo da IA é escapado (sem HTML)', () => {
  assertEqual(richText('<img src=x onerror=alert(1)> **ok**'), '&lt;img src=x onerror=alert(1)&gt; <strong>ok</strong>');
  assertEqual(richText('<script>x</script>'), '&lt;script&gt;x&lt;/script&gt;');
});

test('documentação do agente existe (4 SKILL.md, arquitetura, ferramentas, API e configuração)', async () => {
  const docs = ['../skills/categorizacao/SKILL.md', '../skills/analise-financeira/SKILL.md', '../skills/monitoramento-orcamento/SKILL.md',
    '../skills/ciclos-recebimento/SKILL.md', '../docs/AGENTE.md', '../docs/FERRAMENTAS.md', '../docs/API-BACKEND.md', '../docs/CONFIGURAR-LLM.md'];
  for (const path of docs) {
    const response = await fetch(path);
    assert(response.ok, `${path} não encontrado`);
    assert((await response.text()).length > 500, `${path} muito curto`);
  }
  const catalog = await (await fetch('../docs/FERRAMENTAS.md')).text();
  for (const name of TOOLS.keys()) assert(catalog.includes(`\`${name}\``), `FERRAMENTAS.md não cita ${name}`);
  for (const skill of SKILLS) {
    const md = await (await fetch(`../skills/${skill.id}/SKILL.md`)).text();
    assert(md.startsWith('---'), `${skill.id}: cabeçalho`);
    for (const tool of skill.tools) assert(md.includes(`\`${tool.name}\``), `SKILL.md de ${skill.id} não cita ${tool.name}`);
  }
});

test('fakeLlm de teste responde só com valores recebidos (sanidade do próprio teste)', () => {
  const body = { messages: [{ role: 'user', content: 'x' }, { role: 'tool', content: JSON.stringify({ ok: true, data: { total: { cents: 1, brl: 'R$ 0,01' } } }) }] };
  assertEqual(fakeLlm(body).content, 'Pelos seus dados: R$ 0,01.');
});
