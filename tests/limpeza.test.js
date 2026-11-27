import { test, assert, assertEqual } from './runner.js';
import { Database, deleteDatabase } from '../js/db.js';
import { seedDefaults } from '../js/seed.js';
import { analyzePdf, saveReviewed, isSavable } from '../js/import/importService.js';
import { listImports, previewDeleteImport, deleteImport, wipeAllData } from '../js/data/dataService.js';
import { createBudget } from '../js/budget/budgetService.js';
import { createSource } from '../js/cycles/incomeService.js';
import { setCategory } from '../js/categorization/transactionService.js';
import { getSetting, setSetting } from '../js/storage.js';
import * as configuracoes from '../js/ui/configuracoes.js';

let counter = 0;
async function freshDb() {
  const name = `mfa-test-limpeza-${Date.now()}-${counter++}`;
  const db = await new Database(name).open();
  await seedDefaults(db, '../data/');
  db._testName = name;
  return db;
}
async function dispose(db) { db.close(); await deleteDatabase(db._testName); }

async function sample(name) {
  const blob = await (await fetch(`../samples/${name}`)).blob();
  return new File([blob], name, { type: 'application/pdf' });
}
/** Importa um extrato de exemplo (completando o ano nas linhas sem ano). */
async function importSample(db, name) {
  const a = await analyzePdf(await sample(name), db);
  for (const r of a.rows) { r.date = r.date || `2026-${String(r.month).padStart(2, '0')}-${String(r.day).padStart(2, '0')}`; r.selected = isSavable(r) && !r.duplicate; }
  return saveReviewed(db, a);
}

test('excluir importação remove só as transações dela, com alocações e vínculos, e mantém o resto', async () => {
  const db = await freshDb();
  const a = await importSample(db, 'extrato-exemplo-modelo-a.pdf');
  const b = await importSample(db, 'extrato-exemplo-modelo-b-sem-ano.pdf');
  const all = await db.getAll('transactions');
  const ofA = all.filter((t) => t.importId === a.importId);
  const ofB = all.filter((t) => t.importId === b.importId);
  assert(ofA.length > 0 && ofB.length > 0, 'duas importações com transações');

  await createBudget(db, { categoryId: 'alimentacao', limit: 50000 });
  await createSource(db, { name: 'Salário', frequency: 'mensal', day: 5, amount: 320000 });
  await setCategory(db, [ofA[0].id], 'educacao'); // correção manual dentro da importação A
  await db.add('allocations', { transactionId: ofA[0].id, cycleId: '1@2026-03-05', amount: 1000, createdAt: 'x' });
  await db.add('allocations', { transactionId: ofB[0].id, cycleId: '1@2026-03-05', amount: 2000, createdAt: 'x' });
  await db.add('receiptLinks', { transactionId: ofA[1].id, cycleId: '1@2026-03-05', createdAt: 'x' });
  const rulesBefore = await db.count('rules');
  const catsBefore = await db.count('categories');

  const preview = await previewDeleteImport(db, a.importId);
  assertEqual(preview.transactions, ofA.length, 'prévia conta as transações:');
  assertEqual(preview.manual, 1);
  assertEqual(preview.allocations, 1);
  assertEqual(preview.receiptLinks, 1);
  assertEqual(await db.count('transactions'), all.length, 'a prévia não apaga nada:');

  const removed = await deleteImport(db, a.importId);
  assertEqual(removed.transactions, ofA.length);
  const left = await db.getAll('transactions');
  assertEqual(left.length, ofB.length, 'sobraram só as da outra importação:');
  assert(left.every((t) => t.importId === b.importId), 'nenhuma transação da importação excluída');
  assertEqual(JSON.stringify(left.map((t) => t.id).sort()), JSON.stringify(ofB.map((t) => t.id).sort()));
  const allocs = await db.getAll('allocations');
  assertEqual(allocs.length, 1, 'alocação da outra importação ficou:');
  assertEqual(allocs[0].transactionId, ofB[0].id);
  assertEqual(await db.count('receiptLinks'), 0);
  assertEqual((await db.getAll('imports')).map((m) => m.id).join(), b.importId, 'registro da importação removido:');
  assertEqual(await db.count('budgets'), 1, 'orçamento mantido:');
  assertEqual(await db.count('incomes'), 1, 'renda mantida:');
  assertEqual(await db.count('categories'), catsBefore);
  assert((await db.count('rules')) >= rulesBefore, 'regras mantidas (inclusive a memorizada):');
  await dispose(db);
});

test('excluir importação: pode importar o mesmo extrato de novo; importação inexistente é recusada', async () => {
  const db = await freshDb();
  const first = await importSample(db, 'extrato-exemplo-modelo-a.pdf');
  const count = await db.count('transactions');
  await deleteImport(db, first.importId);
  assertEqual(await db.count('transactions'), 0);
  const again = await analyzePdf(await sample('extrato-exemplo-modelo-a.pdf'), db);
  assertEqual(again.rows.filter((r) => r.duplicate).length, 0, 'sem duplicadas depois de excluir:');
  await saveReviewed(db, again);
  assertEqual(await db.count('transactions'), count);
  let erro = null;
  try { await deleteImport(db, 'nao-existe'); } catch (e) { erro = e; }
  assert(erro && /não existe/.test(erro.message), 'recusa importação inexistente');
  assertEqual(await db.count('transactions'), count, 'nada mudou:');
  await dispose(db);
});

test('listar importações: mais recente primeiro, com contagem e período', async () => {
  const db = await freshDb();
  const a = await importSample(db, 'extrato-exemplo-modelo-a.pdf');
  await new Promise((r) => setTimeout(r, 5));
  const b = await importSample(db, 'extrato-exemplo-modelo-b-sem-ano.pdf');
  const list = await listImports(db);
  assertEqual(list.length, 2);
  assertEqual(list[0].id, b.importId, 'mais recente primeiro:');
  assertEqual(list[1].transactionCount, (await db.getAllByIndex('transactions', 'importId', a.importId)).length);
  assert(list[1].firstDate && list[1].lastDate, 'tem período');
  await dispose(db);
});

test('apagar tudo: limpa os dados do usuário e volta às categorias e regras iniciais', async () => {
  const db = await freshDb();
  await importSample(db, 'extrato-exemplo-modelo-a.pdf');
  await createBudget(db, { categoryId: 'alimentacao', limit: 50000 });
  await createSource(db, { name: 'Salário', frequency: 'mensal', day: 5, amount: 320000 });
  await db.put('categories', { id: 'minha-categoria', nome: 'Minha categoria', cor: '#123456', padrao: false });
  await db.add('rules', { pattern: 'minha loja', matchType: 'contains', categoryId: 'minha-categoria', origem: 'usuario', ativa: true });
  const initialRules = (await db.getAll('rules')).filter((r) => r.origem === 'inicial').length;
  setSetting('dashboardPeriod', 'ultimo_extrato');

  const removed = await wipeAllData(db, { baseUrl: '../data/' });
  assert(removed.transactions > 0 && removed.imports === 1, 'informa o que foi removido');
  for (const store of ['transactions', 'imports', 'budgets', 'incomes', 'allocations', 'receiptLinks']) {
    assertEqual(await db.count(store), 0, `${store} vazio:`);
  }
  const cats = await db.getAll('categories');
  assert(!cats.some((c) => c.id === 'minha-categoria'), 'categoria criada por você removida');
  assert(cats.some((c) => c.id === 'alimentacao') && cats.some((c) => c.id === 'dizimo'), 'categorias iniciais voltaram');
  const rules = await db.getAll('rules');
  assert(!rules.some((r) => r.pattern === 'minha loja'), 'regra do usuário removida');
  assertEqual(rules.filter((r) => r.origem === 'inicial').length, initialRules, 'regras iniciais recarregadas:');
  assertEqual(await db.getMeta('seeded'), true);
  assertEqual(getSetting('dashboardPeriod'), null, 'filtro do painel redefinido:');
  await dispose(db);
});

test('Ajustes: lista as importações, exige confirmação para apagar tudo e não apaga sem ela', async () => {
  const db = await freshDb();
  await importSample(db, 'extrato-exemplo-modelo-a.pdf');
  const holder = document.createElement('div');
  document.body.appendChild(holder);
  try {
    await configuracoes.render(holder, { db });
    assertEqual(holder.querySelectorAll('[data-act="delete-import"]').length, 1, 'um botão por importação:');
    assert(holder.textContent.includes('extrato-exemplo-modelo-a.pdf'), 'mostra o nome do arquivo');
    const wipe = holder.querySelector('#wipe-btn');
    assertEqual(wipe.disabled, true, 'começa bloqueado:');
    holder.querySelector('#wipe-confirm').click();
    assertEqual(wipe.disabled, true, 'só a caixa marcada não basta:');
    const word = holder.querySelector('#wipe-word');
    word.value = 'apagar';
    word.dispatchEvent(new Event('input', { bubbles: true }));
    assertEqual(wipe.disabled, false, 'caixa marcada + palavra libera:');
    word.value = 'APAGA';
    word.dispatchEvent(new Event('input', { bubbles: true }));
    assertEqual(wipe.disabled, true, 'palavra errada bloqueia de novo:');
    assert((await db.count('transactions')) > 0, 'nada foi apagado');
    // clique sintético (não confiável) nunca apaga
    word.value = 'APAGAR';
    word.dispatchEvent(new Event('input', { bubbles: true }));
    wipe.click();
    await new Promise((r) => setTimeout(r, 50));
    assert((await db.count('transactions')) > 0, 'clique não confiável não apaga:');
  } finally { holder.remove(); }
  await dispose(db);
});
