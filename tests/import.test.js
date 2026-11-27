import { test, assert, assertEqual } from './runner.js';
import { parseMoneyBR } from '../js/utils/money.js';
import { classifyMovement } from '../js/import/movementTypes.js';
import { groupItemsIntoLines, extractLines, ImportError } from '../js/pdf/pdfReader.js';
import { parseStatement } from '../js/pdf/parsers/index.js';
import { markDuplicates } from '../js/import/duplicates.js';
import { analyzePdf, applyYear, saveReviewed, syncSignedAmount, isSavable } from '../js/import/importService.js';
import { Database, deleteDatabase } from '../js/db.js';
import { seedDefaults } from '../js/seed.js';

const L = (text, page = 1) => ({ page, text });
const byDesc = (res, part) => res.transactions.find((t) => t.originalDescription.includes(part));

async function loadSample(name) {
  const response = await fetch(`../samples/${name}`);
  assert(response.ok, `não carregou ${name}`);
  const blob = await response.blob();
  return new File([blob], name, { type: 'application/pdf' });
}

async function freshDb(tag) {
  const name = `mfa-test-imp-${tag}-${Date.now()}`;
  const db = await new Database(name).open();
  await seedDefaults(db, '../data/');
  db._testName = name;
  return db;
}

// ---------------------------------------------------------------- valores em R$
test('valor BR: formatos comuns', () => {
  assertEqual(parseMoneyBR('R$ 1.234,56').cents, 123456);
  assertEqual(parseMoneyBR('1234,56').cents, 123456);
  assertEqual(parseMoneyBR('0,99').cents, 99);
  assertEqual(parseMoneyBR('-45,90').negative, true);
  assertEqual(parseMoneyBR('45,90-').negative, true);
  assertEqual(parseMoneyBR('(45,90)').negative, true);
  assertEqual(parseMoneyBR('-R$ 89,90').cents, 8990);
  assertEqual(parseMoneyBR('1.234,56 D').suffix, 'D');
  assertEqual(parseMoneyBR('100,00 C').suffix, 'C');
});

test('valor BR: rejeita formatos ambíguos ou inválidos (não adivinha)', () => {
  assertEqual(parseMoneyBR('12.50'), null);
  assertEqual(parseMoneyBR('abc'), null);
  assertEqual(parseMoneyBR(''), null);
  assertEqual(parseMoneyBR('10,5'), null);
  assertEqual(parseMoneyBR('10,00 e 20,00'), null);
});

// ---------------------------------------------------------------- tipos de movimentação
test('tipo: PIX, débito, estorno, tarifa, saque', () => {
  assertEqual(classifyMovement('PIX RECEBIDO JOAO').type, 'pix_recebido');
  assertEqual(classifyMovement('PIX RECEBIDO JOAO').direction, 'entrada');
  assertEqual(classifyMovement('PIX ENVIADO MARIA').direction, 'saida');
  assertEqual(classifyMovement('COMPRA DEBITO MERCADO').type, 'compra_debito');
  assertEqual(classifyMovement('ESTORNO COMPRA IFOOD').type, 'estorno');
  assertEqual(classifyMovement('ESTORNO COMPRA IFOOD').direction, 'entrada');
  assertEqual(classifyMovement('TARIFA PACOTE').type, 'tarifa');
  assertEqual(classifyMovement('SAQUE ATM').type, 'saque');
});

test('tipo: texto sem pista não inventa direção', () => {
  assertEqual(classifyMovement('PIX').direction, null);
  assertEqual(classifyMovement('XPTO LTDA').direction, null);
  assertEqual(classifyMovement('XPTO LTDA').type, 'outro');
});

// ---------------------------------------------------------------- leitura de linhas
test('leitor: agrupa pedaços de texto em linhas pela posição', () => {
  const lines = groupItemsIntoLines([
    { str: '250,00', x: 300, y: 700 },
    { str: '03/03/2026', x: 40, y: 700.5 },
    { str: 'PIX RECEBIDO', x: 110, y: 700 },
    { str: '04/03/2026', x: 40, y: 680 },
    { str: '  ', x: 10, y: 650 },
  ]);
  assertEqual(lines.length, 2);
  assertEqual(lines[0], '03/03/2026 PIX RECEBIDO 250,00');
});

// ---------------------------------------------------------------- parser
test('parser: data, descrição, valor e direção por sinal', () => {
  const r = parseStatement([L('03/03/2026 COMPRA DEBITO IFOOD *RESTAURANTE -45,90 1.704,10')]);
  assertEqual(r.transactions.length, 1);
  const t = r.transactions[0];
  assertEqual(t.date, '2026-03-03');
  assertEqual(t.absAmount, 4590, 'valor usa o primeiro número:');
  assertEqual(t.direction, 'saida');
  assertEqual(t.originalDescription, 'COMPRA DEBITO IFOOD *RESTAURANTE');
  assertEqual(t.normalizedName, 'compra debito ifood restaurante');
  assert(t.warnings.some((w) => w.code === 'varios_valores'), 'deveria avisar sobre o saldo');
});

test('parser: C/D, estorno e PIX recebido', () => {
  const r = parseStatement([
    L('22/03/2026 PAGAMENTO FATURA 1.234,56 D'),
    L('25/03/2026 DEPOSITO 100,00 C'),
    L('08/03/2026 ESTORNO COMPRA IFOOD 45,90'),
    L('03/03/2026 PIX RECEBIDO JOAO 250,00'),
  ]);
  assertEqual(r.transactions[0].direction, 'saida');
  assertEqual(r.transactions[1].direction, 'entrada');
  assertEqual(r.transactions[2].direction, 'entrada');
  assertEqual(r.transactions[2].type, 'estorno');
  assertEqual(r.transactions[3].type, 'pix_recebido');
});

test('parser: sem sinal e sem pista → direção em branco e bloqueada', () => {
  const t = parseStatement([L('20/03/2026 PIX 150,00')]).transactions[0];
  assertEqual(t.direction, null);
  assert(t.warnings.some((w) => w.code === 'sem_direcao' && w.level === 'bloqueio'));
  assert(!isSavable({ ...t, date: '2026-03-20' }), 'não pode ser salva sem direção');
});

test('parser: ano vem do período do cabeçalho, nunca é inventado', () => {
  const comPeriodo = parseStatement([L('Periodo: 01/03/2026 a 31/03/2026'), L('25/03 DEPOSITO 100,00 C')]);
  assertEqual(comPeriodo.transactions[0].date, '2026-03-25');
  const semPeriodo = parseStatement([L('25/03 DEPOSITO 100,00 C')]);
  assertEqual(semPeriodo.transactions[0].date, null);
  assert(semPeriodo.transactions[0].warnings.some((w) => w.code === 'sem_ano'));
});

test('parser: período que cruza o ano escolhe o ano certo', () => {
  const r = parseStatement([L('Periodo: 15/12/2025 a 14/01/2026'), L('20/12 COMPRA -10,00'), L('05/01 COMPRA -20,00')]);
  assertEqual(r.transactions[0].date, '2025-12-20');
  assertEqual(r.transactions[1].date, '2026-01-05');
});

test('parser: data inexistente (31/02) é bloqueada', () => {
  const t = parseStatement([L('31/02/2026 COMPRA -10,00')]).transactions[0];
  assertEqual(t.date, null);
  assert(t.warnings.some((w) => w.code === 'data_invalida'));
});

test('parser: saldos são ignorados; linhas duvidosas vão para "não interpretadas"', () => {
  const r = parseStatement([
    L('SALDO ANTERIOR 1.500,00'), L('31/03/2026 SALDO FINAL 3.000,00'),
    L('R$ 99,90'), L('31/03/2026 AJUSTE CONTABIL'), L('Data Descricao Valor'),
    L('03/03/2026 COMPRA -10,00'),
  ]);
  assertEqual(r.transactions.length, 1);
  assertEqual(r.ignored.length, 2);
  assertEqual(r.unrecognized.length, 2);
});

test('parser: documento sem nenhuma movimentação reconhece nada', () => {
  const r = parseStatement([L('Texto qualquer'), L('Outro texto')]);
  assertEqual(r.parserId, null);
  assertEqual(r.transactions.length, 0);
});

// ---------------------------------------------------------------- duplicidades
test('duplicidade: reimportar marca como duplicada; iguais no mesmo arquivo não', () => {
  const mk = () => [
    { date: '2026-03-15', signedAmount: -6735, normalizedName: 'farmacia' },
    { date: '2026-03-15', signedAmount: -6735, normalizedName: 'farmacia' },
    { date: '2026-03-16', signedAmount: -1000, normalizedName: 'outra' },
  ];
  const first = markDuplicates(mk(), new Set());
  assert(first.every((r) => !r.duplicate), 'primeira importação: nenhuma duplicada');
  assert(first[0].fingerprint !== first[1].fingerprint, 'compras idênticas têm impressões diferentes');
  assert(first[0].repeatedInFile && first[1].repeatedInFile && !first[2].repeatedInFile);
  const existing = new Set(first.map((r) => r.fingerprint));
  const second = markDuplicates(mk(), existing);
  assert(second.every((r) => r.duplicate), 'reimportação: todas duplicadas');
});

test('duplicidade: extrato maior só marca o que já existia', () => {
  const rows = [
    { date: '2026-03-15', signedAmount: -500, normalizedName: 'cafe' },
    { date: '2026-03-15', signedAmount: -500, normalizedName: 'cafe' },
  ];
  const result = markDuplicates(rows, new Set(['2026-03-15|-500|cafe#1']));
  assertEqual(result[0].duplicate, true);
  assertEqual(result[1].duplicate, false);
});

test('duplicidade: linha incompleta não gera impressão digital', () => {
  const [row] = markDuplicates([{ date: null, signedAmount: null, normalizedName: 'x' }], new Set());
  assertEqual(row.fingerprint, null);
});

// ---------------------------------------------------------------- PDFs reais (PDF.js)
test('PDF real: modelo A é lido com PDF.js e interpretado', async () => {
  const db = await freshDb('a');
  const a = await analyzePdf(await loadSample('extrato-exemplo-modelo-a.pdf'), db);
  assertEqual(a.pageCount, 2);
  assertEqual(a.rows.length, 16, 'movimentações (8 por página):');
  assertEqual(a.ignored.length, 2, 'saldos ignorados:');
  assertEqual(a.unrecognized.length, 2, 'linhas não interpretadas:');
  const res = { transactions: a.rows };
  assertEqual(byDesc(res, 'IFOOD *REST').signedAmount, -4590);
  assertEqual(byDesc(res, 'UBER').direction, 'saida');
  assertEqual(byDesc(res, 'ESTORNO').signedAmount, 4590);
  assertEqual(byDesc(res, 'SALARIO').signedAmount, 320000);
  assertEqual(byDesc(res, 'FATURA').signedAmount, -123456, 'sufixo D com milhar:');
  assertEqual(byDesc(res, 'DEPOSITO').date, '2026-03-25', 'ano vindo do período:');
  assertEqual(byDesc(res, 'LIVRARIA').signedAmount, -8990, '-R$ 89,90:');
  const pix150 = a.rows.find((r) => r.originalDescription === 'PIX');
  assertEqual(pix150.direction, null, 'PIX sem pista fica em branco:');
  assertEqual(pix150.selected, false, 'e não vem marcado:');
  assertEqual(a.rows.filter((r) => r.originalDescription.includes('PAGUE MENOS')).length, 2);
  db.close(); await deleteDatabase(db._testName);
});

test('PDF real: modelo B pede o ano; applyYear completa só o que faltava', async () => {
  const db = await freshDb('b');
  const a = await analyzePdf(await loadSample('extrato-exemplo-modelo-b-sem-ano.pdf'), db);
  assertEqual(a.rows.length, 4);
  assert(a.rows.every((r) => r.date === null), 'nenhuma data inventada');
  assert(a.rows.every((r) => !r.selected), 'nada marcado antes de informar o ano');
  assertEqual(applyYear(a.rows, 2026), 4);
  assertEqual(a.rows[0].date, '2026-04-05');
  db.close(); await deleteDatabase(db._testName);
});

test('PDF real: PDF escaneado (sem texto) gera aviso claro', async () => {
  const file = await loadSample('extrato-exemplo-escaneado-sem-texto.pdf');
  let erro = null;
  try { await extractLines(file); } catch (e) { erro = e; }
  assert(erro instanceof ImportError, 'deveria lançar ImportError');
  assertEqual(erro.code, 'sem_texto');
  assert(/escaneado/i.test(erro.message), 'mensagem deve explicar a limitação');
});

test('PDF real: arquivo que não é PDF é recusado com mensagem', async () => {
  let erro = null;
  try { await extractLines(new File(['isto nao e pdf'], 'x.pdf')); } catch (e) { erro = e; }
  assert(erro instanceof ImportError);
  assertEqual(erro.code, 'invalido');
});

// ---------------------------------------------------------------- salvamento
test('salvar: grava só as marcadas, com original + normalizado, sem categoria', async () => {
  const db = await freshDb('save');
  const a = await analyzePdf(await loadSample('extrato-exemplo-modelo-a.pdf'), db);
  assertEqual(await db.count('transactions'), 0, 'analisar não salva nada:');
  const marcadas = a.rows.filter((r) => r.selected).length;
  const result = await saveReviewed(db, a);
  assertEqual(result.savedCount, marcadas);
  assertEqual(await db.count('transactions'), marcadas);
  const saved = (await db.getAll('transactions')).find((t) => t.originalDescription.includes('IFOOD *REST'));
  assertEqual(saved.amount, -4590);
  assertEqual(saved.normalizedName, 'compra debito ifood restaurante');
  assertEqual(saved.categoryId, 'alimentacao', 'já entra categorizada pela regra do iFood:');
  assertEqual(saved.status, 'classificada');
  assertEqual(saved.merchantName, 'ifood restaurante', 'nome do estabelecimento guardado à parte:');
  const n99 = (await db.getAll('transactions')).find((t) => t.originalDescription.includes('99 APP'));
  assertEqual(n99.categoryId, null, '99 fica sem categoria:');
  assertEqual(n99.status, 'pendente', '99 vai para revisão:');
  assertEqual((await db.getAll('imports')).length, 1);
  db.close(); await deleteDatabase(db._testName);
});

test('salvar: reimportar o mesmo PDF detecta duplicadas e não regrava', async () => {
  const db = await freshDb('dup');
  const file = await loadSample('extrato-exemplo-modelo-a.pdf');
  const first = await analyzePdf(file, db);
  await saveReviewed(db, first);
  const total = await db.count('transactions');
  const second = await analyzePdf(file, db);
  const dups = second.rows.filter((r) => r.duplicate).length;
  assertEqual(dups, total, 'todas as salvas voltam como duplicadas:');
  assert(second.rows.filter((r) => r.selected).length === 0, 'duplicadas não vêm marcadas');
  db.close(); await deleteDatabase(db._testName);
});

test('salvar: recusa linha marcada e incompleta (tudo ou nada)', async () => {
  const db = await freshDb('inc');
  const a = await analyzePdf(await loadSample('extrato-exemplo-modelo-a.pdf'), db);
  const pix = a.rows.find((r) => r.originalDescription === 'PIX');
  pix.selected = true; // sem direção: incompleta
  let erro = null;
  try { await saveReviewed(db, a); } catch (e) { erro = e; }
  assert(erro, 'deveria recusar');
  assertEqual(await db.count('transactions'), 0, 'nada salvo pela metade:');
  // usuário escolhe a direção → passa a poder salvar
  pix.direction = 'entrada'; syncSignedAmount(pix);
  assert(isSavable(pix));
  const result = await saveReviewed(db, a);
  assert(result.savedCount > 0);
  const gravada = (await db.getAll('transactions')).find((t) => t.originalDescription === 'PIX');
  assertEqual(gravada.amount, 15000);
  db.close(); await deleteDatabase(db._testName);
});

test('salvar: recusa quando nada está marcado', async () => {
  const db = await freshDb('none');
  const a = await analyzePdf(await loadSample('extrato-exemplo-modelo-b-sem-ano.pdf'), db);
  let erro = null;
  try { await saveReviewed(db, a); } catch (e) { erro = e; }
  assert(erro);
  db.close(); await deleteDatabase(db._testName);
});

// ---------------------------------------------------------------- compatibilidade com a Etapa 1
test('banco v1 → v3: dados da Etapa 1 são preservados', async () => {
  const name = `mfa-test-upgrade-${Date.now()}`;
  // Cria um banco no formato antigo (versão 1, sem "imports").
  await new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      const t = db.createObjectStore('transactions', { keyPath: 'id', autoIncrement: true });
      for (const i of ['date', 'categoryId', 'status', 'fingerprint', 'type']) t.createIndex(i, i);
      db.createObjectStore('categories', { keyPath: 'id' }).put({ id: 'alimentacao', nome: 'Alimentação' });
      t.put({ date: '2026-01-01', amount: -100, status: 'pendente' });
    };
    req.onsuccess = () => { req.result.close(); resolve(); };
    req.onerror = () => reject(req.error);
  });
  const db = await new Database(name).open();
  assertEqual(db.db.version, 3);
  assert(db.db.objectStoreNames.contains('imports'), 'tabela imports criada');
  assert(db.db.objectStoreNames.contains('receiptLinks'), 'tabela receiptLinks criada');
  assertEqual((await db.getAll('transactions')).length, 1, 'transação antiga preservada:');
  assertEqual((await db.get('categories', 'alimentacao')).nome, 'Alimentação');
  assertEqual((await db.getAllByIndex('transactions', 'importId', IDBKeyRange.only('x'))).length, 0, 'novo índice existe:');
  db.close(); await deleteDatabase(name);
});
