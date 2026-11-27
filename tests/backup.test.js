import { test, assert, assertEqual } from './runner.js';
import { Database, deleteDatabase } from '../js/db.js';
import { seedDefaults } from '../js/seed.js';
import { normalizeText } from '../js/utils/format.js';
import { getSetting, setSetting } from '../js/storage.js';
import { BACKUP_FORMAT, BACKUP_VERSION, STORES } from '../js/backup/backupFormat.js';
import { buildBackup, serializeBackup } from '../js/backup/backupExport.js';
import { validateBackup, parseBackupText } from '../js/backup/backupValidate.js';
import {
  planRestore, applyPlan, restoreBackup, currentCounts,
} from '../js/backup/backupRestore.js';
import {
  backupFileName, createBackupBlob, saveBackupFile, readBackupFile,
} from '../js/backup/backupFile.js';
import { recategorize, setCategory } from '../js/categorization/transactionService.js';
import { listRules } from '../js/categorization/ruleService.js';
import { createBudget } from '../js/budget/budgetService.js';
import { createSource } from '../js/cycles/incomeService.js';
import { saveManualAllocation, linkReceipt, setMode } from '../js/cycles/allocationService.js';
import { loadModel } from '../js/cycles/model.js';
import { loadDashboard } from '../js/dashboard/dashboardData.js';
import { ask } from '../js/agent/orchestrator.js';

let counter = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newDb({ seed = true } = {}) {
  const name = `mfa-test-bkp-${Date.now()}-${counter++}`;
  const db = await new Database(name).open();
  if (seed) await seedDefaults(db, '../data/');
  db._testName = name;
  return db;
}
async function dispose(db) { db.close(); await deleteDatabase(db._testName); }

async function addTx(db, desc, amount, date, extra = {}) {
  return db.add('transactions', {
    date, amount, type: amount > 0 ? (extra.type || 'pix_recebido') : 'compra', originalDescription: desc, normalizedName: normalizeText(desc),
    categoryId: null, status: 'pendente', fingerprint: `bk${Date.now()}-${counter++}`, importId: 'imp-1',
    sourceLine: 'LINHA BRUTA DO PDF COM SALDO 1.234,56', sourcePage: 1, ...extra,
  });
}

/** Banco com TODOS os tipos de dado: correções manuais, regra memorizada, orçamentos, rendas, alocação dividida, vínculo e importação. */
async function populate(db) {
  const t = {};
  t.ifood = await addTx(db, 'COMPRA IFOOD *PIZZA', -4590, '2026-03-03');
  t.uber = await addTx(db, 'UBER *TRIP', -2350, '2026-03-04');
  t.bazar = await addTx(db, 'COMPRA BAZAR DO ZE', -1500, '2026-03-05');
  t.bazar2 = await addTx(db, 'COMPRA BAZAR DO ZE', -1800, '2026-03-06');
  t.loja = await addTx(db, 'LOJA XPTO', -8000, '2026-03-07');
  t.aluguel = await addTx(db, 'ALUGUEL MARCO', -100000, '2026-03-01');
  t.salario = await addTx(db, 'SALARIO EMPRESA', 150000, '2026-03-16');
  t.estorno = await addTx(db, 'ESTORNO IFOOD', 4590, '2026-03-08', { type: 'estorno' });
  await recategorize(db);
  await setCategory(db, [t.loja], 'saude');                                       // correção manual
  await setCategory(db, [t.bazar], 'alimentacao', { remember: true });          // correção manual + regra do usuário
  await createBudget(db, { categoryId: 'alimentacao', limit: 60000 });
  await createBudget(db, { categoryId: 'transporte', limit: 25000 });
  t.a = await createSource(db, { name: 'Adiantamento', frequency: 'mensal', day: 15, amount: 150000 });
  t.b = await createSource(db, { name: 'Extra', frequency: 'mensal', day: 20, amount: 100000 });
  await saveManualAllocation(db, t.aluguel, [{ cycleId: `${t.a.id}@2026-03-15`, amount: 60000 }, { cycleId: `${t.b.id}@2026-03-20`, amount: 40000 }]);
  await linkReceipt(db, t.salario, `${t.a.id}@2026-03-15`);
  await setMode(db, 'proximo');
  await db.add('imports', { id: 'imp-1', importedAt: '2026-03-20T10:00:00.000Z', fileName: 'extrato.pdf', parserId: 'generico', savedCount: 8, skippedDuplicates: 0 });
  return t;
}

const dump = async (db) => { const b = await buildBackup(db, new Date('2026-01-01T00:00:00Z')); return JSON.stringify({ data: b.data, meta: b.meta }); };
const parsed = async (db) => { const r = parseBackupText(serializeBackup(await buildBackup(db))); assert(r.ok, r.errors?.join('; ')); return r; };
const failsWith = async (fn, re) => { try { await fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };

// ============================================================ exportação
test('exportar: JSON válido, versão do formato, data/hora, contagens e todas as tabelas', async () => {
  const db = await newDb();
  await populate(db);
  const now = new Date('2026-04-02T15:30:00Z');
  const backup = await buildBackup(db, now);
  assertEqual(backup.format, BACKUP_FORMAT);
  assertEqual(backup.formatVersion, BACKUP_VERSION);
  assertEqual(backup.exportedAt, '2026-04-02T15:30:00.000Z');
  assertEqual(JSON.stringify(Object.keys(backup.data)), JSON.stringify(STORES), 'todas as tabelas, na ordem de restauração:');
  for (const store of STORES) assertEqual(backup.counts[store], (await db.getAll(store)).length, `contagem de ${store}:`);
  assertEqual(backup.counts.transactions, 8);
  assertEqual(backup.counts.allocations, 2);
  assertEqual(backup.counts.receiptLinks, 1);
  assertEqual(backup.counts.incomes, 2);
  assertEqual(backup.counts.budgets, 2);
  assertEqual(backup.counts.imports, 1);
  assert(backup.counts.rules >= 6, 'regras iniciais + a do usuário');
  assertEqual(backup.meta.allocationMode, 'proximo');
  assertEqual(backup.meta.seeded, true);
  const text = serializeBackup(backup);
  assertEqual(JSON.stringify(JSON.parse(text)), JSON.stringify(backup), 'o texto é JSON válido e idêntico ao objeto:');
  assert(validateBackup(JSON.parse(text)).ok, 'o próprio backup passa na validação');
  await dispose(db);
});

test('exportar: só campos conhecidos; sem linha bruta do PDF, sem endereço de IA, sem credenciais', async () => {
  const db = await newDb();
  const t = await populate(db);
  const row = await db.get('transactions', t.ifood);
  await db.put('transactions', { ...row, campoInventado: 'segredo-123' });
  const prev = getSetting('llmEndpoint');
  setSetting('llmEndpoint', 'https://meu-backend-secreto.exemplo.com');
  try {
    const text = serializeBackup(await buildBackup(db));
    assert(!text.includes('LINHA BRUTA'), 'sourceLine fica de fora (pode ter saldo da conta)');
    assert(!text.includes('sourceLine') && !text.includes('sourcePage'));
    assert(!text.includes('segredo-123') && !text.includes('campoInventado'), 'campos desconhecidos não entram');
    assert(!text.includes('meu-backend-secreto'), 'o endereço do backend de IA não entra');
    assert(!/api[_-]?key|secret|token|authorization|password|senha|llmEndpoint/i.test(text), 'nenhuma credencial');
    const b = JSON.parse(text);
    assertEqual(Object.keys(b.meta).sort().join(), 'allocationMode,seeded');
    assert(b.data.transactions[0].originalDescription && b.data.transactions[0].normalizedName, 'descrição original e nome normalizado preservados');
  } finally { setSetting('llmEndpoint', prev || ''); }
  await dispose(db);
});

test('exportar: nomes de arquivo, Blob e salvamento pelo seletor ou por download (sem rede)', async () => {
  assertEqual(backupFileName(new Date(2026, 3, 2, 9, 5)), 'cifrai-backup-2026-04-02-0905.json');
  const db = await newDb();
  await populate(db);
  const backup = await buildBackup(db);
  const blob = createBackupBlob(backup);
  assertEqual(blob.type, 'application/json');
  assert(parseBackupText(await blob.text()).ok, 'o arquivo gerado pode ser lido de volta');

  // 1) seletor "Salvar como" (o usuário escolhe onde)
  setSetting('lastBackup', null);
  let written = null; let asked = null;
  const picker = async (options) => { asked = options; return { name: 'escolhido.json', createWritable: async () => ({ write: async (b) => { written = b; }, close: async () => {} }) }; };
  const r1 = await saveBackupFile(backup, { picker, now: new Date('2026-04-02T12:00:00Z') });
  assertEqual(r1.method, 'picker');
  assertEqual(r1.fileName, 'escolhido.json');
  assert(/^cifrai-backup-/.test(asked.suggestedName) && asked.types[0].accept['application/json'][0] === '.json');
  assert(parseBackupText(await written.text()).ok);
  assertEqual(getSetting('lastBackup'), '2026-04-02T12:00:00.000Z', 'lembrete do último backup:');

  // 2) o usuário cancela a janela: nada é salvo e o lembrete não muda
  const cancelled = await saveBackupFile(backup, { picker: async () => { throw new DOMException('cancelado', 'AbortError'); }, now: new Date('2026-05-01T00:00:00Z') });
  assertEqual(cancelled.saved, false);
  assertEqual(cancelled.cancelled, true);
  assertEqual(getSetting('lastBackup'), '2026-04-02T12:00:00.000Z');

  // 3) sem seletor: download comum (clique no link é interceptado para não baixar de verdade no teste)
  const original = HTMLAnchorElement.prototype.click;
  let link = null;
  HTMLAnchorElement.prototype.click = function capture() { link = { download: this.download, href: this.href }; };
  try {
    const r3 = await saveBackupFile(backup, { picker: null, now: new Date('2026-06-01T08:00:00Z') });
    assertEqual(r3.method, 'download');
    assert(/\.json$/.test(link.download) && link.href.startsWith('blob:'), 'link de download criado');
  } finally { HTMLAnchorElement.prototype.click = original; }
  setSetting('lastBackup', null);
  await dispose(db);
});

test('privacidade: os módulos de backup não têm nenhum código de rede', async () => {
  for (const f of ['backupFormat', 'backupExport', 'backupValidate', 'backupRestore', 'backupFile']) {
    const text = await (await fetch(`../js/backup/${f}.js`)).text();
    const code = text.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    for (const re of [/fetch\(/, /XMLHttpRequest/, /sendBeacon/, /WebSocket/, /EventSource/, /https?:\/\//]) assert(!re.test(code), `${f}.js contém ${re}`);
  }
});

// ============================================================ validação do arquivo
async function goodBackupObject() {
  const db = await newDb();
  await populate(db);
  const obj = JSON.parse(serializeBackup(await buildBackup(db)));
  await dispose(db);
  return obj;
}
const check = (obj) => validateBackup(JSON.parse(JSON.stringify(obj)));

test('validar: aceita o backup exportado e traz um resumo', async () => {
  const obj = await goodBackupObject();
  const r = check(obj);
  assertEqual(r.ok, true);
  assertEqual(r.summary.counts.transactions, 8);
  assertEqual(r.summary.formatVersion, 1);
  assertEqual(r.summary.firstDate, '2026-03-01');
  assertEqual(r.summary.lastDate, '2026-03-16');
  const parsedOk = parseBackupText(JSON.stringify(obj));
  assertEqual(parsedOk.ok, true);
  assertEqual(parsedOk.backup.data.transactions.length, 8);
});

test('validar: arquivos inválidos e incompatíveis são recusados com mensagem clara', async () => {
  const obj = await goodBackupObject();
  const bad = (text) => { const r = parseBackupText(text); assertEqual(r.ok, false, text.slice(0, 40)); return r; };
  assert(/vazio/.test(bad('').errors[0]));
  assert(/JSON válido/.test(bad('{ isto não é json').errors[0]));
  assert(/JSON válido/.test(bad('<html></html>').errors[0]));
  assert(/objeto/.test(bad('[1,2]').errors[0]));
  assert(/objeto/.test(bad('"texto"').errors[0]));
  assert(/não é um backup/.test(bad('{"format":"outro-app","formatVersion":1}').errors[0]));
  assert(/não é um backup/.test(bad('{}').errors[0]));
  const semVersao = { ...obj }; delete semVersao.formatVersion;
  assertEqual(bad(JSON.stringify(semVersao)).incompatible, true);
  assertEqual(bad(JSON.stringify({ ...obj, formatVersion: '1' })).incompatible, true, 'versão como texto:');
  assertEqual(bad(JSON.stringify({ ...obj, formatVersion: 0 })).incompatible, true);
  const futuro = bad(JSON.stringify({ ...obj, formatVersion: 99 }));
  assertEqual(futuro.incompatible, true);
  assert(/mais nova/.test(futuro.errors[0]) && /Atualize/.test(futuro.errors[0]), futuro.errors[0]);
  assert(/"data"/.test(bad(JSON.stringify({ ...obj, data: undefined })).errors[0]));
  assert(/obrigatória/.test(bad(JSON.stringify({ ...obj, data: { ...obj.data, transactions: undefined } })).errors.join(' ')));
  assert(/deve ser uma lista/.test(bad(JSON.stringify({ ...obj, data: { ...obj.data, rules: {} } })).errors.join(' ')));
});

test('validar: tipos e integridade entre as tabelas', async () => {
  const obj = await goodBackupObject();
  const mutate = (fn) => { const c = JSON.parse(JSON.stringify(obj)); fn(c); return check(c); };
  const has = (r, re) => { assertEqual(r.ok, false); assert(re.test(r.errors.join(' | ')), `esperava ${re} em: ${r.errors.join(' | ')}`); };
  has(mutate((c) => { c.data.transactions[0].date = '2026-02-30'; }), /data inválida/);
  has(mutate((c) => { c.data.transactions[0].amount = 10.5; }), /inteiro de centavos/);
  has(mutate((c) => { c.data.transactions[0].amount = 0; }), /diferente de zero/);
  has(mutate((c) => { c.data.transactions[0].amount = '45,90'; }), /inteiro de centavos/);
  has(mutate((c) => { c.data.transactions[0].id = -3; }), /id inválido/);
  has(mutate((c) => { c.data.transactions[1].id = c.data.transactions[0].id; }), /id repetido/);
  has(mutate((c) => { c.data.transactions[0].categoryId = 'categoria-fantasma'; }), /não existe no backup/);
  has(mutate((c) => { c.data.transactions[0].originalDescription = 42; }), /descrição original/);
  has(mutate((c) => { c.data.transactions[0].manual = 'sim'; }), /verdadeiro\/falso/);
  has(mutate((c) => { c.data.categories[0].cor = 'vermelho'; }), /cor inválida/);
  has(mutate((c) => { c.data.rules[0].matchType = 'parecido'; }), /tipo de comparação/);
  has(mutate((c) => { c.data.rules[0].categoryId = 'fantasma'; }), /categoria que não existe/);
  has(mutate((c) => { c.data.budgets[0].limit = 0; }), /maior que zero/);
  has(mutate((c) => { c.data.budgets[1].categoryId = c.data.budgets[0].categoryId; }), /mais de um orçamento/);
  has(mutate((c) => { c.data.incomes[0].day = 40; }), /dia do recebimento/);
  has(mutate((c) => { c.data.allocations[0].amount = 1; }), /soma das partes/);
  has(mutate((c) => { c.data.allocations[0].transactionId = 99999; }), /transação que não existe/);
  has(mutate((c) => { c.data.allocations[0].cycleId = '77@2026-03-15'; }), /fonte de renda que não existe/);
  has(mutate((c) => { c.data.allocations[0].transactionId = c.data.receiptLinks[0].transactionId; }), /só despesas/);
  has(mutate((c) => { c.data.receiptLinks[0].cycleId = 'lixo'; }), /ciclo inválido/);
  has(mutate((c) => { c.data.receiptLinks[0].transactionId = c.data.allocations[0].transactionId; }), /só entradas/);
  has(mutate((c) => { c.meta.allocationMode = 'qualquer'; }), /allocationMode/);
  has(mutate((c) => { c.exportedAt = 'ontem'; }), /exportedAt/);
  const muitos = mutate((c) => {
    for (let i = 0; i < 40; i++) c.data.transactions.push({ id: 1000 + i, date: 'x', amount: 0, originalDescription: 1, normalizedName: 2 });
  });
  assert(muitos.errors.length <= 26 && /mais problemas/.test(muitos.errors.at(-1)), 'lista de erros limitada');
  const ok = mutate((c) => { c.data.transactions[0].categoryId = null; delete c.data.transactions[0].suggestedCategoryId; });
  assertEqual(ok.ok, true, 'categoria vazia é permitida:');
});

test('validar: campos desconhecidos são descartados e tabelas desconhecidas só geram aviso', async () => {
  const obj = await goodBackupObject();
  obj.data.transactions[0].campoPerigoso = '<script>alert(1)</script>';
  obj.data.extra = [1];
  obj.segredo = 'x';
  const text = JSON.stringify(obj).replace('"campoPerigoso"', '"campoPerigoso"');
  const r = parseBackupText(text);
  assertEqual(r.ok, true);
  assert(r.warnings.some((w) => /desconhecida/.test(w)));
  assertEqual(r.backup.data.transactions[0].campoPerigoso, undefined, 'campo desconhecido removido na cópia limpa:');
  assertEqual(r.backup.segredo, undefined);
  const proto = parseBackupText('{"format":"my-finance-agent-backup","formatVersion":1,"exportedAt":"2026-01-01T00:00:00Z","data":{"categories":[],"transactions":[],"__proto__":{"polluted":true}}}');
  assertEqual({}.polluted, undefined, 'sem poluição de protótipo:');
  assert(proto.ok || proto.errors.length > 0);
});

test('nome do formato: backups novos (CifrAI) e antigos (My Finance Agent) são aceitos; outros são recusados', () => {
  const make = (format) => JSON.stringify({ format, formatVersion: 1, exportedAt: '2026-01-01T00:00:00Z', data: { categories: [], transactions: [] } });
  assertEqual(BACKUP_FORMAT, 'cifrai-backup', 'formato atual:');
  assertEqual(parseBackupText(make('cifrai-backup')).ok, true, 'formato novo:');
  assertEqual(parseBackupText(make('my-finance-agent-backup')).ok, true, 'formato antigo continua valendo:');
  const other = parseBackupText(make('outro-app-backup'));
  assertEqual(other.ok, false);
  assert(/não é um backup do CifrAI/.test(other.errors[0]), other.errors[0]);
});

test('abrir arquivo: grande demais, ilegível ou vazio', async () => {
  const gigante = { size: 60 * 1024 * 1024, text: async () => '{}' };
  const r = await readBackupFile(gigante);
  assertEqual(r.ok, false);
  assert(/grande demais/.test(r.errors[0]));
  assertEqual((await readBackupFile(null)).ok, false);
  assertEqual((await readBackupFile({ size: 5, text: async () => { throw new Error('x'); } })).ok, false);
  const real = await readBackupFile(new File(['lixo'], 'x.json', { type: 'application/json' }));
  assertEqual(real.ok, false);
  const db = await newDb();
  await populate(db);
  const good = await readBackupFile(new File([serializeBackup(await buildBackup(db))], 'b.json'));
  assertEqual(good.ok, true);
  await dispose(db);
});

// ============================================================ restauração
test('restaurar em banco vazio (substituir): tudo volta idêntico, com os mesmos ids', async () => {
  const a = await newDb();
  await populate(a);
  const original = await dump(a);
  const { backup } = await parsed(a);
  const before = await loadDashboard(a, { preset: 'ultimo_com_dados', custom: {}, today: '2026-03-31' });

  const b = await newDb({ seed: false });
  assertEqual((await currentCounts(b)).transactions, 0);
  const plan = await planRestore(b, backup, 'replace');
  assertEqual((await currentCounts(b)).transactions, 0, 'planejar não grava nada:');
  const summary = await restoreBackup(b, backup, { mode: 'replace', confirmed: true, plan });
  assertEqual(summary.added.transactions, 8);
  assertEqual(await dump(b), original, 'dados idênticos após restaurar:');
  const after = await loadDashboard(b, { preset: 'ultimo_com_dados', custom: {}, today: '2026-03-31' });
  assertEqual(JSON.stringify(after.summary), JSON.stringify(before.summary), 'indicadores idênticos:');
  assertEqual(JSON.stringify(after.byCategory), JSON.stringify(before.byCategory));
  const newId = await b.add('transactions', { date: '2026-03-20', amount: -100, originalDescription: 'N', normalizedName: 'n', fingerprint: 'novo' });
  assert(newId > Math.max(...(await a.getAll('transactions')).map((t) => t.id)), 'novos registros continuam a numeração:');
  await dispose(a); await dispose(b);
});

test('restaurar preserva transações, regras e correções manuais', async () => {
  const a = await newDb();
  const t = await populate(a);
  const { backup } = await parsed(a);
  const b = await newDb({ seed: false });
  await restoreBackup(b, backup, { mode: 'replace', confirmed: true });
  const loja = await b.get('transactions', t.loja);
  assertEqual(loja.manual, true);
  assertEqual(loja.categoryId, 'saude');
  assertEqual(loja.amount, -8000);
  assertEqual(loja.originalDescription, 'LOJA XPTO');
  assertEqual(loja.normalizedName, 'loja xpto');
  const rules = await listRules(b);
  assert(rules.some((r) => r.origem === 'usuario' && r.pattern === 'bazar do ze' && r.matchType === 'exact'), 'regra do usuário preservada');
  assert(rules.filter((r) => r.origem === 'inicial').length >= 5);
  // as correções continuam protegidas depois de restaurar
  await recategorize(b);
  assertEqual((await b.get('transactions', t.loja)).categoryId, 'saude', 'correção manual continua protegida:');
  assertEqual((await b.get('transactions', t.bazar2)).categoryId, 'alimentacao', 'a regra memorizada continua valendo:');
  // alocação dividida, vínculo e modo
  const model = await loadModel(b, { focusMonth: '2026-03', today: '2026-03-31' });
  assertEqual(model.allocations.byTransaction.get(t.aluguel).mode, 'manual');
  assertEqual(model.allocations.byTransaction.get(t.aluguel).parts.reduce((s, p) => s + p.amount, 0), 100000);
  assertEqual(model.receipts.linkOf.get(t.salario).cycleId, `${t.a.id}@2026-03-15`);
  assertEqual(model.mode, 'proximo');
  assertEqual((await b.getAll('budgets')).length, 2);
  await dispose(a); await dispose(b);
});

test('restaurar com dados existentes (substituir): o que existia é apagado e o backup entra', async () => {
  const a = await newDb();
  await populate(a);
  const { backup } = await parsed(a);
  const b = await newDb();
  const extra = await addTx(b, 'TRANSAÇÃO SÓ DO BANCO B', -999, '2026-02-01');
  await createBudget(b, { categoryId: 'moradia', limit: 5000 });
  await createSource(b, { name: 'Renda do B', frequency: 'semanal', weekday: 1, amount: 1000 });
  const plan = await planRestore(b, backup, 'replace');
  assert(plan.summary.removed.transactions === 1 && plan.summary.added.transactions === 8, 'o resumo diz o que será trocado');
  await restoreBackup(b, backup, { mode: 'replace', confirmed: true, plan });
  assertEqual(await b.get('transactions', extra) === undefined || (await b.get('transactions', extra)).originalDescription !== 'TRANSAÇÃO SÓ DO BANCO B', true, 'a transação antiga sumiu:');
  assertEqual((await b.getAll('budgets')).some((x) => x.categoryId === 'moradia'), false);
  assertEqual((await b.getAll('incomes')).some((x) => x.name === 'Renda do B'), false);
  assertEqual(await dump(b), await dump(a), 'banco igual ao do backup:');
  await dispose(a); await dispose(b);
});

test('mesclar: sem duplicar, refazendo ids, ciclos e regras; mesclar de novo não muda nada', async () => {
  const a = await newDb();
  const t = await populate(a);
  const { backup } = await parsed(a);

  const b = await newDb();
  const aTxs = await a.getAll('transactions');
  const copy = (id, extra = {}) => { const s = aTxs.find((x) => x.id === id); const { id: _i, ...rest } = s; return b.add('transactions', { ...rest, manual: undefined, categoryId: null, status: 'pendente', ...extra }); };
  const bIfood = await copy(t.ifood);                          // já existe no B (mesma impressão digital)
  const bBazar = await copy(t.bazar);                      // existe no B, mas NÃO corrigida
  const bLoja = await copy(t.loja, { manual: true, categoryId: 'compras', status: 'classificada', categorySource: 'manual' }); // existe no B e JÁ corrigida
  await addTx(b, 'COMPRA SÓ DO B', -777, '2026-03-09');
  await createSource(b, { name: 'Outra renda', frequency: 'mensal', day: 5, amount: 50000 }); // ocupa o id 1: força refazer ids

  const beforeCount = await b.count('transactions');
  const plan = await planRestore(b, backup, 'merge');
  assertEqual(plan.summary.skipped.transactions, 3, 'as 3 repetidas não são duplicadas:');
  assertEqual(plan.summary.added.transactions, 5);
  assertEqual(plan.summary.updatedManual, 1, 'a correção manual da bazar é trazida:');
  assertEqual((await b.count('transactions')), beforeCount, 'planejar não grava:');
  await restoreBackup(b, backup, { mode: 'merge', confirmed: true, plan });

  const all = await b.getAll('transactions');
  assertEqual(all.length, beforeCount + 5);
  assertEqual(new Set(all.map((x) => x.fingerprint)).size, all.length, 'nenhuma impressão digital repetida:');
  assertEqual(all.filter((x) => x.originalDescription === 'COMPRA IFOOD *PIZZA').length, 1, 'iFood não duplicou:');
  assertEqual((await b.get('transactions', bIfood)).amount, -4590, 'valores originais intactos:');
  const bazar = await b.get('transactions', bBazar);
  assertEqual(bazar.manual, true);
  assertEqual(bazar.categoryId, 'alimentacao', 'correção manual do backup trazida para a existente:');
  assertEqual(bazar.amount, -1500);
  assertEqual((await b.get('transactions', bLoja)).categoryId, 'compras', 'correção manual atual vence a do backup:');

  const rules = await listRules(b);
  const ruleZe = rules.find((r) => r.origem === 'usuario' && r.pattern === 'bazar do ze');
  assert(ruleZe, 'regra do usuário trazida');
  assertEqual(rules.filter((r) => r.origem === 'inicial' && r.pattern === 'ifood').length, 1, 'regras iniciais não duplicaram:');
  const bazar2 = all.find((x) => x.originalDescription === 'COMPRA BAZAR DO ZE' && x.id !== bBazar);
  assertEqual(bazar2.ruleId, ruleZe.id, 'ruleId refeito para o id novo da regra:');

  const incomes = await b.getAll('incomes');
  assertEqual(incomes.length, 3, 'Outra renda + 2 do backup:');
  const novaAdiant = incomes.find((x) => x.name === 'Adiantamento');
  assert(novaAdiant.id !== t.a.id, 'o id mudou (o 1 já estava ocupado)');
  const aluguel = all.find((x) => x.originalDescription === 'ALUGUEL MARCO');
  const model = await loadModel(b, { focusMonth: '2026-03', today: '2026-03-31' });
  const alloc = model.allocations.byTransaction.get(aluguel.id);
  assertEqual(alloc.mode, 'manual', 'alocação dividida refeita:');
  assertEqual(alloc.parts.reduce((s, p) => s + p.amount, 0), 100000);
  assert(alloc.parts.every((p) => model.cycles.some((c) => c.id === p.cycleId)), 'os ciclos existem com os ids novos');
  assert(alloc.parts.some((p) => p.cycleId.startsWith(`${novaAdiant.id}@`)));
  assertEqual(model.pending.some((p) => p.tx.id === aluguel.id), false, 'não virou pendência:');
  const salario = all.find((x) => x.originalDescription === 'SALARIO EMPRESA');
  assertEqual(model.receipts.linkOf.get(salario.id).cycleId, `${novaAdiant.id}@2026-03-15`, 'vínculo refeito:');
  assertEqual(model.mode, 'auto', 'mesclar não troca o modo de alocação atual:');
  assertEqual((await b.getAll('budgets')).length, 2, 'orçamentos trazidos');

  const snapshot = await dump(b);
  const again = await restoreBackup(b, backup, { mode: 'merge', confirmed: true });
  assert(Object.values(again.added).every((n) => n === 0), 'segunda mesclagem não acrescenta nada: ' + JSON.stringify(again.added));
  assertEqual(await dump(b), snapshot, 'banco idêntico após mesclar de novo:');
  await dispose(a); await dispose(b);
});

test('mesclar em banco recém-criado traz tudo; correção manual existente nunca é rebaixada', async () => {
  const a = await newDb();
  const t = await populate(a);
  const { backup } = await parsed(a);
  const b = await newDb(); // já tem as categorias e regras iniciais
  const s = await restoreBackup(b, backup, { mode: 'merge', confirmed: true });
  assertEqual(s.added.transactions, 8);
  assertEqual(s.skipped.categories, 18, 'categorias iniciais já existiam:');
  assertEqual(s.added.categories, 0);
  const sum = (d) => d.summary;
  const da = await loadDashboard(a, { preset: 'ultimo_com_dados', custom: {}, today: '2026-03-31' });
  const db2 = await loadDashboard(b, { preset: 'ultimo_com_dados', custom: {}, today: '2026-03-31' });
  assertEqual(JSON.stringify(sum(db2)), JSON.stringify(sum(da)), 'mesmos indicadores:');
  // backup SEM correção manual não rebaixa a correção manual do banco atual
  const clean = JSON.parse(JSON.stringify(backup));
  clean.data.transactions.forEach((x) => { delete x.manual; x.categoryId = 'outros'; });
  const loja = (await b.getAll('transactions')).find((x) => x.originalDescription === 'LOJA XPTO');
  assertEqual(loja.categoryId, 'saude');
  await restoreBackup(b, clean, { mode: 'merge', confirmed: true });
  assertEqual((await b.get('transactions', loja.id)).categoryId, 'saude', 'continua a correção manual:');
  assertEqual(t.loja > 0, true);
  await dispose(a); await dispose(b);
});

// ============================================================ segurança da restauração
test('restauração exige confirmação explícita e modo válido; planejar nunca grava', async () => {
  const a = await newDb();
  await populate(a);
  const { backup } = await parsed(a);
  const b = await newDb();
  await addTx(b, 'DADO ATUAL', -100, '2026-01-01');
  const before = await dump(b);
  assert(await failsWith(() => restoreBackup(b, backup, { mode: 'replace' }), /confirmação explícita/), 'sem confirmed');
  assert(await failsWith(() => restoreBackup(b, backup, { mode: 'replace', confirmed: 'sim' }), /confirmação explícita/), 'confirmed precisa ser true');
  assert(await failsWith(() => restoreBackup(b, backup, { mode: 'merge', confirmed: false }), /confirmação/));
  assert(await failsWith(() => restoreBackup(b, backup, { mode: 'inventado', confirmed: true }), /substituir ou mesclar/));
  await planRestore(b, backup, 'replace');
  await planRestore(b, backup, 'merge');
  assertEqual(await dump(b), before, 'nada foi alterado sem confirmação:');
  await dispose(a); await dispose(b);
});

test('falha durante a restauração: o banco volta exatamente ao que era (substituir e mesclar)', async () => {
  const a = await newDb();
  await populate(a);
  const { backup } = await parsed(a);
  const b = await newDb();
  await addTx(b, 'NÃO PODE SUMIR', -4321, '2026-02-02');
  await createBudget(b, { categoryId: 'moradia', limit: 1234 });
  const before = await dump(b);

  // falha REAL do banco: registro de categoria sem a chave "id" (a tabela já tinha sido limpa na mesma transação)
  const planReplace = await planRestore(b, backup, 'replace');
  planReplace.writes.categories.push({ nome: 'sem id' });
  assert(await failsWith(() => applyPlan(b, planReplace)), 'a gravação falha');
  assertEqual(await dump(b), before, 'substituir: nada foi apagado nem gravado pela metade:');

  const planMerge = await planRestore(b, backup, 'merge');
  planMerge.writes.categories.push({ nome: 'sem id' });
  assert(await failsWith(() => applyPlan(b, planMerge)));
  assertEqual(await dump(b), before, 'mesclar: nenhuma transação nova ficou gravada:');

  // falha simulada no fim das gravações (depois de limpar e gravar tudo)
  const planHook = await planRestore(b, backup, 'replace');
  planHook.hooks = { afterWrites() { throw new Error('falha simulada'); } };
  assert(await failsWith(() => applyPlan(b, planHook), /falha simulada/));
  assertEqual(await dump(b), before, 'substituir com falha no final: tudo desfeito:');
  assertEqual((await b.getAll('transactions')).length, 1);

  // e depois de tudo isso, uma restauração boa continua funcionando
  await restoreBackup(b, backup, { mode: 'replace', confirmed: true });
  assertEqual((await b.getAll('transactions')).length, 8);
  await dispose(a); await dispose(b);
});

// ============================================================ muitos registros
test('desempenho com 5.000 transações: exportar, validar, restaurar, painel e assistente', async () => {
  const db = await newDb();
  const cats = ['alimentacao', 'transporte', 'compras', 'moradia', 'saude', 'outros'];
  const rows = [];
  for (let i = 0; i < 5000; i++) {
    const month = 1 + (i % 12);
    const day = 1 + (i % 28);
    const income = i % 25 === 0;
    rows.push({
      date: `2025-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, amount: income ? 300000 : -(500 + (i * 37) % 20000),
      type: income ? 'pix_recebido' : 'compra', originalDescription: `ESTABELECIMENTO ${i % 150}`, normalizedName: `estabelecimento ${i % 150}`, merchantName: `estabelecimento ${i % 150}`,
      categoryId: income ? null : cats[i % cats.length], status: i % 17 === 0 ? 'pendente' : 'classificada', fingerprint: `perf-${i}`, importId: 'imp-perf',
    });
  }
  await db.bulkPut('transactions', rows);
  await createBudget(db, { categoryId: 'alimentacao', limit: 100000 });
  await createSource(db, { name: 'Salário', frequency: 'mensal', day: 5, amount: 300000 });
  const t = {};
  const time = async (name, fn) => { const s = performance.now(); const r = await fn(); t[name] = Math.round(performance.now() - s); return r; };

  const backup = await time('exportar', () => buildBackup(db));
  const text = await time('serializar', async () => serializeBackup(backup));
  const parsedResult = await time('validar', async () => parseBackupText(text));
  assertEqual(parsedResult.ok, true, (parsedResult.errors || []).join('; '));
  const b = await newDb({ seed: false });
  await time('restaurar (substituir)', () => restoreBackup(b, parsedResult.backup, { mode: 'replace', confirmed: true }));
  assertEqual(await b.count('transactions'), 5000);
  const m = await newDb();
  const merged = await time('restaurar (mesclar)', () => restoreBackup(m, parsedResult.backup, { mode: 'merge', confirmed: true }));
  assertEqual(merged.added.transactions, 5000);
  const again = await time('mesclar de novo (sem duplicar)', () => restoreBackup(m, parsedResult.backup, { mode: 'merge', confirmed: true }));
  assertEqual(again.added.transactions, 0);
  assertEqual(await m.count('transactions'), 5000);
  const dash = await time('painel (ano)', () => loadDashboard(db, { preset: 'ano_atual', custom: {}, today: '2025-12-31' }));
  assert(dash.summary.income > 0 && dash.byCategory.length > 0);
  const reply = await time('assistente (resumo)', () => ask('Quanto recebi e gastei em março de 2025?', { db, today: '2025-12-31' }));
  assert(reply.paragraphs[0].includes('R$'), reply.paragraphs[0]);
  await time('assistente (maior despesa)', () => ask('Qual foi minha maior despesa nos últimos 90 dias?', { db, today: '2025-12-31' }));
  window.__perf = { ...t, tamanhoDoArquivoKB: Math.round(text.length / 1024) };
  console.log('Desempenho (5.000 transações):', JSON.stringify(window.__perf));
  for (const [name, ms] of Object.entries(t)) assert(ms < 10000, `${name} levou ${ms} ms`);
  await dispose(db); await dispose(b); await dispose(m);
});
