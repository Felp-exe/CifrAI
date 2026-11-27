import { test, assert, assertEqual } from './runner.js';
import { Database, deleteDatabase } from '../js/db.js';
import { seedDefaults } from '../js/seed.js';
import { normalizeText } from '../js/utils/format.js';
import { resolvePeriod, defaultPreset, referenceMonth, statementPeriod, PRESETS } from '../js/dashboard/period.js';
import {
  summarize, inPeriod, expensesByCategory, chartMonths, monthlySeries, spendingTrend, balanceSeries,
} from '../js/dashboard/analytics.js';
import { buildInsights, findRecurring } from '../js/dashboard/insights.js';
import { analyzeCycles, barSegments } from '../js/dashboard/cyclesAnalysis.js';
import { buildDashboard, loadDashboard, nextReceipts } from '../js/dashboard/dashboardData.js';
import { buildModel } from '../js/cycles/model.js';
import { spentByCategory, monthlyBudgetReport } from '../js/budget/budgetEngine.js';
import {
  incomeVsExpenses, categoryDoughnut, balanceLine, spendingBars, budgetBars,
} from '../js/charts/chartConfigs.js';
import { loadChart, themeColors, drawChart } from '../js/charts/chartLoader.js';
import { analyzePdf, saveReviewed } from '../js/import/importService.js';
import { setCategory, recategorize } from '../js/categorization/transactionService.js';
import { createSource } from '../js/cycles/incomeService.js';
import { createBudget } from '../js/budget/budgetService.js';

const TODAY = '2026-03-15';
const CATS = [
  { id: 'alimentacao', nome: 'Alimentação', cor: '#f59e0b' },
  { id: 'transporte', nome: 'Transporte', cor: '#3b82f6' },
  { id: 'compras', nome: 'Compras', cor: '#ec4899' },
  { id: 'assinaturas', nome: 'Assinaturas', cor: '#6366f1' },
  { id: 'moradia', nome: 'Moradia', cor: '#8b5cf6' },
];
const COLORS = { text: '#111', muted: '#666', grid: '#ddd', surface: '#fff', primary: '#0a7', positive: '#080', negative: '#b00', warning: '#c60' };

let nextId = 1;
const T = (date, amount, categoryId = null, extra = {}) => ({
  id: nextId++, date, amount, categoryId, status: 'classificada',
  type: amount > 0 ? 'pix_recebido' : 'compra', originalDescription: extra.desc || 'X', normalizedName: normalizeText(extra.desc || 'x'), ...extra,
});

/** Conjunto de referência (valores em centavos) usado em vários testes. */
function dataset() {
  nextId = 1;
  return [
    T('2026-02-05', 500000, null, { desc: 'SALARIO' }),
    T('2026-02-10', -20000, 'alimentacao'),
    T('2026-02-12', -10000, 'transporte'),
    T('2026-02-20', -3990, 'assinaturas', { merchantName: 'netflix', desc: 'NETFLIX' }),
    T('2026-02-25', -5000, null, { status: 'pendente' }),
    T('2026-03-05', 450000, null, { desc: 'SALARIO' }),
    T('2026-03-06', -30000, 'alimentacao'),
    T('2026-03-07', -8000, 'transporte'),
    T('2026-03-08', -15000, 'compras', { status: 'pendente' }),
    T('2026-03-09', 6000, 'alimentacao', { type: 'estorno', desc: 'ESTORNO' }),
    T('2026-03-12', -3990, 'assinaturas', { merchantName: 'netflix', desc: 'NETFLIX' }),
  ];
}
const catMap = () => new Map(CATS.map((c) => [c.id, c]));
const period = (preset = 'mes_atual', custom = {}, txs = []) => resolvePeriod(preset, { today: TODAY, custom, transactions: txs });

function deepFreeze(x) {
  if (x && typeof x === 'object' && !Object.isFrozen(x)) { Object.freeze(x); Object.values(x).forEach(deepFreeze); }
  return x;
}

let counter = 0;
async function freshDb() {
  const name = `mfa-test-dash-${Date.now()}-${counter++}`;
  const db = await new Database(name).open();
  await seedDefaults(db, '../data/');
  db._testName = name;
  return db;
}
async function dispose(db) { db.close(); await deleteDatabase(db._testName); }

// ------------------------------------------------------------ filtros de período
test('período: todos os filtros calculam as datas certas', () => {
  const r = (p) => { const x = period(p, {}, dataset()); return `${x.start}..${x.end}`; };
  assertEqual(r('mes_atual'), '2026-03-01..2026-03-31');
  assertEqual(r('mes_anterior'), '2026-02-01..2026-02-28');
  assertEqual(r('ultimos_30'), '2026-02-14..2026-03-15');
  assertEqual(r('ultimos_90'), '2025-12-16..2026-03-15');
  assertEqual(r('ano_atual'), '2026-01-01..2026-12-31');
  assertEqual(r('ultimo_com_dados'), '2026-03-01..2026-03-31');
  assertEqual(period('personalizado', { start: '2026-01-10', end: '2026-02-20' }).label, '10/01/2026 a 20/02/2026');
  assertEqual(Object.keys(PRESETS).length, 8);
});

test('período: mês anterior em janeiro volta para dezembro; período personalizado inválido é recusado', () => {
  const jan = resolvePeriod('mes_anterior', { today: '2026-01-10' });
  assertEqual(`${jan.start}..${jan.end}`, '2025-12-01..2025-12-31');
  for (const custom of [{}, { start: '2026-03-10', end: '2026-03-01' }, { start: '2026-02-30', end: '2026-03-01' }]) {
    const p = period('personalizado', custom);
    assertEqual(p.valid, false);
    assert(p.error.length > 5, 'mensagem explicando');
  }
  assertEqual(period('personalizado', { start: '2026-03-01', end: '2026-03-01' }).valid, true, 'um dia só vale:');
});

test('período: filtro inicial usa o mês atual ou o mais recente com dados; mês de referência', () => {
  assertEqual(defaultPreset(dataset(), TODAY), 'mes_atual');
  assertEqual(defaultPreset(dataset(), '2026-11-26'), 'ultimo_com_dados');
  assertEqual(defaultPreset([], '2026-11-26'), 'mes_atual');
  assertEqual(referenceMonth(period('ano_atual'), TODAY), '2026-03', 'período que termina no futuro:');
  assertEqual(referenceMonth(period('mes_anterior'), TODAY), '2026-02');
  assertEqual(referenceMonth(period('ultimos_90'), TODAY), '2026-03');
  assertEqual(referenceMonth(period('personalizado', { start: '2025-11-01', end: '2025-12-31' }), TODAY), '2025-12');
});

test('período: transações das pontas entram, as de fora não', () => {
  const txs = [T('2026-02-28', -100), T('2026-03-01', -200), T('2026-03-31', -300), T('2026-04-01', -400)];
  const rows = inPeriod(txs, period('mes_atual'));
  assertEqual(rows.map((t) => t.amount).join(), '-200,-300');
});

// ------------------------------------------------------------ totais
test('painel sem transações: tudo zerado, sem erro', () => {
  const s = summarize([]);
  assertEqual(s.income + s.expensesNet + s.balance + s.pending.count, 0);
  const model = buildModel({ transactions: [], sources: [], today: TODAY });
  const d = buildDashboard({ model, categories: CATS, budgets: [], preset: 'mes_atual', custom: {}, today: TODAY });
  assertEqual(d.hasTransactions, false);
  assertEqual(d.isEmptyPeriod, true);
  assertEqual(d.byCategory.length, 0);
  assertEqual(d.budgetUsage, null);
  assertEqual(d.insights.items.length, 0, 'nenhum insight inventado:');
  assertEqual(d.insights.unavailable.length, 6, 'todos explicam o que falta:');
  assertEqual(d.cycles.cycles.length, 0);
});

test('totais do período: receitas, despesas, estornos e saldo (cada transação conta uma vez)', () => {
  const rows = inPeriod(dataset(), period('mes_atual'));
  const s = summarize(rows);
  assertEqual(s.income, 450000, 'receitas (estorno não é receita):');
  assertEqual(s.expensesGross, 56990, 'despesas brutas:');
  assertEqual(s.refunds, 6000);
  assertEqual(s.expensesNet, 50990, 'despesas líquidas = brutas − estornos:');
  assertEqual(s.balance, 399010);
  assertEqual(s.balance, rows.reduce((sum, t) => sum + t.amount, 0), 'saldo = soma de todas as movimentações:');
  assertEqual(s.incomeCount, 1);
  assertEqual(s.expenseCount, 4);
  assertEqual(s.pending.count, 1, 'só despesas pendentes entram:');
  assertEqual(s.pending.amount, 15000);
});

test('entradas nunca viram despesa e estornos nunca viram receita', () => {
  const s = summarize([T('2026-03-01', 100000), T('2026-03-02', 5000, 'compras', { type: 'estorno' })]);
  assertEqual(s.income, 100000);
  assertEqual(s.expensesGross, 0);
  assertEqual(s.expensesNet, -5000, 'estorno sem compra no período: efeito real, despesa líquida negativa:');
  assertEqual(s.balance, 105000);
});

test('mudar o período muda os totais (mês atual x anterior x ano)', () => {
  const txs = dataset();
  const sum = (p) => summarize(inPeriod(txs, period(p, {}, txs)));
  assertEqual(sum('mes_atual').income, 450000);
  assertEqual(sum('mes_anterior').income, 500000);
  assertEqual(sum('mes_anterior').expensesNet, 20000 + 10000 + 3990 + 5000);
  assertEqual(sum('ano_atual').income, 950000);
  assertEqual(sum('ultimos_30').income, 450000, 'últimos 30 dias (14/02 a 15/03) não pega o salário de 05/02:');
  const custom = summarize(inPeriod(txs, period('personalizado', { start: '2026-03-06', end: '2026-03-08' })));
  assertEqual(custom.expensesNet, 30000 + 8000 + 15000, 'só 06, 07 e 08/03:');
});

// ------------------------------------------------------------ categorias
test('despesas por categoria: líquidas, ordenadas, com percentual e "Sem categoria"', () => {
  const rows = inPeriod(dataset(), period('mes_anterior'));
  const list = expensesByCategory(rows, catMap());
  assertEqual(list.map((c) => c.name).join(), 'Alimentação,Transporte,Sem categoria,Assinaturas');
  assertEqual(list[0].value, 20000);
  assertEqual(list.find((c) => c.name === 'Sem categoria').value, 5000);
  assertEqual(Math.round(list.reduce((s, c) => s + c.percent, 0)), 100);
  assertEqual(list.reduce((s, c) => s + c.value, 0), summarize(rows).expensesNet, 'as fatias somam as despesas:');
});

test('despesas por categoria: estorno abate a categoria; fatias zeradas não aparecem', () => {
  const rows = inPeriod(dataset(), period('mes_atual'));
  const list = expensesByCategory(rows, catMap());
  assertEqual(list.find((c) => c.categoryId === 'alimentacao').value, 24000, '30000 − 6000 de estorno:');
  const zero = expensesByCategory([T('2026-03-01', -5000, 'compras'), T('2026-03-02', 5000, 'compras', { type: 'estorno' })], catMap());
  assertEqual(zero.length, 0, 'comprou e devolveu: nada a mostrar:');
});

test('gráfico por categoria bate com o orçamento (mesma regra de gasto)', () => {
  const txs = dataset();
  const byCat = expensesByCategory(inPeriod(txs, period('mes_atual')), catMap());
  const budgetSpent = spentByCategory(txs, '2026-03');
  for (const c of byCat.filter((x) => x.categoryId)) {
    assertEqual(c.value, budgetSpent.get(c.categoryId).net, `${c.name}:`);
  }
});

// ------------------------------------------------------------ meses, comparação e saldo
test('meses dos gráficos: inclui mês anterior só até onde há dados', () => {
  const txs = dataset();
  assertEqual(chartMonths(period('mes_atual'), txs).join(), '2026-02,2026-03');
  assertEqual(chartMonths(period('ano_atual'), txs).join(), '2026-01,2026-02,2026-03,2026-04,2026-05,2026-06,2026-07,2026-08,2026-09,2026-10,2026-11,2026-12');
  assertEqual(chartMonths(period('personalizado', { start: '2026-02-01', end: '2026-02-28' }), txs).join(), '2026-02', 'não inventa meses antes dos dados:');
});

test('comparação entre meses: série mensal e variação dos gastos', () => {
  const txs = dataset();
  const p = period('mes_atual');
  const series = monthlySeries(txs, chartMonths(p, txs), p);
  assertEqual(series.length, 2);
  assertEqual(series[0].month, '2026-02');
  assertEqual(series[0].income, 500000);
  assertEqual(series[0].expensesNet, 38990);
  assertEqual(series[1].expensesNet, 50990);
  assertEqual(series[1].partial, false);
  const trend = spendingTrend(series);
  assertEqual(trend[0].delta, null);
  assertEqual(trend[1].delta, 12000, 'aumento de R$ 120,00:');
  assertEqual(Math.round(trend[1].deltaPercent * 10) / 10, 30.8);
  const down = spendingTrend([{ month: 'a', expensesNet: 10000 }, { month: 'b', expensesNet: 4000 }]);
  assertEqual(down[1].delta, -6000, 'redução:');
});

test('série mensal: meses parciais só contam os dias do período', () => {
  const txs = dataset();
  const p = period('ultimos_30');
  const series = monthlySeries(txs, chartMonths(p, txs), p);
  const feb = series.find((s) => s.month === '2026-02');
  const mar = series.find((s) => s.month === '2026-03');
  assertEqual(feb.partial, true);
  assertEqual(feb.income, 0, 'salário de 05/02 está fora dos últimos 30 dias:');
  assertEqual(feb.expensesNet, 8990, 'só as despesas de 20/02 e 25/02:');
  assertEqual(mar.partial, true);
  assertEqual(mar.income, 450000);
  const total = series.reduce((s, r) => s + r.balance, 0);
  assertEqual(total, summarize(inPeriod(txs, p)).balance, 'a soma das barras = o total do período:');
});

test('evolução do saldo: acumulado do período termina no saldo do período', () => {
  const txs = dataset();
  const p = period('mes_atual');
  const b = balanceSeries(txs, p);
  assertEqual(b.granularity, 'dia');
  const dates = new Set(inPeriod(txs, p).map((t) => t.date));
  assertEqual(b.points.length, dates.size);
  assertEqual(b.points[0].balance, 450000, 'começa do zero:');
  assertEqual(b.points[b.points.length - 1].balance, summarize(inPeriod(txs, p)).balance);
  const long = balanceSeries(txs, period('ano_atual'));
  assertEqual(long.granularity, 'mes', 'período longo agrupa por mês:');
  assertEqual(long.points[long.points.length - 1].balance, summarize(inPeriod(txs, period('ano_atual'))).balance);
  assertEqual(balanceSeries([], p).points.length, 0);
});

// ------------------------------------------------------------ insights
function insightsFor(txs, budgets = [], preset = 'mes_atual') {
  const p = period(preset, {}, txs);
  return buildInsights({ transactions: txs, period: p, today: TODAY, refMonth: referenceMonth(p, TODAY), budgets, categoriesById: catMap() });
}

test('insights com dados reais: maior gasto, maior aumento, renda comprometida, orçamento, recorrência', () => {
  const { items, unavailable } = insightsFor(dataset(), [{ id: 1, categoryId: 'alimentacao', limit: 25000 }]);
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  assert(/Alimentação.*R\$ 240,00/.test(by['maior-categoria'].text), by['maior-categoria']?.text);
  assert(/Alimentação subiu R\$ 40,00 \(20,0%\)/.test(by['maior-aumento'].text), by['maior-aumento']?.text);
  assert(/ainda não terminou/.test(by['maior-aumento'].text), 'avisa que o mês atual está em andamento');
  assert(/11,3%/.test(by['renda-comprometida'].text), by['renda-comprometida']?.text);
  assert(/Alimentação: 96,0%/.test(by.orcamentos.text), by.orcamentos?.text);
  assert(/netflix/.test(by.recorrentes.text), 'recorrência detectada');
  assert(/sobraram R\$ 3\.990,10/.test(by.resultado.text), by.resultado?.text);
  assertEqual(unavailable.length, 0);
});

test('insights: sem dados suficientes não inventa conclusões', () => {
  const onlyMarch = dataset().filter((t) => t.date >= '2026-03-01');
  const { items, unavailable } = insightsFor(onlyMarch, []);
  const ids = items.map((i) => i.id);
  assert(!ids.includes('maior-aumento'), 'sem mês anterior não compara');
  assert(!ids.includes('recorrentes'), 'um mês só não prova recorrência');
  assert(!ids.includes('orcamentos'), 'sem orçamentos');
  assert(unavailable.some((u) => u.id === 'maior-aumento' && /fevereiro/.test(u.reason)), 'explica o que falta');
  assert(unavailable.some((u) => u.id === 'orcamentos' && /cadastrou/.test(u.reason)));
  const sem = insightsFor([T('2026-03-02', -5000, 'compras')], []);
  assert(sem.unavailable.some((u) => u.id === 'renda-comprometida'), 'sem receitas não calcula percentual');
});

test('insights: nenhuma categoria aumentou também é uma conclusão válida', () => {
  const txs = [T('2026-02-10', -20000, 'alimentacao'), T('2026-03-10', -10000, 'alimentacao')];
  const { items } = insightsFor(txs);
  assert(/Nenhuma categoria gastou mais/.test(items.find((i) => i.id === 'maior-aumento').text));
});

test('despesas recorrentes: mesmo estabelecimento em 2+ meses e valores parecidos', () => {
  const mk = (date, amount, merchant) => T(date, amount, 'assinaturas', { merchantName: merchant });
  assertEqual(findRecurring([mk('2026-01-05', -3990, 'netflix'), mk('2026-02-05', -3990, 'netflix'), mk('2026-03-05', -4100, 'netflix')]).length, 1);
  assertEqual(findRecurring([mk('2026-01-05', -3990, 'x'), mk('2026-02-05', -9990, 'x')]).length, 0, 'valores muito diferentes:');
  assertEqual(findRecurring([mk('2026-03-05', -3990, 'y'), mk('2026-03-20', -3990, 'y')]).length, 0, 'mesmo mês não conta:');
  assertEqual(findRecurring([T('2026-01-05', 5000, null), T('2026-02-05', 5000, null)]).length, 0, 'entradas não são despesas:');
});

// ------------------------------------------------------------ ciclos
const CYCLE_SOURCES = [
  { id: 1, name: 'Adiantamento', frequency: 'mensal', day: 15, amount: 150000, startDate: '2026-03-01' },
  { id: 2, name: 'Extra', frequency: 'mensal', day: 20, amount: 100000, startDate: '2026-03-01' },
];

function cycleTxs() {
  nextId = 1;
  return [
    T('2026-03-10', -5000, 'compras', { desc: 'ANTES DOS CICLOS' }),   // sem ciclo anterior: não alocada
    T('2026-03-16', 150000, null, { desc: 'ADIANTAMENTO' }),
    T('2026-03-16', -10000, 'alimentacao'),
    T('2026-03-21', -20000, 'transporte'),
  ];
}

test('análise de ciclos: previsto, recebido, comprometido, gasto, disponível e não alocadas', () => {
  const txs = cycleTxs();
  const model = buildModel({ transactions: txs, sources: CYCLE_SOURCES, today: '2026-03-31', focusMonth: '2026-03' });
  const a = analyzeCycles(model, period('mes_atual'));
  assertEqual(a.cycles.length, 2);
  assertEqual(a.totals.expected, 250000);
  assertEqual(Math.round(a.cycles[0].share), 60);
  assertEqual(Math.round(a.cycles[0].share + a.cycles[1].share), 100);
  const [c1, c2] = a.cycles;
  assertEqual(c1.status, 'recebido');
  assertEqual(c1.received, 150000);
  assertEqual(c1.realized, 10000);
  assertEqual(c1.availablePlanned, 140000);
  assertEqual(c1.availableReal, 140000);
  assertEqual(c2.status, 'sem_recebimento');
  assertEqual(c2.availablePlanned, 80000, 'planejado: previsto − despesas:');
  assertEqual(c2.availableReal, -20000, 'real: recebido (0) − despesas — diferente do planejado:');
  assertEqual(a.unallocated.count, 1);
  assertEqual(a.unallocated.amount, 5000);
  assertEqual(a.counts.recebido, 1);
  assertEqual(a.counts.sem_recebimento, 1);
  assertEqual(a.totals.allocated, 30000, 'a despesa sem ciclo não entra no total alocado:');
});

test('análise de ciclos: despesa acima do previsto e barras', () => {
  const txs = [...cycleTxs(), T('2026-03-17', -200000, 'moradia')];
  const model = buildModel({ transactions: txs, sources: CYCLE_SOURCES, today: '2026-03-31', focusMonth: '2026-03' });
  const c1 = analyzeCycles(model, period('mes_atual')).cycles[0];
  assertEqual(c1.overAllocated, true);
  assertEqual(c1.availablePlanned, 150000 - 210000);
  const seg = barSegments(c1);
  assertEqual(Math.round(seg.committed + seg.realized), 100, 'barra cheia:');
  assertEqual(seg.available, 0);
  assert(seg.over > 0);
  const ok = barSegments({ expected: 100, allocated: 40, committed: 0, realized: 40 });
  assertEqual(Math.round(ok.realized + ok.available), 100);
});

test('próximos recebimentos: a partir de hoje, com dia 30 em fevereiro', () => {
  const sources = [{ id: 1, name: 'Salário', frequency: 'mensal', day: 30, amount: 200000 }];
  const next = nextReceipts(sources, '2026-01-31');
  assertEqual(next.map((n) => n.date).slice(0, 3).join(), '2026-02-28,2026-03-30,2026-04-30');
  assertEqual(next[0].daysUntil, 28);
  assertEqual(nextReceipts([], '2026-01-31').length, 0);
});

// ------------------------------------------------------------ painel completo
test('painel: período vazio, período inválido e dados originais intactos', () => {
  const txs = deepFreeze(dataset());
  const model = deepFreeze(buildModel({ transactions: txs, sources: CYCLE_SOURCES, today: TODAY }));
  const build = (preset, custom = {}) => buildDashboard({ model, categories: CATS, budgets: [], preset, custom, today: TODAY });
  const ok = build('mes_atual');
  assertEqual(ok.valid, true);
  assertEqual(ok.summary.income, 450000);
  assertEqual(ok.isEmptyPeriod, false);
  assertEqual(build('personalizado', { start: '2025-01-01', end: '2025-01-31' }).isEmptyPeriod, true);
  const bad = build('personalizado', { start: '2026-03-10', end: '2026-03-01' });
  assertEqual(bad.valid, false);
  assertEqual(bad.hasTransactions, true);
});

// ------------------------------------------------------------ configuração dos gráficos
test('gráficos: valores em reais = centavos / 100, rótulos e alternativas de texto', () => {
  const txs = dataset();
  const p = period('mes_atual');
  const series = monthlySeries(txs, chartMonths(p, txs), p);

  const a = incomeVsExpenses(series, COLORS);
  assertEqual(a.config.type, 'bar');
  assertEqual(a.config.data.labels.join(), 'fev/26,mar/26');
  assertEqual(a.config.data.datasets[0].data.join(), '5000,4500', 'receitas em reais:');
  assertEqual(a.config.data.datasets[1].data.join(), '389.9,509.9', 'despesas em reais:');
  assert(/R\$ 5\.000,00/.test(a.summary) && a.summary.length > 40, 'texto alternativo com valores');
  assertEqual(a.table.rows.length, 2);

  const list = expensesByCategory(inPeriod(txs, p), catMap());
  const d = categoryDoughnut(list, COLORS);
  assertEqual(d.config.type, 'doughnut');
  assertEqual(d.config.data.datasets[0].data.join(), '240,150,80,39.9');
  assertEqual(d.config.data.datasets[0].backgroundColor[0], '#f59e0b', 'cor da categoria:');
  assert(/Alimentação: R\$ 240,00 \(47,1%\)/.test(d.summary), d.summary);
  assertEqual(d.table.rows[0].join(' | '), 'Alimentação | R$ 240,00 | 47,1%');

  const line = balanceLine(balanceSeries(txs, p), COLORS);
  assertEqual(line.config.type, 'line');
  assertEqual(line.config.data.datasets[0].data.at(-1), 3990.1);
  assert(/Não é o saldo bancário/.test(line.summary));

  const bars = spendingBars(spendingTrend(series), COLORS);
  assertEqual(bars.config.data.datasets[0].backgroundColor.join(), `${COLORS.primary},${COLORS.negative}`, 'aumento em vermelho:');
  assert(/aumento de R\$ 120,00/.test(bars.summary), bars.summary);
  const down = spendingBars(spendingTrend([{ month: '2026-01', expensesNet: 10000 }, { month: '2026-02', expensesNet: 4000 }]), COLORS);
  assertEqual(down.config.data.datasets[0].backgroundColor[1], COLORS.positive, 'redução em verde:');
});

test('gráfico de orçamento: abaixo, próximo e acima do limite', () => {
  const budgets = [
    { id: 1, categoryId: 'alimentacao', limit: 100000 },  // 24000 -> 24% ok
    { id: 2, categoryId: 'transporte', limit: 9000 },     // 8000 -> 88,9% atenção
    { id: 3, categoryId: 'compras', limit: 10000 },       // 15000 -> 150% excedido
  ];
  const report = monthlyBudgetReport({ budgets, transactions: dataset(), month: '2026-03' });
  const b = budgetBars(report.rows, catMap(), COLORS);
  const names = b.config.data.labels;
  const at = (n) => names.indexOf(n);
  const [within, excess, rest] = b.config.data.datasets;
  assertEqual(b.config.options.indexAxis, 'y');
  // cores fixas por série: a parte "dentro do limite" nunca é vermelha, nem parecida com o excedente
  assertEqual(within.backgroundColor, COLORS.primary, 'dentro do limite = cor principal:');
  assertEqual(excess.backgroundColor, COLORS.negative, 'excedente = vermelho:');
  assert(within.backgroundColor !== excess.backgroundColor && within.backgroundColor !== rest.backgroundColor, 'três cores distintas');
  assertEqual(excess.data[at('Compras')], 50, 'excedente de R$ 50,00:');
  assertEqual(excess.data[at('Alimentação')], 0);
  assertEqual(rest.data[at('Alimentação')], 760);
  assertEqual(rest.data[at('Compras')], 0);
  assert(b.table.rows.some((r) => r[0] === 'Compras' && /excedido em R\$ 50,00/.test(r[3]) && /ultrapassado/.test(r[5])));
  assert(/Compras: gasto R\$ 150,00 de R\$ 100,00/.test(b.summary), b.summary);
  assertEqual(budgetBars([], catMap(), COLORS).summary, 'Sem orçamentos cadastrados.');
});

test('Chart.js carrega localmente e desenha as configurações', async () => {
  const Chart = await loadChart();
  assert(typeof Chart === 'function' && /^4\./.test(Chart.version), `versão ${Chart.version}`);
  const colors = themeColors();
  for (const k of ['text', 'muted', 'grid', 'surface', 'primary', 'positive', 'negative', 'warning']) assert(typeof colors[k] === 'string' && colors[k].length > 0, k);

  const txs = dataset();
  const p = period('mes_atual');
  const series = monthlySeries(txs, chartMonths(p, txs), p);
  const canvas = document.createElement('canvas');
  const holder = document.createElement('div');
  holder.style.cssText = 'position:absolute;left:-9999px;width:400px;height:300px';
  holder.appendChild(canvas);
  document.body.appendChild(holder);
  try {
    const chart = await drawChart(canvas, incomeVsExpenses(series, colors).config);
    assertEqual(chart.data.datasets.length, 2);
    assertEqual(chart.data.datasets[0].data[1], 4500);
    const again = await drawChart(canvas, categoryDoughnut(expensesByCategory(inPeriod(txs, p), catMap()), colors).config);
    assertEqual(again.config.type, 'doughnut', 'redesenhar substitui o gráfico anterior:');
    again.destroy();
  } finally { holder.remove(); }
});

// ------------------------------------------------------------ banco: importar e editar
async function loadSample(name) {
  const blob = await (await fetch(`../samples/${name}`)).blob();
  return new File([blob], name, { type: 'application/pdf' });
}
const dash = (db, preset = 'ultimo_com_dados') => loadDashboard(db, { preset, custom: {}, today: '2026-11-26' });

test('painel atualiza após importar e após editar categorias (dados reais do IndexedDB)', async () => {
  const db = await freshDb();
  const empty = await dash(db);
  assertEqual(empty.hasTransactions, false, 'banco vazio:');

  const analysis = await analyzePdf(await loadSample('extrato-exemplo-modelo-a.pdf'), db);
  await saveReviewed(db, analysis);
  const before = await dash(db);
  const all = await db.getAll('transactions');
  assertEqual(before.hasTransactions, true);
  assertEqual(before.period.label, 'março de 2026', 'sem dados em novembro: usa o mês mais recente:');
  assertEqual(before.summary.balance, all.reduce((s, t) => s + t.amount, 0), 'saldo = soma das movimentações:');
  assertEqual(before.summary.income, 320000 + 25000 + 10000, 'salário + pix + depósito:');
  assertEqual(before.summary.refunds, 4590, 'estorno do iFood:');
  assertEqual(before.byCategory.reduce((s, c) => s + c.value, 0), before.summary.expensesNet, 'fatias = despesas:');
  assertEqual(before.byCategory.find((c) => c.categoryId === 'alimentacao').value, 3210, 'keeta 32,10 (iFood 45,90 − estorno 45,90):');
  const pendBefore = before.summary.pending.count;
  assert(pendBefore > 0, 'há despesas pendentes de revisão');

  // edição: corrigir a categoria de uma despesa pendente move o valor entre categorias
  const livraria = all.find((t) => t.originalDescription.includes('LIVRARIA'));
  await setCategory(db, [livraria.id], 'educacao');
  const after = await dash(db);
  assertEqual(after.byCategory.find((c) => c.categoryId === 'educacao').value, 8990, 'entrou em Educação:');
  assertEqual(after.summary.expensesNet, before.summary.expensesNet, 'o total não muda ao recategorizar:');
  assertEqual(after.summary.pending.count, pendBefore - 1, 'saiu das pendências:');

  // nova importação (outro extrato) muda os totais
  const b = await analyzePdf(await loadSample('extrato-exemplo-modelo-b-sem-ano.pdf'), db);
  for (const r of b.rows) { r.date = r.date || `2026-${String(r.month).padStart(2, '0')}-${String(r.day).padStart(2, '0')}`; r.selected = true; }
  await saveReviewed(db, b);
  const april = await dash(db);
  assertEqual(april.period.label, 'abril de 2026', 'mês mais recente passou a ser abril:');
  assertEqual(april.summary.income, 30000);
  assertEqual(april.series.length, 2, 'abril + março (mês anterior, para comparação):');
  await dispose(db);
});

test('painel: orçamento, ciclos e filtros usam os cadastros do usuário', async () => {
  const db = await freshDb();
  await db.add('transactions', { date: '2026-03-16', amount: -10000, type: 'compra', originalDescription: 'IFOOD', normalizedName: 'ifood', categoryId: null, status: 'pendente', fingerprint: 'd1', importId: 't' });
  await db.add('transactions', { date: '2026-03-16', amount: 150000, type: 'pix_recebido', originalDescription: 'ADIANTAMENTO', normalizedName: 'adiantamento', categoryId: null, status: 'pendente', fingerprint: 'd2', importId: 't' });
  await recategorize(db);
  await createBudget(db, { categoryId: 'alimentacao', limit: 12500 });
  await createSource(db, { name: 'Adiantamento', frequency: 'mensal', day: 15, amount: 150000 });
  const d = await loadDashboard(db, { preset: 'ano_atual', custom: {}, today: '2026-03-20' });
  assert(Math.abs(d.budgetUsage - 80) < 1e-9, `orçamento utilizado: R$ 100 de R$ 125 = 80%, veio ${d.budgetUsage}`);
  assertEqual(d.budgetReport.rows[0].level, 'atencao');
  assertEqual(d.cycles.cycles.length, 12, 'ano atual inclui os ciclos futuros:');
  const marco = d.cycles.cycles.find((c) => c.date === '2026-03-15');
  assertEqual(marco.status, 'recebido');
  assertEqual(marco.realized, 10000);
  assertEqual(d.nextReceipts[0].date, '2026-04-15');
  const mesAnterior = await loadDashboard(db, { preset: 'mes_anterior', custom: {}, today: '2026-03-20' });
  assertEqual(mesAnterior.isEmptyPeriod, true, 'fevereiro não tem movimentações:');
  await dispose(db);
});

// ------------------------------------------------------------ período automático do extrato
test('período do extrato: usa o cabeçalho, senão as datas das transações; o mais recente vence', () => {
  const imports = [
    { id: 'a', importedAt: '2026-01-10T10:00:00Z', periodStart: '2026-01-01', periodEnd: '2026-01-31' },
    { id: 'b', importedAt: '2026-02-10T10:00:00Z' }, // sem período do cabeçalho
  ];
  const txs = [{ id: 1, importId: 'b', date: '2026-02-03' }, { id: 2, importId: 'b', date: '2026-02-27' }, { id: 3, importId: 'a', date: '2026-01-15' }];
  assertEqual(JSON.stringify(statementPeriod(imports, txs)), JSON.stringify({ start: '2026-02-03', end: '2026-02-27', source: 'transacoes' }));
  assertEqual(JSON.stringify(statementPeriod([imports[0]], txs)), JSON.stringify({ start: '2026-01-01', end: '2026-01-31', source: 'cabecalho' }));
  assertEqual(statementPeriod([], txs), null, 'sem importação:');
  const p = resolvePeriod('ultimo_extrato', { today: '2026-11-26', transactions: txs, imports: [imports[0]] });
  assertEqual(`${p.start}..${p.end}`, '2026-01-01..2026-01-31');
  assertEqual(p.label, '01/01/2026 a 31/01/2026');
  const fallback = resolvePeriod('ultimo_extrato', { today: TODAY, transactions: dataset(), imports: [] });
  assertEqual(fallback.valid, true, 'sem importações cai no mês mais recente com dados:');
  assertEqual(defaultPreset(txs, '2026-11-26', imports), 'ultimo_extrato');
  assertEqual(defaultPreset(dataset(), TODAY, []), 'mes_atual', 'sem importações o comportamento antigo continua:');
});

test('importar guarda o período do extrato e o painel abre nele (mesmo meses depois)', async () => {
  const db = await freshDb();
  const analysis = await analyzePdf(await loadSample('extrato-exemplo-modelo-a.pdf'), db);
  const result = await saveReviewed(db, analysis);
  const [imp] = await db.getAll('imports');
  const dates = (await db.getAll('transactions')).map((t) => t.date).sort();
  assert(imp.periodStart && imp.periodEnd, 'período salvo na importação');
  assertEqual(result.period.start, imp.periodStart);
  assert(imp.periodStart <= dates[0] && imp.periodEnd >= dates[dates.length - 1], 'cobre todas as transações salvas');
  const d = await dash(db, 'ultimo_extrato');
  assertEqual(d.valid, true);
  assertEqual(d.isEmptyPeriod, false, 'o painel não abre vazio, mesmo hoje sendo novembro:');
  assertEqual(d.period.start, imp.periodStart);
  assertEqual(d.summary.income, 320000 + 25000 + 10000);
  await dispose(db);
});

test('período do extrato: sem cabeçalho usa primeira e última data; cabeçalho é ampliado se faltar cobertura', async () => {
  const db = await freshDb();
  const analysis = await analyzePdf(await loadSample('extrato-exemplo-modelo-b-sem-ano.pdf'), db);
  analysis.period = null;
  for (const r of analysis.rows) { r.date = r.date || `2026-${String(r.month).padStart(2, '0')}-${String(r.day).padStart(2, '0')}`; r.selected = true; }
  const r1 = await saveReviewed(db, analysis);
  const dates = analysis.rows.filter((r) => r.selected).map((r) => r.date).sort();
  assertEqual(`${r1.period.start}..${r1.period.end}`, `${dates[0]}..${dates[dates.length - 1]}`);
  assertEqual(r1.period.source, 'transacoes');

  const db2 = await freshDb();
  const a2 = await analyzePdf(await loadSample('extrato-exemplo-modelo-b-sem-ano.pdf'), db2);
  for (const r of a2.rows) { r.date = r.date || `2026-${String(r.month).padStart(2, '0')}-${String(r.day).padStart(2, '0')}`; r.selected = true; }
  a2.period = { start: '2026-04-10', end: '2026-04-11' }; // cabeçalho curto demais
  const r2 = await saveReviewed(db2, a2);
  const d2 = a2.rows.filter((r) => r.selected).map((r) => r.date).sort();
  assert(r2.period.start <= d2[0] && r2.period.end >= d2[d2.length - 1], 'período ampliado para cobrir as transações');
  await dispose(db); await dispose(db2);
});

test('painel não altera os dados originais das transações', async () => {
  const db = await freshDb();
  const analysis = await analyzePdf(await loadSample('extrato-exemplo-modelo-a.pdf'), db);
  await saveReviewed(db, analysis);
  const before = JSON.stringify(await db.getAll('transactions'));
  await dash(db);
  await dash(db, 'ano_atual');
  assertEqual(JSON.stringify(await db.getAll('transactions')), before);
  await dispose(db);
});
