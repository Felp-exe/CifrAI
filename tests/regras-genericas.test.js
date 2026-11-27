// Lista ampliada de palavras-chave (alimentação, transporte, saúde... até taxas e tarifas) e 6 categorias novas.
import { test, assert, assertEqual } from './runner.js';
import { Database, deleteDatabase } from '../js/db.js';
import { seedDefaults, syncInitialCategories, syncInitialRules } from '../js/seed.js';
import { categorize } from '../js/categorization/categorizer.js';
import { recategorize } from '../js/categorization/transactionService.js';
import { normalizeText } from '../js/utils/format.js';

let counter = 0;
async function freshDb() {
  const name = `mfa-test-genericas-${Date.now()}-${counter++}`;
  const db = await new Database(name).open();
  await seedDefaults(db, '../data/');
  db._testName = name;
  return db;
}
async function dispose(db) { db.close(); await deleteDatabase(db._testName); }

let cache = null;
async function load() {
  if (cache) return cache;
  const [cats, rules] = await Promise.all([
    fetch('../data/categories.json').then((r) => r.json()),
    fetch('../data/merchant-rules.json').then((r) => r.json()),
  ]);
  cache = { ids: new Set(cats.map((c) => c.id)), rules: rules.map((r, i) => ({ ...r, id: i + 1 })), cats };
  return cache;
}
async function classify(description, amount = -2500) {
  const { ids, rules } = await load();
  return categorize({ originalDescription: description, normalizedName: normalizeText(description), amount }, rules, ids);
}

const TABLE = {
  alimentacao: ['RAPPI*PEDIDO 123', 'Restaurante do Zé', 'LANCHONETE CENTRAL 45', 'HAMBURGUERIA BOA', 'PADARIA PÃO QUENTE', 'COMPRA MERCADO BAIRRO 12', 'SUPERMERCADO EXTRA', 'AÇOUGUE DO JOÃO', 'KEETA 123', 'IFD*IFOOD SAO PAULO', '99 FOOD', 'PIZZARIA BELLA'],
  transporte: ['TÁXI 123', 'METRÔ SP', 'ONIBUS SPTRANS', 'CPTM BILHETE', 'POSTO COMBUSTÍVEL 22', 'SHELL BOX 9', 'POSTO IPIRANGA', 'ESTACIONAMENTO SHOPPING', 'SEM PARAR RECARGA', 'UBER *TRIP', '99 POP', '99 NEGOCIA'],
  saude: ['FARMA POPULAR', 'FARMÁCIA SÃO JOÃO', 'DROGARIA TAL', 'DROGASIL 123', 'DROGA RAIA 55', 'PAGUE MENOS 55', 'WELLHUB', 'ACADEMIA SMART', 'CONSULTA DR SILVA', 'LABORATÓRIO FLEURY'],
  assinaturas: ['NETFLIX.COM', 'SPOTIFY AB', 'DISNEY+ ASSINATURA', 'HBO MAX', 'PRIME VIDEO', 'AMAZON PRIME VIDEO', 'YOUTUBE PREMIUM', 'TWITCH INTERACTIVE'],
  entretenimento: ['CINEMA CINEMARK', 'TEATRO MUNICIPAL', 'SHOW ROCK 2026', 'LIVE PIX', 'STEAM GAMES', 'PLAYSTATION STORE', 'XBOX GAME PASS', 'NINTENDO ESHOP', 'INGRESSO.COM'],
  moradia: ['ALUGUEL APTO 12', 'CONDOMÍNIO EDIFÍCIO SOL', 'IPTU 2026', 'SABESP', 'ENEL SP', 'COMGÁS', 'CONTA DE ÁGUA', 'CONTA DE LUZ', 'INTERNET RESIDENCIAL VIVO'],
  compras: ['SHOPEE', 'AMAZON BR', 'MERCADO LIVRE', 'SHEIN', 'ALIEXPRESS', 'LOJAS AMERICANAS', 'VESTUÁRIO XPTO', 'ROUPAS LTDA', 'CALÇADOS MARIA'],
  educacao: ['UDEMY', 'COURSERA', 'FACULDADE ABC', 'UNIVERSIDADE X', 'MENSALIDADE ESCOLA', 'CURSO DE INGLÊS', 'LIVROS DIDÁTICOS'],
  pets: ['PETZ', 'COBASI', 'VETERINÁRIO CENTRAL', 'PET SHOP AMIGO', 'RAÇÃO PREMIUM'],
  dizimo: ['IGREJA BATISTA', 'DÍZIMO', 'OFERTA', 'DOAÇÃO RELIGIOSA'],
  esporte: ['ATLÉTICA ESALQ', 'PIX FUPE 123', 'CAMPEONATO REGIONAL', 'TORNEIO DE VOLEI', 'ESPORTE CLUBE', 'ACADEMIA ESPORTIVA'],
  'cuidados-pessoais': ['SALÃO BELLA', 'BARBEARIA DO ZÉ', 'MANICURE', 'CABELEIREIRO', 'ESTÉTICA FACIAL'],
  servicos: ['CORREIOS', 'CARTÓRIO', 'DOCUMENTAÇÃO', 'TAXAS', 'SERVIÇOS ADMINISTRATIVOS'],
  'taxas-tarifas': ['JUROS', 'IOF', 'TARIFA BANCÁRIA', 'ANUIDADE', 'MULTA'],
};

test('regras novas: cada palavra da lista cai na categoria certa (maiúsculas, acentos e números não atrapalham)', async () => {
  const wrong = [];
  for (const [category, descriptions] of Object.entries(TABLE)) {
    for (const d of descriptions) {
      const r = await classify(d);
      if (r.categoryId !== category || r.status !== 'classificada') wrong.push(`${d} → ${r.categoryId}/${r.status} (esperado ${category})`);
    }
  }
  assertEqual(wrong.join(' | '), '', 'classificações erradas:');
});

test('regras novas: variações de escrita, números e textos adicionais', async () => {
  const same = async (variants, category) => {
    for (const v of variants) assertEqual((await classify(v)).categoryId, category, `"${v}":`);
  };
  await same(['supermercado', 'SUPERMERCADO', 'SuperMercado', 'COMPRA NO DEBITO 12345 SUPERMERCADO EXTRA 0987 SP', 'supermercado-extra*sp'], 'alimentacao');
  await same(['farmácia', 'FARMACIA', 'Farmácia Pague Menos 0045 SP'], 'saude');
  await same(['mensalidade', 'MENSALIDADE FACULDADE 03/05', 'curso'], 'educacao');
  await same(['Cinema', 'CINEMA 1234 SANTOS', 'cinéma'.replace('é', 'e')], 'entretenimento');
});

test('regras novas: não classificam por pedaço de palavra nem por engano', async () => {
  for (const d of ['RECURSO HUMANO LTDA', 'METROPOLITANO TRANSPORTES', 'TAXIDERMIA SILVA', 'MAXIMA LTDA', 'SHOWROOM MODA', 'IGREJINHA DO BAIRRO', 'IOFFICE', 'DISNEYLANDIA', 'PETZZ']) {
    const r = await classify(d);
    assertEqual(r.status, 'pendente', `"${d}" deve ficar pendente:`);
    assertEqual(r.categoryId, 'outros', `"${d}" cai em Outros (revisão):`);
  }
});

test('em caso de dúvida a transação fica pendente: "99" sozinho, Mercado Pago e desconhecidos', async () => {
  for (const d of ['99', 'PAGAMENTO 99 APP', 'MERCADO PAGO', 'MERCADO PAGO *LOJA 123', 'ESTABELECIMENTO DESCONHECIDO XYZ']) {
    const r = await classify(d);
    assertEqual(r.status, 'pendente', `"${d}":`);
    assert(r.categoryId === null || r.categoryId === 'outros', `"${d}" sem categoria definida:`);
  }
  assertEqual((await classify('99')).categoryId, null);
  assertEqual((await classify('MERCADO PAGO')).categoryId, null, 'Mercado Pago não vira supermercado:');
  assertEqual((await classify('MERCADO LIVRE')).categoryId, 'compras', 'Mercado Livre continua em Compras:');
});

test('prioridade: o termo mais específico vence ("academia esportiva", "prime video", "mercado livre")', async () => {
  assertEqual((await classify('ACADEMIA')).categoryId, 'saude');
  assertEqual((await classify('ACADEMIA ESPORTIVA ESALQ')).categoryId, 'esporte');
  assertEqual((await classify('AMAZON')).categoryId, 'compras');
  assertEqual((await classify('AMAZON PRIME VIDEO')).categoryId, 'assinaturas');
  assertEqual((await classify('MERCADO LIVRE')).categoryId, 'compras');
  assertEqual((await classify('MERCADO CENTRAL')).categoryId, 'alimentacao');
});

test('categorias: 6 novas existem e são iniciais; todas as regras novas apontam para categorias que existem', async () => {
  const { cats, rules, ids } = await load();
  assertEqual(cats.length, 18, 'total de categorias:');
  for (const id of ['pets', 'cuidados-pessoais', 'servicos', 'taxas-tarifas', 'presentes', 'viagens']) {
    const c = cats.find((x) => x.id === id);
    assert(c && c.padrao === true && c.nome && c.cor, `categoria ${id}`);
  }
  assertEqual(cats.find((c) => c.id === 'cuidados-pessoais').nome, 'Cuidados pessoais');
  assertEqual(cats.find((c) => c.id === 'taxas-tarifas').nome, 'Taxas e tarifas');
  const orphan = rules.filter((r) => r.categoryId !== null && !ids.has(r.categoryId));
  assertEqual(orphan.length, 0, 'regras sem categoria:');
  const keys = rules.map((r) => `${r.pattern}|${r.matchType}`);
  assertEqual(new Set(keys).size, keys.length, 'sem regras repetidas:');
});

test('banco antigo: categorias e regras novas chegam, a classificação é corrigida e correções manuais ficam', async () => {
  const db = await freshDb();
  // simula um banco da versão anterior: sem as 6 categorias e só com as 23 primeiras regras
  for (const id of ['pets', 'cuidados-pessoais', 'servicos', 'taxas-tarifas', 'presentes', 'viagens']) await db.delete('categories', id);
  for (const r of await db.getAll('rules')) if (r.id > 23) await db.delete('rules', r.id);
  const base = { type: 'compra', fingerprint: 'f', importId: 'i', status: 'pendente', categoryId: 'outros', suggestedCategoryId: 'outros', categorySource: 'desconhecido' };
  const a = await db.add('transactions', { ...base, date: '2026-03-02', amount: -5000, originalDescription: 'SUPERMERCADO EXTRA', normalizedName: 'supermercado extra', fingerprint: 'a' });
  const b = await db.add('transactions', { ...base, date: '2026-03-03', amount: -3000, originalDescription: 'PETZ LOJA 12', normalizedName: 'petz loja 12', fingerprint: 'b' });
  const manual = await db.add('transactions', { ...base, date: '2026-03-04', amount: -2000, originalDescription: 'RESTAURANTE DO ZE', normalizedName: 'restaurante do ze', fingerprint: 'c', manual: true, categoryId: 'compras', status: 'classificada', categorySource: 'manual' });

  const cats = await syncInitialCategories(db, '../data/');
  assertEqual(cats.added, 6, 'categorias criadas:');
  const rules = await syncInitialRules(db, '../data/');
  assert(rules >= 80, `regras acrescentadas (${rules})`);
  const changed = await recategorize(db);
  assertEqual(changed, 2, 'transações reclassificadas:');
  assertEqual((await db.get('transactions', a)).categoryId, 'alimentacao');
  assertEqual((await db.get('transactions', b)).categoryId, 'pets');
  assertEqual((await db.get('transactions', manual)).categoryId, 'compras', 'correção manual preservada:');
  assertEqual((await db.get('transactions', manual)).manual, true);
  assertEqual((await db.getAll('categories')).length, 18);
  assertEqual(await syncInitialRules(db, '../data/'), 0, 'rodar de novo não duplica:');
  await dispose(db);
});
