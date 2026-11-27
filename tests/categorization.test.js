import { test, assert, assertEqual } from './runner.js';
import { Database, deleteDatabase } from '../js/db.js';
import { seedDefaults, syncInitialRules } from '../js/seed.js';
import { normalizeText } from '../js/utils/format.js';
import { extractMerchant } from '../js/categorization/merchant.js';
import { categorize } from '../js/categorization/categorizer.js';
import {
  createRule, updateRule, deleteRule, setRuleActive, listRules, rememberMerchant,
} from '../js/categorization/ruleService.js';
import {
  createCategory, updateCategory, deleteCategory, categoryUsage,
} from '../js/categorization/categoryService.js';
import {
  recategorize, migrateLegacy, setCategory, confirmSuggestions, resetToAutomatic, filterTransactions,
} from '../js/categorization/transactionService.js';

let counter = 0;
async function freshDb() {
  const name = `mfa-test-cat-${Date.now()}-${counter++}`;
  const db = await new Database(name).open();
  await seedDefaults(db, '../data/');
  db._testName = name;
  return db;
}
async function dispose(db) { db.close(); await deleteDatabase(db._testName); }

/** Cria uma transação no formato da Etapa 2 (ainda sem categorização). */
async function addTx(db, description, amount = -1000, date = '2026-03-05') {
  const id = await db.add('transactions', {
    date, amount, type: 'compra_debito', originalDescription: description,
    normalizedName: normalizeText(description), categoryId: null, status: 'pendente',
    fingerprint: `${date}|${amount}|${normalizeText(description)}#${counter++}`, importId: 'teste',
  });
  return id;
}

async function ctxOf(db) {
  const [rules, cats] = await Promise.all([db.getAll('rules'), db.getAll('categories')]);
  return { rules, ids: new Set(cats.map((c) => c.id)) };
}
const tx = (description, amount = -1000) => ({ originalDescription: description, normalizedName: normalizeText(description), amount });

// ------------------------------------------------------------ estabelecimento
test('estabelecimento: remove ruído de tipo de operação e mantém o original intacto', () => {
  assertEqual(extractMerchant('COMPRA DEBITO IFD*IFOOD SAO PAULO BR'), 'ifd ifood sao paulo');
  assertEqual(extractMerchant('PIX ENVIADO MARIA SOUZA'), 'maria souza');
  assertEqual(extractMerchant('PAGAMENTO 99 APP'), '99 app');
  assertEqual(extractMerchant('PIX'), 'pix', 'não deixa o nome vazio:');
});

// ------------------------------------------------------------ regras iniciais
test('regra inicial: iFood e Keeta → Alimentação (confiança alta)', async () => {
  const db = await freshDb();
  const { rules, ids } = await ctxOf(db);
  for (const d of ['COMPRA DEBITO IFD*IFOOD SAO PAULO', 'COMPRA KEETA', 'IFOOD *RESTAURANTE', 'KEETA PEDIDO 123']) {
    const r = categorize(tx(d), rules, ids);
    assertEqual(r.categoryId, 'alimentacao', d + ':');
    assertEqual(r.status, 'classificada');
    assertEqual(r.confidence, 'alta');
    assertEqual(r.categorySource, 'regra_inicial');
  }
  await dispose(db);
});

test('regra inicial: Uber → Transporte, sem confundir com "Uberlândia"', async () => {
  const db = await freshDb();
  const { rules, ids } = await ctxOf(db);
  assertEqual(categorize(tx('UBER *TRIP'), rules, ids).categoryId, 'transporte');
  assertEqual(categorize(tx('UBER* PENDING'), rules, ids).categoryId, 'transporte');
  const outro = categorize(tx('SUPERMERCADO UBERLANDIA'), rules, ids);
  assert(outro.categoryId !== 'transporte', 'Uberlândia não é Uber');
  await dispose(db);
});

test('regra inicial: 99 vai para revisão (sem categoria), mas "1999" não casa', async () => {
  const db = await freshDb();
  const { rules, ids } = await ctxOf(db);
  const r = categorize(tx('PAGAMENTO 99 APP'), rules, ids);
  assertEqual(r.categoryId, null, 'sem categoria:');
  assertEqual(r.status, 'pendente');
  assertEqual(r.suggestedCategoryId, null);
  assert(/99/.test(r.reason), 'motivo cita a regra');
  const nao = categorize(tx('LOJA 1999 LTDA'), rules, ids);
  assert(nao.categorySource !== 'regra_inicial', '1999 não é 99');
  await dispose(db);
});

test('estabelecimento desconhecido → Outros, pendente, confiança baixa', async () => {
  const db = await freshDb();
  const { rules, ids } = await ctxOf(db);
  const r = categorize(tx('BAZAR DO ZE LTDA'), rules, ids);
  assertEqual(r.categoryId, 'outros');
  assertEqual(r.status, 'pendente');
  assertEqual(r.confidence, 'baixa');
  assertEqual(r.categorySource, 'desconhecido');
  await dispose(db);
});

test('entrada desconhecida: fica sem categoria de gasto, sem pendência', async () => {
  const db = await freshDb();
  const { rules, ids } = await ctxOf(db);
  const r = categorize(tx('PIX RECEBIDO JOAO SILVA', 25000), rules, ids);
  assertEqual(r.categoryId, null, 'transação sem categoria:');
  assertEqual(r.status, 'classificada');
  assertEqual(r.categorySource, 'entrada');
  await dispose(db);
});

test('correspondência aproximada: "IFOD" sugere Alimentação com confiança média, pendente', async () => {
  const db = await freshDb();
  const { rules, ids } = await ctxOf(db);
  const r = categorize(tx('COMPRA IFOD CENTRAL'), rules, ids);
  assertEqual(r.categoryId, 'alimentacao');
  assertEqual(r.confidence, 'media');
  assertEqual(r.status, 'pendente');
  await dispose(db);
});

// ------------------------------------------------------------ pendências da Etapa 3
test('aproximada: nomes parecidos e comuns NÃO viram sugestão (sem falsos positivos)', async () => {
  const db = await freshDb();
  const { rules, ids } = await ctxOf(db);
  for (const d of ['FOOD TRUCK DO ZE', 'MEETA GRILL', 'REETA SERVICOS', 'BEETA LTDA', 'FOODIE BAR', 'UBERABA PECAS', 'LOJA 1999']) {
    const r = categorize(tx(d), rules, ids);
    assert(r.categoryId !== 'alimentacao' && r.categoryId !== 'transporte', `${d} foi classificada como ${r.categoryId}`);
    assert(r.categorySource === 'desconhecido', `${d}: esperava desconhecido, veio ${r.categorySource}`);
  }
  await dispose(db);
});

test('aproximada: erros de digitação plausíveis ainda são sugeridos (pendentes)', async () => {
  const db = await freshDb();
  const { rules, ids } = await ctxOf(db);
  for (const d of ['IFOD RESTAURANTE', 'IFOODD PEDIDO', 'KEETTA PEDIDO', 'KETA PIZZARIA']) {
    const r = categorize(tx(d), rules, ids);
    // IFOODD e KEETTA contêm o texto exato; IFOD e KETA são aproximadas
    assertEqual(r.categoryId, 'alimentacao', d + ':');
    if (r.confidence === 'media') assertEqual(r.status, 'pendente', d + ' aproximada fica pendente:');
  }
  await dispose(db);
});

test('Uber Eats é Alimentação (exceção); Uber comum continua Transporte', async () => {
  const db = await freshDb();
  const { rules, ids } = await ctxOf(db);
  assertEqual(categorize(tx('UBER EATS BR'), rules, ids).categoryId, 'alimentacao');
  assertEqual(categorize(tx('UBER *EATS'), rules, ids).categoryId, 'alimentacao');
  assertEqual(categorize(tx('UBER *TRIP'), rules, ids).categoryId, 'transporte');
  await dispose(db);
});

test('regras iniciais novas chegam a bancos antigos sem duplicar nem apagar nada', async () => {
  const db = await freshDb();
  const eats = (await listRules(db)).find((r) => r.pattern === 'uber eats');
  await db.delete('rules', eats.id); // simula banco da versão anterior (4 regras)
  const mine = await createRule(db, { pattern: 'netflix', matchType: 'contains', categoryId: 'assinaturas' });
  assertEqual(await syncInitialRules(db, '../data/'), 1, 'adicionou a que faltava:');
  assertEqual(await syncInitialRules(db, '../data/'), 0, 'segunda vez não duplica:');
  const iniciais = (await (await fetch('../data/merchant-rules.json')).json()).length;
  assertEqual((await listRules(db)).length, iniciais + 1, 'iniciais + 1 sua:');
  assert(await db.get('rules', mine.id), 'regra do usuário preservada');
  await dispose(db);
});

test('correção manual protegida após criar, editar, desativar e excluir regras', async () => {
  const db = await freshDb();
  const id = await addTx(db, 'COMPRA IFOOD *PIZZARIA', -3000);
  await recategorize(db);
  await setCategory(db, [id], 'entretenimento'); // decisão do usuário
  const check = async (etapa) => {
    await recategorize(db);
    const t = await db.get('transactions', id);
    assertEqual(t.categoryId, 'entretenimento', `${etapa}:`);
    assertEqual(t.manual, true, `${etapa} (manual):`);
  };
  const rule = await createRule(db, { pattern: 'ifood', matchType: 'contains', categoryId: 'compras' });
  await check('após criar regra');
  await updateRule(db, rule.id, { pattern: 'pizzaria', matchType: 'contains', categoryId: 'saude' });
  await check('após editar regra');
  await setRuleActive(db, rule.id, false);
  await check('após desativar regra');
  await setRuleActive(db, rule.id, true);
  await check('após reativar regra');
  await deleteRule(db, rule.id);
  await check('após excluir regra');
  // memorizar OUTRA correção do mesmo estabelecimento também não mexe nesta
  const outra = await addTx(db, 'COMPRA IFOOD *PIZZARIA', -2000, '2026-03-09');
  await setCategory(db, [outra], 'alimentacao', { remember: true });
  await check('após memorizar outra correção');
  // e a regra inicial sendo desativada/reativada
  const inicial = (await listRules(db)).find((r) => r.pattern === 'ifood');
  await setRuleActive(db, inicial.id, false);
  await check('após desativar regra inicial');
  await dispose(db);
});

// ------------------------------------------------------------ regras do usuário
test('regra personalizada prevalece sobre a regra inicial', async () => {
  const db = await freshDb();
  await createRule(db, { pattern: 'ifood', matchType: 'contains', categoryId: 'compras' });
  const { rules, ids } = await ctxOf(db);
  const r = categorize(tx('COMPRA IFOOD *MERCADO'), rules, ids);
  assertEqual(r.categoryId, 'compras');
  assertEqual(r.categorySource, 'regra_usuario');
  await dispose(db);
});

test('regra personalizada desativada volta a valer a regra inicial', async () => {
  const db = await freshDb();
  const rule = await createRule(db, { pattern: 'ifood', matchType: 'contains', categoryId: 'compras' });
  await setRuleActive(db, rule.id, false);
  const { rules, ids } = await ctxOf(db);
  assertEqual(categorize(tx('IFOOD'), rules, ids).categoryId, 'alimentacao');
  await dispose(db);
});

test('regras: nome exato, começa com, palavra inteira e contém', async () => {
  const db = await freshDb();
  await createRule(db, { pattern: 'Bazar do Zé', matchType: 'exact', categoryId: 'alimentacao' });
  await createRule(db, { pattern: 'farmacia', matchType: 'startsWith', categoryId: 'saude' });
  await createRule(db, { pattern: 'gym', matchType: 'word', categoryId: 'saude' });
  await createRule(db, { pattern: 'streaming', matchType: 'contains', categoryId: 'assinaturas' });
  const { rules, ids } = await ctxOf(db);
  const cat = (d) => categorize(tx(d), rules, ids).categoryId;
  assertEqual(cat('COMPRA BAZAR DO ZE'), 'alimentacao', 'exato (merchant):');
  assertEqual(cat('COMPRA BAZAR DO ZE FILIAL 2'), 'outros', 'exato não casa com nome maior:');
  assertEqual(cat('FARMACIA POPULAR'), 'saude', 'começa com:');
  assertEqual(cat('SMART GYM MENSALIDADE'), 'saude', 'palavra:');
  assertEqual(cat('GYMNASIO CENTRAL'), 'outros', 'palavra inteira não casa com parte:');
  assertEqual(cat('ASSINATURA STREAMING PLUS'), 'assinaturas', 'contém:');
  await dispose(db);
});

test('regras: validação, duplicata e proteção das regras iniciais', async () => {
  const db = await freshDb();
  const fails = async (fn) => { try { await fn(); return false; } catch { return true; } };
  assert(await fails(() => createRule(db, { pattern: '  ', matchType: 'contains', categoryId: 'outros' })), 'texto vazio');
  assert(await fails(() => createRule(db, { pattern: 'x1', matchType: 'contains', categoryId: 'nao-existe' })), 'categoria inexistente');
  const r = await createRule(db, { pattern: 'netflix', matchType: 'contains', categoryId: 'assinaturas' });
  assert(await fails(() => createRule(db, { pattern: 'NETFLIX', matchType: 'contains', categoryId: 'assinaturas' })), 'duplicada');
  const edited = await updateRule(db, r.id, { pattern: 'netflix', matchType: 'contains', categoryId: 'entretenimento' });
  assertEqual(edited.categoryId, 'entretenimento');
  await deleteRule(db, r.id);
  assertEqual((await listRules(db)).length, (await (await fetch('../data/merchant-rules.json')).json()).length, 'só sobraram as iniciais:');
  const initial = (await listRules(db))[0];
  assert(await fails(() => deleteRule(db, initial.id)), 'inicial não pode ser excluída');
  assert(await fails(() => updateRule(db, initial.id, { pattern: 'a', matchType: 'contains', categoryId: 'outros' })), 'inicial não pode ser editada');
  await setRuleActive(db, initial.id, false); // mas pode ser desativada
  assertEqual((await db.get('rules', initial.id)).ativa, false);
  await dispose(db);
});

// ------------------------------------------------------------ categorias
test('categorias: criar, editar, nome duplicado e proteção das iniciais', async () => {
  const db = await freshDb();
  const fails = async (fn) => { try { await fn(); return false; } catch { return true; } };
  const pets = await createCategory(db, { nome: 'Hobbies', cor: '#ff8800' });
  assertEqual(pets.id, 'hobbies');
  assert(await fails(() => createCategory(db, { nome: 'hobbies', cor: '#000000' })), 'nome duplicado');
  assert(await fails(() => createCategory(db, { nome: 'alimentacao', cor: '#000000' })), 'duplica inicial (sem acento)');
  const edited = await updateCategory(db, 'hobbies', { nome: 'Animais', cor: '#112233' });
  assertEqual(edited.nome, 'Animais');
  assert(await fails(() => updateCategory(db, 'alimentacao', { nome: 'Comida', cor: '#000000' })), 'renomear inicial');
  assertEqual((await updateCategory(db, 'alimentacao', { cor: '#123456' })).cor, '#123456', 'cor da inicial pode mudar:');
  assert(await fails(() => deleteCategory(db, 'alimentacao')), 'excluir inicial');
  await dispose(db);
});

test('categorias: excluir em uso exige destino e move transações e regras sem perder dados', async () => {
  const db = await freshDb();
  await createCategory(db, { nome: 'Hobbies', cor: '#ff8800' });
  await createRule(db, { pattern: 'petshop', matchType: 'contains', categoryId: 'hobbies' });
  const id = await addTx(db, 'PETSHOP AMIGO', -5000);
  await recategorize(db);
  assertEqual((await db.get('transactions', id)).categoryId, 'hobbies');
  const before = await db.get('transactions', id);
  assertEqual((await categoryUsage(db, 'hobbies')).transactions, 1);
  let erro = null;
  try { await deleteCategory(db, 'hobbies'); } catch (e) { erro = e; }
  assert(erro, 'sem destino deve recusar');
  assert(await db.get('categories', 'hobbies'), 'categoria continua existindo após recusa');
  const result = await deleteCategory(db, 'hobbies', 'outros');
  assertEqual(result.movedTransactions, 1);
  assertEqual(result.movedRules, 1);
  const after = await db.get('transactions', id);
  assertEqual(after.categoryId, 'outros');
  for (const f of ['date', 'amount', 'originalDescription', 'normalizedName', 'fingerprint']) assertEqual(after[f], before[f], f + ':');
  assertEqual(await db.get('categories', 'hobbies'), undefined);
  assertEqual((await listRules(db)).find((r) => r.pattern === 'petshop').categoryId, 'outros');
  await dispose(db);
});

// ------------------------------------------------------------ correção manual
test('correção manual: preservada ao reabrir o banco (simula atualizar a página) e ao recategorizar', async () => {
  const db = await freshDb();
  const id = await addTx(db, 'COMPRA IFOOD *RESTAURANTE'); // regra diria Alimentação
  await recategorize(db);
  assertEqual((await db.get('transactions', id)).categoryId, 'alimentacao');
  await setCategory(db, [id], 'entretenimento');
  const name = db._testName;
  db.close();

  const reopened = await new Database(name).open(); // "atualizar a página"
  reopened._testName = name;
  let t = await reopened.get('transactions', id);
  assertEqual(t.categoryId, 'entretenimento', 'persistiu no IndexedDB:');
  assertEqual(t.manual, true);
  assertEqual(t.categorySource, 'manual');

  await recategorize(reopened); // regras rodando de novo
  await createRule(reopened, { pattern: 'ifood', matchType: 'contains', categoryId: 'compras' });
  await recategorize(reopened);
  t = await reopened.get('transactions', id);
  assertEqual(t.categoryId, 'entretenimento', 'correção manual não é sobrescrita:');
  await dispose(reopened);
});

test('memorização: correção cria regra e vale para futuras transações, sem tocar nas manuais', async () => {
  const db = await freshDb();
  const a = await addTx(db, 'COMPRA DEBITO BAZAR DO ZE', -1500);
  const b = await addTx(db, 'COMPRA DEBITO BAZAR DO ZE', -1800, '2026-03-06');
  const manual = await addTx(db, 'COMPRA DEBITO BAZAR DO ZE', -900, '2026-03-07');
  await recategorize(db);
  await setCategory(db, [manual], 'saude'); // usuário já havia decidido esta
  const result = await setCategory(db, [a], 'alimentacao', { remember: true });
  assertEqual(result.rules, 1);
  const rule = (await listRules(db)).find((r) => r.origem === 'usuario');
  assertEqual(rule.matchType, 'exact');
  assertEqual(rule.pattern, 'bazar do ze');
  assertEqual((await db.get('transactions', b)).categoryId, 'alimentacao', 'outra igual foi atualizada:');
  assertEqual((await db.get('transactions', manual)).categoryId, 'saude', 'manual preservada:');
  // futura importação: transação nova já nasce classificada pela regra memorizada
  const { rules, ids } = await ctxOf(db);
  const futura = categorize(tx('COMPRA DEBITO BAZAR DO ZE'), rules, ids);
  assertEqual(futura.categoryId, 'alimentacao');
  assertEqual(futura.categorySource, 'regra_usuario');
  // memorizar de novo muda a mesma regra em vez de duplicar
  await rememberMerchant(db, 'bazar do ze', 'compras');
  assertEqual((await listRules(db)).filter((r) => r.origem === 'usuario').length, 1);
  await dispose(db);
});

// ------------------------------------------------------------ lote, confirmação, voltar ao automático
test('lote: categorizar várias de uma vez, confirmar sugestões e voltar ao automático', async () => {
  const db = await freshDb();
  const ids = [];
  for (const d of ['LOJA A', 'LOJA B', 'LOJA C']) ids.push(await addTx(db, d));
  const ifood = await addTx(db, 'COMPRA IFOD CENTRAL'); // sugestão aproximada
  const n99 = await addTx(db, 'PAGAMENTO 99 APP');
  await recategorize(db);

  const lote = await setCategory(db, ids, 'compras');
  assertEqual(lote.changed, 3);
  for (const id of ids) {
    const t = await db.get('transactions', id);
    assertEqual(t.categoryId, 'compras');
    assertEqual(t.status, 'classificada');
    assertEqual(t.manual, true);
  }

  const conf = await confirmSuggestions(db, [ifood, n99]);
  assertEqual(conf.changed, 1, 'confirmou a sugestão do IFOD:');
  assertEqual(conf.skipped, 1, '99 não tem sugestão:');
  const confirmada = await db.get('transactions', ifood);
  assertEqual(confirmada.categoryId, 'alimentacao');
  assertEqual(confirmada.status, 'classificada');
  assertEqual((await db.get('transactions', n99)).status, 'pendente', '99 continua pendente:');

  await resetToAutomatic(db, ids);
  const volta = await db.get('transactions', ids[0]);
  assertEqual(volta.manual, false);
  assertEqual(volta.categoryId, 'outros', 'voltou ao automático (desconhecido):');
  assertEqual(volta.status, 'pendente');
  await dispose(db);
});

test('lote: categoria inexistente é recusada e nada muda', async () => {
  const db = await freshDb();
  const id = await addTx(db, 'LOJA A');
  await recategorize(db);
  let erro = null;
  try { await setCategory(db, [id], 'nao-existe'); } catch (e) { erro = e; }
  assert(erro);
  assertEqual((await db.get('transactions', id)).manual, undefined);
  await dispose(db);
});

// ------------------------------------------------------------ integridade
test('integridade: data, valor, descrição original e nome normalizado nunca mudam', async () => {
  const db = await freshDb();
  const id = await addTx(db, 'COMPRA DEBITO IFD*IFOOD SAO PAULO', -4590, '2026-03-03');
  const before = await db.get('transactions', id);
  await recategorize(db);
  await setCategory(db, [id], 'compras', { remember: true });
  await createRule(db, { pattern: 'ifood', matchType: 'contains', categoryId: 'saude' });
  await recategorize(db);
  await resetToAutomatic(db, [id]);
  await confirmSuggestions(db, [id]);
  const after = await db.get('transactions', id);
  for (const f of ['date', 'amount', 'originalDescription', 'normalizedName', 'fingerprint', 'type', 'importId']) {
    assertEqual(after[f], before[f], `${f} intacto:`);
  }
  assertEqual(after.merchantName, 'ifd ifood sao paulo', 'nome do estabelecimento guardado à parte:');
  assertEqual(await db.count('transactions'), 1, 'sem duplicar transações:');
  await dispose(db);
});

test('migração: transações da Etapa 2 são categorizadas uma vez, sem mexer nas manuais', async () => {
  const db = await freshDb();
  const velha = await addTx(db, 'COMPRA IFOOD');
  const manual = await addTx(db, 'LOJA X');
  await setCategory(db, [manual], 'saude');
  assertEqual(await migrateLegacy(db), 1);
  const t = await db.get('transactions', velha);
  assertEqual(t.categoryId, 'alimentacao');
  assertEqual(t.categorySource, 'regra_inicial');
  assertEqual(await migrateLegacy(db), 0, 'segunda vez não muda nada:');
  assertEqual((await db.get('transactions', manual)).categoryId, 'saude');
  await dispose(db);
});

test('recategorizar é estável: rodar de novo não regrava nada que não mudou', async () => {
  const db = await freshDb();
  await addTx(db, 'COMPRA IFOOD');
  await addTx(db, 'LOJA QUALQUER');
  assertEqual(await recategorize(db), 2, 'primeira vez classifica:');
  assertEqual(await recategorize(db), 0, 'segunda vez não muda nada:');
  await createRule(db, { pattern: 'ifood', matchType: 'contains', categoryId: 'compras' });
  assertEqual(await recategorize(db), 1, 'só a que a nova regra afeta:');
  await dispose(db);
});

// ------------------------------------------------------------ filtros
test('filtros: busca por estabelecimento/descrição, categoria, pendências e sem categoria', async () => {
  const db = await freshDb();
  await addTx(db, 'COMPRA IFOOD *PIZZARIA', -3000);
  await addTx(db, 'UBER *TRIP', -2000);
  await addTx(db, 'PAGAMENTO 99 APP', -1500);
  await addTx(db, 'BAZAR DO ZE', -800);
  await recategorize(db);
  const all = await db.getAll('transactions');
  assertEqual(filterTransactions(all, { search: 'pizzaria' }).length, 1);
  assertEqual(filterTransactions(all, { search: 'IFOOD' }).length, 1, 'ignora maiúsculas:');
  assertEqual(filterTransactions(all, { category: 'transporte' }).length, 1);
  assertEqual(filterTransactions(all, { category: '__sem' }).length, 1, 'sem categoria = o 99:');
  assertEqual(filterTransactions(all, { status: 'pendente' }).length, 2, '99 e bazar:');
  assertEqual(filterTransactions(all, { status: 'classificada' }).length, 2);
  assertEqual(filterTransactions(all, { search: 'zzz' }).length, 0);
  await dispose(db);
});
