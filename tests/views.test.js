import { test, assert, assertEqual } from './runner.js';
import { Database, deleteDatabase } from '../js/db.js';
import { seedDefaults } from '../js/seed.js';
import { normalizeText } from '../js/utils/format.js';
import * as inicio from '../js/ui/inicio.js';
import * as dashboard from '../js/ui/dashboard.js';
import * as importar from '../js/ui/importar.js';
import * as transacoes from '../js/ui/transacoes.js';
import * as orcamento from '../js/ui/orcamento.js';
import * as ciclos from '../js/ui/ciclos.js';
import * as assistente from '../js/ui/assistente.js';
import * as configuracoes from '../js/ui/configuracoes.js';
import { recategorize, setCategory } from '../js/categorization/transactionService.js';
import { createBudget } from '../js/budget/budgetService.js';
import { createSource } from '../js/cycles/incomeService.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let counter = 0;

async function newDb() {
  const name = `mfa-test-views-${Date.now()}-${counter++}`;
  const db = await new Database(name).open();
  await seedDefaults(db, '../data/');
  db._testName = name;
  return db;
}
async function withData(db) {
  const add = (desc, amount, date, extra = {}) => db.add('transactions', {
    date, amount, type: amount > 0 ? 'pix_recebido' : 'compra', originalDescription: desc, normalizedName: normalizeText(desc),
    categoryId: null, status: 'pendente', fingerprint: `v${counter++}`, importId: 'i', ...extra,
  });
  await add('SALARIO EMPRESA', 300000, '2026-03-05');
  const loja = await add('LOJA XPTO', -8000, '2026-03-07');
  await add('COMPRA IFOOD *PIZZA', -4590, '2026-03-03');
  await add('UBER *TRIP', -2350, '2026-02-04');
  await add('PAGAMENTO 99 APP', -1870, '2026-03-10');
  await recategorize(db);
  await setCategory(db, [loja], 'saude');
  await createBudget(db, { categoryId: 'alimentacao', limit: 60000 });
  await createSource(db, { name: 'Salário', frequency: 'mensal', day: 5, amount: 300000 });
  await db.add('imports', { id: 'i', importedAt: '2026-03-20T10:00:00.000Z', fileName: 'extrato.pdf', parserId: 'generico', savedCount: 5, skippedDuplicates: 0 });
}

const ROUTES = [
  ['Início', inicio, ''], ['Painel', dashboard, ''], ['Importar', importar, ''],
  ['Transações', transacoes, ''], ['Transações › Revisão', transacoes, 'revisao'], ['Transações › Regras', transacoes, 'regras'], ['Transações › Categorias', transacoes, 'categorias'],
  ['Orçamento', orcamento, ''], ['Ciclos', ciclos, ''], ['Ciclos › Rendas', ciclos, 'rendas'], ['Ciclos › Pendências', ciclos, 'pendencias'],
  ['Assistente', assistente, ''], ['Configurações', configuracoes, ''],
];

async function renderRoute(module, db, sub) {
  const container = document.createElement('div');
  container.className = 'test-view';
  document.body.appendChild(container);
  await module.render(container, { db, sub });
  await sleep(700); // algumas telas terminam de carregar depois de render()
  return container;
}

const hasName = (el) => Boolean(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.title || (el.labels && el.labels.length));

/** Auditoria automática de acessibilidade básica (não substitui teste com leitor de tela). */
export function auditAccessibility(root) {
  const problems = [];
  for (const el of root.querySelectorAll('input, select, textarea')) {
    if (el.type === 'hidden') continue;
    if (!hasName(el)) problems.push(`campo sem rótulo: <${el.tagName.toLowerCase()} ${el.id || el.name || el.className}>`);
  }
  for (const el of root.querySelectorAll('button')) {
    if (!el.textContent.trim() && !el.getAttribute('aria-label') && !el.title) problems.push(`botão sem nome: ${el.className}`);
  }
  for (const el of root.querySelectorAll('a')) {
    if (!el.textContent.trim() && !el.getAttribute('aria-label')) problems.push(`link sem nome: ${el.getAttribute('href')}`);
  }
  const h1 = root.querySelectorAll('h1');
  if (h1.length !== 1) problems.push(`esperava 1 título h1, encontrou ${h1.length}`);
  let last = 0;
  for (const h of root.querySelectorAll('h1, h2, h3, h4')) {
    const level = Number(h.tagName[1]);
    if (last && level > last + 1) problems.push(`título pulou de h${last} para h${level}: "${h.textContent.trim().slice(0, 30)}"`);
    last = level;
  }
  const ids = [...root.querySelectorAll('[id]')].map((e) => e.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) problems.push(`ids repetidos: ${[...new Set(dup)].join(', ')}`);
  for (const c of root.querySelectorAll('canvas')) {
    if (c.getAttribute('role') !== 'img' || !c.getAttribute('aria-label')) problems.push('gráfico (canvas) sem role="img" e aria-label');
  }
  for (const t of root.querySelectorAll('table')) if (!t.querySelector('th')) problems.push('tabela sem células de cabeçalho (th)');
  for (const d of root.querySelectorAll('details')) if (!d.querySelector('summary')) problems.push('details sem summary');
  for (const e of root.querySelectorAll('[role="tab"], [role="tablist"]')) problems.push(`papel ARIA incompleto: ${e.getAttribute('role')}`);
  return problems;
}

const OUTDATED = /Etapa \d|próxima etapa|em construção|será construída|em breve/i;

test('as áreas do app funcionam com dados reais: sem erro, sem texto de etapas futuras e com acessibilidade básica', async () => {
  const db = await newDb();
  await withData(db);
  const report = [];
  for (const [name, module, sub] of ROUTES) {
    const view = await renderRoute(module, db, sub);
    try {
      assert(view.querySelector('h1')?.textContent.trim(), `${name}: sem título`);
      assertEqual(view.querySelectorAll('.card.error').length, 0, `${name}: mostrou erro: ${view.querySelector('.card.error')?.textContent}`);
      assert(!OUTDATED.test(view.textContent), `${name}: texto desatualizado: ${view.textContent.match(OUTDATED)?.[0]}`);
      assert(!view.querySelector('.loading'), `${name}: ficou em "Carregando…"`);
      for (const p of auditAccessibility(view)) report.push(`${name}: ${p}`);
    } finally { view.remove(); }
  }
  assertEqual(report.join('\n'), '', 'problemas de acessibilidade encontrados');
  db.close(); await deleteDatabase(db._testName);
});

test('Tela inicial: explica o site, tem botões para começar e passa na auditoria de acessibilidade', async () => {
  const db = await newDb();
  const view = await renderRoute(inicio, db, '');
  try {
    assertEqual(view.querySelectorAll('h1').length, 1, 'um título principal:');
    const headings = [...view.querySelectorAll('h2')].map((h) => h.textContent.trim());
    for (const h of ['Como funciona', 'O que você encontra aqui', 'Seus dados ficam só com você']) assert(headings.includes(h), `faltou a seção "${h}"`);
    assertEqual(view.querySelectorAll('.step').length, 3, 'três passos:');
    assertEqual(view.querySelectorAll('.feature').length, 6, 'seis recursos:');
    assert(view.querySelectorAll('a[href="#/importar"]').length >= 2, 'botões "começar" levam à importação');
    assert(view.querySelectorAll('[data-act="sample"]').length >= 2, 'botões do extrato de exemplo');
    assert(!view.textContent.includes('Abrir meu painel'), 'sem dados, não mostra "Abrir meu painel"');
    assertEqual(auditAccessibility(view).join('\n'), '', 'acessibilidade:');
  } finally { view.remove(); }
  await withData(db); // com dados, aparece o atalho para o painel
  const again = await renderRoute(inicio, db, '');
  try { assert(again.textContent.includes('Abrir meu painel'), 'com dados mostra "Abrir meu painel"'); } finally { again.remove(); }
  db.close(); await deleteDatabase(db._testName);
});

test('Importar: o extrato de exemplo vem junto com o site e o botão aparece na tela de envio', async () => {
  const file = await importar.fetchSampleFile('../samples/extrato-exemplo-modelo-a.pdf');
  assertEqual(file.type, 'application/pdf');
  assert(file.size > 500, 'arquivo de exemplo carregado');
  let erro = null;
  try { await importar.fetchSampleFile('../samples/nao-existe.pdf'); } catch (e) { erro = e; }
  assert(erro && /não foi encontrado/.test(erro.message), 'erro claro quando o arquivo não existe');
  const db = await newDb();
  const view = await renderRoute(importar, db, '');
  try { assert(view.querySelector('#sample-btn'), 'botão "Usar extrato de exemplo"'); } finally { view.remove(); db.close(); await deleteDatabase(db._testName); }
});

/** Espera aparecer uma janela (<dialog>) que satisfaça a condição; devolve null se não aparecer em 3 s. */
async function waitForDialog(predicate = () => true) {
  const t0 = Date.now();
  for (;;) {
    const all = [...document.querySelectorAll('dialog.dialog')];
    const found = all.reverse().find(predicate);
    if (found) return found;
    if (Date.now() - t0 > 3000) return null;
    await sleep(30);
  }
}
const clearDialogs = () => document.querySelectorAll('dialog.dialog').forEach((d) => d.remove());

/** Preenche e envia a janela "Nova categoria" (ou cancela, se name for null) e espera ela fechar. */
async function answerNewCategoryDialog(name, color = '#336699') {
  const dialog = await waitForDialog();
  assert(dialog, 'a janela "Nova categoria" abriu');
  if (name === null) dialog.querySelector('button[value="cancel"]').click();
  else {
    dialog.querySelector('input[name="nome"]').value = name;
    dialog.querySelector('input[name="cor"]').value = color;
    dialog.querySelector('button[value="ok"]').click();
  }
  for (let i = 0; i < 100 && dialog.isConnected; i++) await sleep(30);
  assert(!dialog.isConnected, 'a janela fechou');
  return dialog;
}

test('Nova categoria direto da lista de Transações: cria, aplica à transação e valida nome repetido', async () => {
  clearDialogs();
  const db = await newDb();
  await withData(db);
  const view = await renderRoute(transacoes, db, '');
  try {
    const select = view.querySelector('.f-cat');
    assert([...select.options].some((o) => o.value === '__nova'), 'a lista tem a opção "+ Nova categoria…"');
    const txId = Number(select.closest('tr').dataset.id);

    // nome repetido: a janela reabre explicando; cancelar não muda nada
    select.value = '__nova'; select.dispatchEvent(new Event('change', { bubbles: true }));
    await answerNewCategoryDialog('alimentação');
    const again = await waitForDialog((d) => /Já existe uma categoria/.test(d.textContent));
    assert(again, 'explica que o nome já existe');
    await answerNewCategoryDialog(null);
    assertEqual(document.querySelectorAll('dialog.dialog').length, 0, 'janela fechada:');
    assertEqual((await db.getAll('categories')).length, 18, 'nada foi criado:');

    // criar de verdade: a categoria nasce e já é aplicada à transação
    const select2 = view.querySelector(`tr[data-id="${txId}"] .f-cat`);
    select2.value = '__nova'; select2.dispatchEvent(new Event('change', { bubbles: true }));
    await answerNewCategoryDialog('Viagens de trabalho', '#336699');
    await sleep(200);
    const created = (await db.getAll('categories')).find((c) => c.nome === 'Viagens de trabalho');
    assert(created && created.padrao === false && created.cor === '#336699', 'categoria criada com a cor escolhida');
    const tx = await db.get('transactions', txId);
    assertEqual(tx.categoryId, created.id, 'transação recebeu a nova categoria:');
    assertEqual(tx.manual, true, 'e fica protegida como correção sua:');
    assert(view.querySelector(`tr[data-id="${txId}"] .f-cat`).value === created.id, 'a lista mostra a nova categoria');
  } finally { view.remove(); db.close(); await deleteDatabase(db._testName); }
});

test('Nova categoria direto do Orçamento: cria e já deixa escolhida no formulário', async () => {
  clearDialogs();
  const db = await newDb();
  const view = await renderRoute(orcamento, db, '');
  try {
    const select = view.querySelector('#budget-form select[name="categoryId"]');
    assert([...select.options].some((o) => o.value === '__nova'), 'opção "+ Nova categoria…" no formulário');
    select.value = '__nova'; select.dispatchEvent(new Event('change', { bubbles: true }));
    await answerNewCategoryDialog('Presente da vovó');
    await sleep(250);
    const created = (await db.getAll('categories')).find((c) => c.nome === 'Presente da vovó');
    assert(created, 'categoria criada');
    assertEqual(view.querySelector('#budget-form select[name="categoryId"]').value, created.id, 'já vem escolhida:');
    assert(/criada/.test(view.querySelector('#msg').textContent), 'mensagem de confirmação');
  } finally { view.remove(); db.close(); await deleteDatabase(db._testName); }
});

test('Painel não mostra a seção "Ciclos de recebimento" (os ciclos ficam na aba Ciclos)', async () => {
  const db = await newDb();
  await withData(db);
  const view = await renderRoute(dashboard, db, '');
  try {
    const headings = [...view.querySelectorAll('h2')].map((h) => h.textContent.trim());
    assert(!headings.includes('Ciclos de recebimento'), 'seção de ciclos removida do Painel');
    assert(!view.textContent.includes('Disponível planejado'), 'sem a legenda confusa dos ciclos');
    assert(headings.includes('Próximos recebimentos'), 'próximos recebimentos continuam');
    assert(headings.includes('Insights do período'), 'insights continuam');
    // a aba Ciclos continua completa
    const ciclosView = await renderRoute(ciclos, db, '');
    try { assert(ciclosView.textContent.includes('Salário'), 'aba Ciclos continua mostrando os ciclos'); } finally { ciclosView.remove(); }
  } finally { view.remove(); db.close(); await deleteDatabase(db._testName); }
});

test('Revisão: filtro escondendo tudo não mostra "Nada para revisar"; o contador e a lista concordam', async () => {
  const db = await newDb();
  await withData(db);
  const pendentes = (await db.getAll('transactions')).filter((t) => t.status === 'pendente').length;
  assert(pendentes > 0, 'há pendências no cenário de teste');
  const view = await renderRoute(transacoes, db, 'revisao');
  try {
    assertEqual(view.querySelector('#review-count').textContent, String(pendentes), 'contador:');
    const rowsBefore = view.querySelectorAll('.tx-table tbody tr').length;
    assertEqual(rowsBefore, pendentes, 'a lista mostra todas as pendências sem filtro:');
    // escolhe uma categoria sem nenhuma pendência (ex.: Viagens): a lista fica vazia por causa do filtro
    const select = view.querySelector('#f-category');
    select.value = 'viagens';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(50);
    const text = view.querySelector('#list-area').textContent;
    assert(!/Nada para revisar/.test(text), 'não diz que não há nada para revisar:');
    assert(/Nenhuma pendência com estes filtros/.test(text), 'explica que é o filtro:');
    assert(text.includes(`${pendentes} transaç`), 'diz quantas pendências existem no total:');
    // "Limpar filtros" devolve a lista
    view.querySelector('[data-act="clear-filters"]').click();
    await sleep(50);
    assertEqual(view.querySelector('#f-category').value, 'todas', 'filtro voltou ao padrão:');
    assertEqual(view.querySelectorAll('.tx-table tbody tr').length, pendentes, 'pendências voltaram:');
  } finally { view.remove(); db.close(); await deleteDatabase(db._testName); }

  // sem pendências de verdade, a mensagem de parabéns continua valendo
  const db2 = await newDb();
  await db2.add('transactions', { date: '2026-03-01', amount: -1000, type: 'compra', originalDescription: 'IFOOD', normalizedName: 'ifood', categoryId: 'alimentacao', status: 'classificada', fingerprint: 'z1', importId: 'i' });
  const v2 = await renderRoute(transacoes, db2, 'revisao');
  try {
    assert(/Nada para revisar/.test(v2.querySelector('#list-area').textContent), 'sem pendências: "Nada para revisar"');
    assertEqual(v2.querySelector('#review-count').textContent, '0');
  } finally { v2.remove(); db2.close(); await deleteDatabase(db2._testName); }
});

test('as áreas do app mostram estados vazios claros num app sem dados', async () => {
  const db = await newDb();
  const expectations = {
    Painel: /Bem-vindo|Importar extrato/, Transações: /Nenhuma transação ainda/, 'Transações › Revisão': /Nenhuma transação ainda/,
    Orçamento: /Nenhum orçamento ainda/, Ciclos: /Cadastre sua primeira fonte de renda/, 'Ciclos › Pendências': /Nenhuma pendência de alocação/,
    'Ciclos › Rendas': /Nenhuma fonte cadastrada/, Configurações: /Você ainda não exportou nenhum backup/,
  };
  for (const [name, module, sub] of ROUTES) {
    const view = await renderRoute(module, db, sub);
    try {
      assertEqual(view.querySelectorAll('.card.error').length, 0, `${name}: erro`);
      assert(!OUTDATED.test(view.textContent), `${name}: texto desatualizado`);
      if (expectations[name]) assert(expectations[name].test(view.textContent), `${name}: esperava ${expectations[name]} em: ${view.textContent.slice(0, 160)}`);
      const problems = auditAccessibility(view);
      assertEqual(problems.join('; '), '', `${name}: acessibilidade`);
    } finally { view.remove(); }
  }
  db.close(); await deleteDatabase(db._testName);
});

test('o assistente responde dentro da tela (entrada, histórico e indicadores de modo)', async () => {
  const db = await newDb();
  await withData(db);
  const view = await renderRoute(assistente, db, '');
  try {
    assert(/Modo local · sem IA generativa/.test(view.querySelector('.mode-badge').textContent), 'faixa do modo local');
    const input = view.querySelector('#chat-input');
    input.value = 'Quanto gastei com alimentação em março?';
    view.querySelector('#chat-form').requestSubmit();
    await sleep(1200);
    const last = [...view.querySelectorAll('.msg.assistant')].pop();
    assert(/R\$ 45,90/.test(last.textContent) || /Alimentação/.test(last.textContent), last.textContent.slice(0, 120));
    assert(/modo local/i.test(last.querySelector('.msg-badge').textContent));
    assertEqual(view.querySelector('#chat-log').getAttribute('role'), 'log');
    assertEqual(view.querySelectorAll('.msg.user').length >= 1, true);
    view.querySelector('[data-act=clear]').click();
  } finally { view.remove(); }
  db.close(); await deleteDatabase(db._testName);
});
