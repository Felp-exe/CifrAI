import { test, assert, assertEqual } from './runner.js';
import { Database, deleteDatabase } from '../js/db.js';
import { seedDefaults } from '../js/seed.js';
import { normalizeText } from '../js/utils/format.js';
import { parseAmountInput } from '../js/utils/money.js';
import { spentByCategory, budgetStatus, monthlyBudgetReport, uncategorizedExpenses } from '../js/budget/budgetEngine.js';
import { createBudget, updateBudget, deleteBudget, listBudgets } from '../js/budget/budgetService.js';
import { createCategory, deleteCategory, categoryUsage } from '../js/categorization/categoryService.js';
import { recategorize, setCategory } from '../js/categorization/transactionService.js';

let counter = 0;
async function freshDb() {
  const name = `mfa-test-bud-${Date.now()}-${counter++}`;
  const db = await new Database(name).open();
  await seedDefaults(db, '../data/');
  db._testName = name;
  return db;
}
async function dispose(db) { db.close(); await deleteDatabase(db._testName); }

async function addTx(db, description, amount, date = '2026-03-05') {
  return db.add('transactions', {
    date, amount, type: amount > 0 ? 'entrada' : 'compra', originalDescription: description,
    normalizedName: normalizeText(description), categoryId: null, status: 'pendente',
    fingerprint: `b${counter++}`, importId: 'teste',
  });
}
const T = (id, date, amount, categoryId, extra = {}) => ({ id, date, amount, categoryId, status: 'classificada', type: amount > 0 ? 'entrada' : 'compra', ...extra });

// ------------------------------------------------------------ valores digitados
test('valor digitado: aceita 600, 600,5, 1.234,56 e R$ 600; recusa ambíguos', () => {
  assertEqual(parseAmountInput('600'), 60000);
  assertEqual(parseAmountInput('600,5'), 60050);
  assertEqual(parseAmountInput('1.234,56'), 123456);
  assertEqual(parseAmountInput('R$ 600'), 60000);
  assertEqual(parseAmountInput('12.50'), null);
  assertEqual(parseAmountInput('0'), null);
  assertEqual(parseAmountInput('-5'), null);
  assertEqual(parseAmountInput('abc'), null);
  assertEqual(parseAmountInput(''), null);
});

// ------------------------------------------------------------ níveis de alerta
test('orçamento: abaixo, próximo, no limite e acima', () => {
  const limit = 60000; // R$ 600
  const abaixo = budgetStatus(limit, 30000);
  assertEqual(abaixo.level, 'ok');
  assertEqual(abaixo.percent, 50);
  assertEqual(abaixo.remaining, 30000);

  assertEqual(budgetStatus(limit, 47999).level, 'ok', '79,99%:');
  assertEqual(budgetStatus(limit, 48000).level, 'atencao', '80% exato:');
  assertEqual(budgetStatus(limit, 57000).level, 'atencao', '95%:');

  const noLimite = budgetStatus(limit, 60000);
  assertEqual(noLimite.level, 'atencao', 'exatamente 100% ainda não estourou:');
  assertEqual(noLimite.remaining, 0);

  const acima = budgetStatus(limit, 66000);
  assertEqual(acima.level, 'excedido');
  assertEqual(acima.remaining, -6000, 'restante negativo = excedido em R$ 60:');
  assertEqual(Math.round(acima.percent), 110);
});

// ------------------------------------------------------------ o que conta como gasto
test('gasto: só saídas categorizadas do mês; entradas, outros meses e sem categoria ficam de fora', () => {
  const txs = [
    T(1, '2026-03-02', -10000, 'alimentacao'),
    T(2, '2026-03-20', -5000, 'alimentacao'),
    T(3, '2026-03-10', 25000, 'alimentacao'),          // entrada: não é despesa
    T(4, '2026-02-28', -9999, 'alimentacao'),          // outro mês
    T(5, '2026-03-11', -7000, null),                   // sem categoria
    T(6, '2026-03-12', -3000, 'transporte'),
    T(7, '2026-04-01', -1000, 'alimentacao'),          // outro mês
  ];
  const spent = spentByCategory(txs, '2026-03');
  assertEqual(spent.get('alimentacao').net, 15000);
  assertEqual(spent.get('alimentacao').count, 2);
  assertEqual(spent.get('transporte').net, 3000);
  assertEqual(spent.has('moradia'), false);
  const sem = uncategorizedExpenses(txs, '2026-03');
  assertEqual(sem.count, 1);
  assertEqual(sem.total, 7000);
});

test('gasto: estorno da mesma categoria abate; nunca fica negativo', () => {
  const txs = [
    T(1, '2026-03-02', -10000, 'alimentacao'),
    T(2, '2026-03-03', 4000, 'alimentacao', { type: 'estorno' }),
    T(3, '2026-03-04', -2000, 'compras'),
    T(4, '2026-03-05', 5000, 'compras', { type: 'estorno' }),
  ];
  const spent = spentByCategory(txs, '2026-03');
  assertEqual(spent.get('alimentacao').net, 6000);
  assertEqual(spent.get('alimentacao').refunds, 4000);
  assertEqual(spent.get('compras').net, 0, 'estorno maior que o gasto:');
});

test('gasto: despesas pendentes de revisão são contadas à parte (aviso)', () => {
  const txs = [T(1, '2026-03-02', -10000, 'outros', { status: 'pendente' }), T(2, '2026-03-03', -2000, 'outros')];
  const o = spentByCategory(txs, '2026-03').get('outros');
  assertEqual(o.net, 12000);
  assertEqual(o.pendingCount, 1);
  assertEqual(o.pendingAmount, 10000);
});

test('relatório: totais, alertas e categorias sem orçamento', () => {
  const budgets = [
    { id: 1, categoryId: 'alimentacao', limit: 60000 },
    { id: 2, categoryId: 'transporte', limit: 25000 },
    { id: 3, categoryId: 'compras', limit: 30000 },
  ];
  const txs = [
    T(1, '2026-03-02', -50000, 'alimentacao'),  // 83% -> atenção
    T(2, '2026-03-03', -30000, 'transporte'),   // 120% -> excedido
    T(3, '2026-03-04', -1000, 'compras'),       // ok
    T(4, '2026-03-05', -8000, 'saude'),         // sem orçamento
    T(5, '2026-03-06', -4000, null),
  ];
  const r = monthlyBudgetReport({ budgets, transactions: txs, month: '2026-03' });
  const by = Object.fromEntries(r.rows.map((x) => [x.categoryId, x]));
  assertEqual(by.alimentacao.level, 'atencao');
  assertEqual(by.transporte.level, 'excedido');
  assertEqual(by.compras.level, 'ok');
  assertEqual(r.totals.limit, 115000);
  assertEqual(r.totals.spent, 81000);
  assertEqual(r.totals.alerts, 2);
  assertEqual(r.withoutBudget.length, 1);
  assertEqual(r.withoutBudget[0].categoryId, 'saude');
  assertEqual(r.uncategorized.count, 1);
});

// ------------------------------------------------------------ banco
test('orçamento: criar, editar, excluir e validar', async () => {
  const db = await freshDb();
  const fails = async (fn) => { try { await fn(); return false; } catch { return true; } };
  assert(await fails(() => createBudget(db, { categoryId: 'alimentacao', limit: 0 })), 'limite zero');
  assert(await fails(() => createBudget(db, { categoryId: 'alimentacao', limit: 12.5 })), 'limite não inteiro');
  assert(await fails(() => createBudget(db, { categoryId: 'nao-existe', limit: 1000 })), 'categoria inexistente');
  const b = await createBudget(db, { categoryId: 'alimentacao', limit: 60000 });
  assert(await fails(() => createBudget(db, { categoryId: 'alimentacao', limit: 1000 })), 'duplicado na mesma categoria');
  await createBudget(db, { categoryId: 'transporte', limit: 25000 });
  assertEqual((await updateBudget(db, b.id, { limit: 70000 })).limit, 70000);
  assert(await fails(() => updateBudget(db, b.id, { limit: -1 })), 'edição inválida');
  await deleteBudget(db, b.id);
  assertEqual((await listBudgets(db)).length, 1);
  await dispose(db);
});

test('orçamento acompanha importações novas e correções de categoria automaticamente', async () => {
  const db = await freshDb();
  await createBudget(db, { categoryId: 'alimentacao', limit: 50000 });
  await createBudget(db, { categoryId: 'compras', limit: 30000 });
  const report = async () => monthlyBudgetReport({ budgets: await listBudgets(db), transactions: await db.getAll('transactions'), month: '2026-03' });
  const status = async (id) => (await report()).rows.find((r) => r.categoryId === id);

  assertEqual((await status('alimentacao')).spent, 0, 'sem transações:');

  const a = await addTx(db, 'COMPRA IFOOD *PIZZA', -20000);
  await recategorize(db);
  assertEqual((await status('alimentacao')).spent, 20000, 'primeira importação:');
  assertEqual((await status('alimentacao')).level, 'ok');

  await addTx(db, 'COMPRA KEETA', -22000, '2026-03-09'); // "nova importação"
  await recategorize(db);
  assertEqual((await status('alimentacao')).spent, 42000);
  assertEqual((await status('alimentacao')).level, 'atencao', '84%:');

  await setCategory(db, [a], 'compras'); // correção manual move o gasto
  assertEqual((await status('alimentacao')).spent, 22000, 'saiu de Alimentação:');
  assertEqual((await status('compras')).spent, 20000, 'entrou em Compras:');
  await dispose(db);
});

test('orçamento persiste após fechar e reabrir o banco (atualizar a página)', async () => {
  const db = await freshDb();
  await createBudget(db, { categoryId: 'entretenimento', limit: 20000 });
  const name = db._testName;
  db.close();
  const reopened = await new Database(name).open();
  reopened._testName = name;
  const list = await listBudgets(reopened);
  assertEqual(list.length, 1);
  assertEqual(list[0].categoryId, 'entretenimento');
  assertEqual(list[0].limit, 20000);
  await dispose(reopened);
});

test('excluir categoria remove o orçamento dela e preserva transações', async () => {
  const db = await freshDb();
  await createCategory(db, { nome: 'Hobbies', cor: '#ff8800' });
  await createBudget(db, { categoryId: 'hobbies', limit: 10000 });
  const id = await addTx(db, 'PETSHOP', -3000);
  await setCategory(db, [id], 'hobbies');
  assertEqual((await categoryUsage(db, 'hobbies')).budgets, 1);
  const result = await deleteCategory(db, 'hobbies', 'outros');
  assertEqual(result.deletedBudgets, 1);
  assertEqual((await listBudgets(db)).length, 0);
  assertEqual((await db.get('transactions', id)).amount, -3000, 'valor intacto:');
  await dispose(db);
});
