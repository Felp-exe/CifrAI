import { test, assert, assertEqual } from './runner.js';
import { Database, deleteDatabase, STORE_NAMES } from '../js/db.js';
import { seedDefaults } from '../js/seed.js';
import { getSetting, setSetting } from '../js/storage.js';

// Cada execução usa um banco de teste próprio, para nunca mexer nos seus dados reais.
const TEST_DB = 'mfa-test-' + Date.now();

async function freshDb() {
  const db = new Database(TEST_DB);
  await db.open();
  return db;
}

test('http: os testes rodam por servidor HTTP (não por file://)', () => {
  assert(location.protocol.startsWith('http'), `protocolo atual: ${location.protocol}`);
});

test('http: arquivos do app são servidos corretamente', async () => {
  for (const path of ['../index.html', '../css/styles.css', '../js/app.js', '../data/categories.json']) {
    const response = await fetch(path);
    assert(response.ok, `${path} respondeu ${response.status}`);
  }
});

test('banco: cria todas as tabelas previstas', async () => {
  const db = await freshDb();
  for (const name of STORE_NAMES) {
    assert(db.db.objectStoreNames.contains(name), `faltou a tabela ${name}`);
  }
  assertEqual(STORE_NAMES.length, 9);
  db.close();
});

test('banco: grava, lê, atualiza e apaga uma transação', async () => {
  const db = await freshDb();
  const id = await db.add('transactions', {
    date: '2026-03-05', amount: -4590, type: 'compra_debito',
    originalDescription: 'IFD*IFOOD SAO PAULO', normalizedName: 'ifood',
    categoryId: 'alimentacao', status: 'classificada', fingerprint: 'abc',
  });
  assert(id > 0, 'id não foi gerado');
  let item = await db.get('transactions', id);
  assertEqual(item.originalDescription, 'IFD*IFOOD SAO PAULO', 'descrição original:');
  assertEqual(item.normalizedName, 'ifood', 'nome normalizado:');
  await db.put('transactions', { ...item, categoryId: 'outros' });
  item = await db.get('transactions', id);
  assertEqual(item.categoryId, 'outros');
  await db.delete('transactions', id);
  assertEqual(await db.count('transactions'), 0);
  db.close();
});

test('banco: busca por índice (pendentes)', async () => {
  const db = await freshDb();
  await db.bulkPut('transactions', [
    { date: '2026-03-01', amount: -100, status: 'pendente', fingerprint: 'a' },
    { date: '2026-03-02', amount: -200, status: 'classificada', fingerprint: 'b' },
    { date: '2026-03-03', amount: -300, status: 'pendente', fingerprint: 'c' },
  ]);
  const pendentes = await db.getAllByIndex('transactions', 'status', 'pendente');
  assertEqual(pendentes.length, 2);
  await db.clear('transactions');
  db.close();
});

test('banco: dados persistem ao fechar e reabrir', async () => {
  let db = await freshDb();
  await db.setMeta('teste', 'valor');
  db.close();
  db = await freshDb();
  assertEqual(await db.getMeta('teste'), 'valor');
  db.close();
});

test('dados iniciais: 18 categorias (9 originais + Família, Esporte, Dízimo + 6 novas) e regras Keeta, iFood, Uber e 99', async () => {
  const db = await freshDb();
  const loaded = await seedDefaults(db, '../data/');
  assert(loaded, 'deveria carregar na primeira vez');
  const categories = await db.getAll('categories');
  assertEqual(categories.length, 18);
  const nomes = categories.map((c) => c.nome);
  for (const esperado of ['Alimentação', 'Transporte', 'Moradia', 'Compras', 'Entretenimento', 'Saúde', 'Assinaturas', 'Educação', 'Outros', 'Família', 'Esporte', 'Dízimo']) {
    assert(nomes.includes(esperado), `faltou ${esperado}`);
  }
  const rules = await db.getAll('rules');
  const porPadrao = Object.fromEntries(rules.map((r) => [r.pattern, r.categoryId]));
  assertEqual(porPadrao.ifood, 'alimentacao');
  assertEqual(porPadrao.keeta, 'alimentacao');
  assertEqual(porPadrao.uber, 'transporte');
  assertEqual(porPadrao['99'], null, 'regra do 99 deve ficar pendente:');
  db.close();
});

test('dados iniciais: não duplica ao carregar de novo', async () => {
  const db = await freshDb();
  assertEqual(await seedDefaults(db, '../data/'), false);
  const esperadas = (await (await fetch('../data/merchant-rules.json')).json()).length;
  assertEqual((await db.getAll('rules')).length, esperadas, 'sem regras duplicadas:');
  db.close();
});

test('preferências (LocalStorage): valor padrão e gravação', () => {
  assertEqual(getSetting('assistantMode'), 'local');
  setSetting('assistantMode', 'llm');
  assertEqual(getSetting('assistantMode'), 'llm');
  setSetting('assistantMode', 'local');
});

test('limpeza: apaga o banco de teste', async () => {
  await deleteDatabase(TEST_DB);
});
