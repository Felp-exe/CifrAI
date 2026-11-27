import { test, assert, assertEqual } from './runner.js';
import { Database, deleteDatabase } from '../js/db.js';
import { seedDefaults } from '../js/seed.js';
import { normalizeText } from '../js/utils/format.js';
import { isValidISO, clampDay, daysInMonth, shiftMonth, addDays, weekdayOf } from '../js/utils/dates.js';
import { occurrences, validateSource } from '../js/cycles/incomeSchedule.js';
import { buildCycles, autoCycleFor, computeAllocations, validateManualParts, cycleId } from '../js/cycles/allocation.js';
import { matchReceipts } from '../js/cycles/receipts.js';
import { buildModel, loadModel } from '../js/cycles/model.js';
import {
  createSource, updateSource, deleteSource, deleteImpact, setSourceActive, listSources,
} from '../js/cycles/incomeService.js';
import {
  saveManualAllocation, clearManualAllocation, linkReceipt, clearReceiptLink, setMode, getMode,
} from '../js/cycles/allocationService.js';

let counter = 0;
async function freshDb() {
  const name = `mfa-test-cyc-${Date.now()}-${counter++}`;
  const db = await new Database(name).open();
  await seedDefaults(db, '../data/');
  db._testName = name;
  return db;
}
async function dispose(db) { db.close(); await deleteDatabase(db._testName); }

async function addTx(db, description, amount, date, extra = {}) {
  return db.add('transactions', {
    date, amount, type: amount > 0 ? 'entrada' : 'compra', originalDescription: description,
    normalizedName: normalizeText(description), categoryId: null, status: 'pendente',
    fingerprint: `c${counter++}`, importId: 'teste', ...extra,
  });
}
const mensal = (name, day, amountReais, extra = {}) => ({ name, frequency: 'mensal', day, amount: amountReais * 100, ...extra });
const sumOf = (parts) => parts.reduce((s, p) => s + p.amount, 0);

// ------------------------------------------------------------ datas
test('datas: calendário real, fim de mês e deslocamento de meses', () => {
  assert(isValidISO('2026-02-28') && !isValidISO('2026-02-30') && !isValidISO('2026-13-01') && !isValidISO('lixo'));
  assertEqual(daysInMonth(2026, 2), 28);
  assertEqual(daysInMonth(2028, 2), 29, 'bissexto:');
  assertEqual(clampDay(2026, 2, 30), 28);
  assertEqual(clampDay(2026, 4, 31), 30);
  assertEqual(clampDay(2026, 3, 30), 30);
  assertEqual(shiftMonth('2026-01', -1), '2025-12');
  assertEqual(shiftMonth('2026-12', 1), '2027-01');
  assertEqual(addDays('2026-02-28', 1), '2026-03-01');
  assertEqual(weekdayOf('2026-03-06'), 5, 'sexta-feira:');
});

// ------------------------------------------------------------ frequências
test('renda mensal: dias 15, 20 e 30 e qualquer outro dia', () => {
  const range = ['2026-03-01', '2026-03-31'];
  assertEqual(occurrences(validateSource(mensal('A', 15, 1500)), ...range).join(), '2026-03-15');
  assertEqual(occurrences(validateSource(mensal('B', 20, 1000)), ...range).join(), '2026-03-20');
  assertEqual(occurrences(validateSource(mensal('C', 30, 2000)), ...range).join(), '2026-03-30');
  assertEqual(occurrences(validateSource(mensal('D', 7, 100)), ...range).join(), '2026-03-07', 'dia livre:');
});

test('renda no dia 30 em fevereiro usa o último dia do mês (28 e 29)', () => {
  const s = validateSource(mensal('Salário', 30, 2000));
  assertEqual(occurrences(s, '2026-02-01', '2026-02-28').join(), '2026-02-28');
  assertEqual(occurrences(s, '2028-02-01', '2028-02-29').join(), '2028-02-29', 'ano bissexto:');
  assertEqual(occurrences(validateSource(mensal('X', 31, 1)), '2026-04-01', '2026-04-30').join(), '2026-04-30');
  assertEqual(occurrences(s, '2026-01-01', '2026-03-31').join(), '2026-01-30,2026-02-28,2026-03-30');
});

test('renda quinzenal: duas vezes por mês, respeitando o fim do mês', () => {
  const q = (day) => validateSource({ name: 'Q', frequency: 'quinzenal', day, amount: 100 });
  assertEqual(occurrences(q(15), '2026-03-01', '2026-03-31').join(), '2026-03-15,2026-03-30');
  assertEqual(occurrences(q(15), '2026-02-01', '2026-02-28').join(), '2026-02-15,2026-02-28', 'fevereiro:');
  assertEqual(occurrences(q(5), '2026-03-01', '2026-03-31').join(), '2026-03-05,2026-03-20');
  assertEqual(occurrences(q(20), '2026-03-01', '2026-03-31').join(), '2026-03-05,2026-03-20');
});

test('renda semanal e única', () => {
  const sem = validateSource({ name: 'Bico', frequency: 'semanal', weekday: 5, amount: 100 });
  assertEqual(occurrences(sem, '2026-03-01', '2026-03-31').join(), '2026-03-06,2026-03-13,2026-03-20,2026-03-27');
  const unica = validateSource({ name: '13º', frequency: 'unica', date: '2026-12-20', amount: 100 });
  assertEqual(occurrences(unica, '2026-12-01', '2026-12-31').join(), '2026-12-20');
  assertEqual(occurrences(unica, '2026-11-01', '2026-11-30').length, 0);
  assertEqual(occurrences(unica, '2027-01-01', '2027-12-31').length, 0, 'única não se repete:');
});

test('renda: período de validade (a partir de / até)', () => {
  const s = validateSource({ ...mensal('Temp', 10, 100), startDate: '2026-02-01', endDate: '2026-04-30' });
  assertEqual(occurrences(s, '2026-01-01', '2026-06-30').join(), '2026-02-10,2026-03-10,2026-04-10');
});

test('renda: validação de campos', () => {
  const bad = (input) => { try { validateSource(input); return false; } catch { return true; } };
  assert(bad({ ...mensal('', 15, 1) }), 'sem nome');
  assert(bad({ name: 'X', frequency: 'mensal', day: 15, amount: 0 }), 'valor zero');
  assert(bad({ name: 'X', frequency: 'mensal', day: 32, amount: 100 }), 'dia 32');
  assert(bad({ name: 'X', frequency: 'mensal', day: 0, amount: 100 }), 'dia 0');
  assert(bad({ name: 'X', frequency: 'semanal', weekday: 9, amount: 100 }), 'dia da semana 9');
  assert(bad({ name: 'X', frequency: 'unica', date: '2026-02-30', amount: 100 }), 'data inexistente');
  assert(bad({ name: 'X', frequency: 'diaria', amount: 100 }), 'frequência desconhecida');
  assert(bad({ ...mensal('X', 5, 1), startDate: '2026-05-01', endDate: '2026-04-01' }), 'início depois do fim');
});

// ------------------------------------------------------------ ciclos e alocação automática
const SOURCES = [
  { id: 1, name: 'Adiantamento', frequency: 'mensal', day: 15, amount: 150000 },
  { id: 2, name: 'Extra', frequency: 'mensal', day: 20, amount: 100000 },
  { id: 3, name: 'Salário', frequency: 'mensal', day: 30, amount: 200000 },
];

test('ciclos sobrepostos: três recebimentos no mesmo mês (15, 20 e 30)', () => {
  const cycles = buildCycles(SOURCES, '2026-03-01', '2026-03-31');
  assertEqual(cycles.map((c) => c.id).join(), '1@2026-03-15,2@2026-03-20,3@2026-03-30');
  assertEqual(cycleId(3, '2026-02-28'), '3@2026-02-28');
  const fev = buildCycles(SOURCES, '2026-02-01', '2026-02-28');
  assertEqual(fev[fev.length - 1].date, '2026-02-28', 'dia 30 virou 28 em fevereiro:');
});

test('automático por data: recebimento mais recente até a data (inclusive o mesmo dia)', () => {
  const cycles = buildCycles(SOURCES, '2026-02-01', '2026-04-30');
  const at = (date, mode = 'auto') => autoCycleFor(date, cycles, mode)?.id;
  assertEqual(at('2026-03-22'), '2@2026-03-20');
  assertEqual(at('2026-03-15'), '1@2026-03-15', 'no mesmo dia do recebimento:');
  assertEqual(at('2026-03-03'), '3@2026-02-28', 'vem do mês anterior:');
  assertEqual(at('2026-03-31'), '3@2026-03-30');
  assertEqual(at('2026-02-10'), undefined, 'antes de qualquer recebimento:');
});

test('próximo recebimento: o primeiro depois da data da despesa', () => {
  const cycles = buildCycles(SOURCES, '2026-02-01', '2026-04-30');
  const at = (date) => autoCycleFor(date, cycles, 'proximo')?.id;
  assertEqual(at('2026-03-22'), '3@2026-03-30');
  assertEqual(at('2026-03-15'), '2@2026-03-20', 'no dia do recebimento vale o seguinte:');
  assertEqual(at('2026-03-31'), '1@2026-04-15');
  assertEqual(at('2026-04-30'), undefined, 'sem recebimento futuro:');
});

test('dois recebimentos no mesmo dia: desempate pelo maior valor, sempre igual', () => {
  const two = [
    { id: 1, name: 'Pequeno', frequency: 'mensal', day: 10, amount: 100000 },
    { id: 2, name: 'Grande', frequency: 'mensal', day: 10, amount: 500000 },
  ];
  const cycles = buildCycles(two, '2026-03-01', '2026-03-31');
  assertEqual(autoCycleFor('2026-03-12', cycles, 'auto').id, '2@2026-03-10');
  assertEqual(autoCycleFor('2026-03-12', buildCycles(two.slice().reverse(), '2026-03-01', '2026-03-31'), 'auto').id, '2@2026-03-10');
});

test('alocação: nenhum recebimento anterior → pendência com motivo; estorno vira crédito', () => {
  const cycles = buildCycles([{ ...SOURCES[0], startDate: '2026-03-01' }], '2026-01-01', '2026-04-30');
  const txs = [
    { id: 1, date: '2026-02-01', amount: -5000, type: 'compra' },
    { id: 2, date: '2026-03-16', amount: -2000, type: 'compra' },
    { id: 3, date: '2026-03-17', amount: 700, type: 'estorno' },
    { id: 4, date: '2026-03-17', amount: 99000, type: 'pix_recebido' }, // entrada comum: nem entra na alocação
  ];
  const r = computeAllocations({ transactions: txs, cycles, mode: 'auto' });
  assertEqual(r.pending.length, 1);
  assertEqual(r.pending[0].tx.id, 1);
  assert(/anterior/.test(r.pending[0].reason), 'motivo explica');
  assertEqual(r.byTransaction.get(2).parts[0].amount, 2000);
  assertEqual(r.byTransaction.get(3).parts[0].amount, -700, 'estorno abate:');
  assertEqual(r.byTransaction.has(4), false);
});

test('alocação manual: validação da soma, ciclos e partes', () => {
  const ids = new Set(['a', 'b']);
  const fails = (parts) => { try { validateManualParts(100000, parts, ids); return false; } catch { return true; } };
  assertEqual(validateManualParts(100000, [{ cycleId: 'a', amount: 60000 }, { cycleId: 'b', amount: 40000 }], ids).length, 2);
  assert(fails([{ cycleId: 'a', amount: 60000 }, { cycleId: 'b', amount: 39999 }]), 'falta 1 centavo');
  assert(fails([{ cycleId: 'a', amount: 60000 }, { cycleId: 'b', amount: 40001 }]), 'sobra 1 centavo');
  assert(fails([{ cycleId: 'x', amount: 100000 }]), 'ciclo inexistente');
  assert(fails([{ cycleId: 'a', amount: 0 }, { cycleId: 'b', amount: 100000 }]), 'parte zero');
  assert(fails([]), 'sem partes');
  const merged = validateManualParts(100000, [{ cycleId: 'a', amount: 30000 }, { cycleId: 'a', amount: 70000 }], ids);
  assertEqual(merged.length, 1, 'mesmo ciclo repetido é somado:');
  assertEqual(merged[0].amount, 100000);
});

// ------------------------------------------------------------ banco: rendas
test('rendas: cadastrar, editar (muda frequência), nome repetido, ativar/desativar', async () => {
  const db = await freshDb();
  const fails = async (fn) => { try { await fn(); return false; } catch { return true; } };
  const s = await createSource(db, mensal('Salário', 30, 2000));
  assert(await fails(() => createSource(db, mensal('salário', 15, 100))), 'nome repetido (sem diferenciar maiúsculas)');
  const edited = await updateSource(db, s.id, { name: 'Salário', frequency: 'semanal', weekday: 1, amount: 50000 });
  assertEqual(edited.frequency, 'semanal');
  assertEqual(edited.day, undefined, 'campo da frequência antiga foi limpo:');
  assertEqual(edited.id, s.id);
  await setSourceActive(db, s.id, false);
  const model = await loadModel(db, { focusMonth: '2026-03', today: '2026-03-31' });
  assertEqual(model.cycles.length, 0, 'fonte desativada não gera ciclos:');
  await setSourceActive(db, s.id, true);
  assert((await loadModel(db, { focusMonth: '2026-03' })).cycles.length > 0);
  assert(await fails(() => updateSource(db, 999, mensal('X', 1, 1))), 'editar inexistente');
  await dispose(db);
});

test('recebimento no dia 30 em fevereiro pelo banco (ciclo e id corretos)', async () => {
  const db = await freshDb();
  const s = await createSource(db, mensal('Salário', 30, 2000));
  const model = await loadModel(db, { focusMonth: '2026-02', today: '2026-02-01' });
  const fev = model.cycles.filter((c) => c.date.startsWith('2026-02'));
  assertEqual(fev.length, 1);
  assertEqual(fev[0].date, '2026-02-28');
  assertEqual(fev[0].id, `${s.id}@2026-02-28`);
  await dispose(db);
});

test('frequências diferentes geram a quantidade certa de ciclos no mês', async () => {
  const db = await freshDb();
  await createSource(db, mensal('Mensal', 10, 100));
  await createSource(db, { name: 'Quinzenal', frequency: 'quinzenal', day: 15, amount: 10000 });
  await createSource(db, { name: 'Semanal', frequency: 'semanal', weekday: 5, amount: 10000 });
  await createSource(db, { name: 'Única', frequency: 'unica', date: '2026-03-25', amount: 10000 });
  const model = await loadModel(db, { focusMonth: '2026-03', today: '2026-03-01' });
  const marco = model.cycles.filter((c) => c.date.startsWith('2026-03'));
  const count = (name) => marco.filter((c) => c.name === name).length;
  assertEqual(count('Mensal'), 1);
  assertEqual(count('Quinzenal'), 2);
  assertEqual(count('Semanal'), 4);
  assertEqual(count('Única'), 1);
  // consultar ciclos futuros: a mensal existe em 2027, a única não
  const futuro = await loadModel(db, { focusMonth: '2027-01', today: '2026-03-01' });
  assertEqual(futuro.cycles.filter((c) => c.name === 'Mensal' && c.date.startsWith('2027-01')).length, 1);
  assertEqual(futuro.cycles.filter((c) => c.name === 'Única' && c.date.startsWith('2027-01')).length, 0);
  await dispose(db);
});

// ------------------------------------------------------------ banco: alocação manual e integridade
async function rentScenario() {
  const db = await freshDb();
  const a = await createSource(db, mensal('Adiantamento', 15, 1500));
  const b = await createSource(db, mensal('Extra', 20, 1000));
  const rent = await addTx(db, 'ALUGUEL MARCO', -100000, '2026-03-01');
  return { db, a, b, rent };
}

test('despesa dividida: aluguel de R$ 1.000 = R$ 600 + R$ 400 em ciclos sobrepostos', async () => {
  const { db, a, b, rent } = await rentScenario();
  const parts = await saveManualAllocation(db, rent, [
    { cycleId: `${a.id}@2026-03-15`, amount: 60000 },
    { cycleId: `${b.id}@2026-03-20`, amount: 40000 },
  ]);
  assertEqual(sumOf(parts), 100000);
  const model = await loadModel(db, { focusMonth: '2026-03', today: '2026-03-31' });
  const alloc = model.allocations.byTransaction.get(rent);
  assertEqual(alloc.mode, 'manual');
  assertEqual(sumOf(alloc.parts), 100000, 'soma = valor original:');
  const sumA = model.summaries.find((s) => s.cycle.id === `${a.id}@2026-03-15`);
  const sumB = model.summaries.find((s) => s.cycle.id === `${b.id}@2026-03-20`);
  assertEqual(sumA.allocated, 60000);
  assertEqual(sumB.allocated, 40000);
  assertEqual(sumA.plannedBalance, 150000 - 60000);
  assertEqual(model.pending.length, 0);
  assertEqual((await db.getAll('allocations')).length, 2);
  await dispose(db);
});

test('alocação manual inválida é recusada e NADA é gravado', async () => {
  const { db, a, b, rent } = await rentScenario();
  const ca = `${a.id}@2026-03-15`;
  const cb = `${b.id}@2026-03-20`;
  const fails = async (parts) => { try { await saveManualAllocation(db, rent, parts); return false; } catch { return true; } };
  assert(await fails([{ cycleId: ca, amount: 60000 }, { cycleId: cb, amount: 39999 }]), 'faltando');
  assert(await fails([{ cycleId: ca, amount: 60000 }, { cycleId: cb, amount: 40001 }]), 'passando');
  assert(await fails([{ cycleId: 'inexistente@2026-03-15', amount: 100000 }]), 'ciclo inexistente');
  assertEqual((await db.getAll('allocations')).length, 0, 'nada salvo:');
  const income = await addTx(db, 'SALARIO', 150000, '2026-03-16');
  try { await saveManualAllocation(db, income, [{ cycleId: ca, amount: 150000 }]); assert(false, 'deveria recusar'); } catch (e) { assert(/despesas/.test(e.message), e.message); }
  try { await saveManualAllocation(db, 9999, [{ cycleId: ca, amount: 1 }]); assert(false); } catch (e) { assert(/não encontrada/.test(e.message)); }
  await dispose(db);
});

test('alterar a alocação substitui a anterior (sem duplicar) e voltar ao automático funciona', async () => {
  const { db, a, b, rent } = await rentScenario();
  const ca = `${a.id}@2026-03-15`;
  const cb = `${b.id}@2026-03-20`;
  await saveManualAllocation(db, rent, [{ cycleId: ca, amount: 60000 }, { cycleId: cb, amount: 40000 }]);
  await saveManualAllocation(db, rent, [{ cycleId: cb, amount: 100000 }]);
  const rows = await db.getAll('allocations');
  assertEqual(rows.length, 1, 'uma linha só:');
  assertEqual(rows[0].cycleId, cb);
  await saveManualAllocation(db, rent, [{ cycleId: ca, amount: 30000 }, { cycleId: ca, amount: 70000 }]);
  const merged = await db.getAll('allocations');
  assertEqual(merged.length, 1, 'mesmo ciclo repetido vira uma linha:');
  assertEqual(merged[0].amount, 100000);
  assertEqual(await clearManualAllocation(db, rent), 1);
  const model = await loadModel(db, { focusMonth: '2026-03', today: '2026-03-31' });
  assert(model.allocations.byTransaction.get(rent)?.mode === 'auto' || model.pending.some((p) => p.tx.id === rent), 'voltou ao automático ou pendente');
  await dispose(db);
});

test('sem duplicação: cada despesa conta uma única vez (auto, manual, estorno, pendente)', async () => {
  const db = await freshDb();
  const a = await createSource(db, mensal('A', 15, 1500, { startDate: '2026-03-01' }));
  const b = await createSource(db, mensal('B', 20, 1000, { startDate: '2026-03-01' }));
  const t1 = await addTx(db, 'MERCADO', -10000, '2026-03-16');
  const t2 = await addTx(db, 'FARMACIA', -20000, '2026-03-21');
  const rent = await addTx(db, 'ALUGUEL', -100000, '2026-03-18');
  const t4 = await addTx(db, 'ANTIGA', -5000, '2026-02-01'); // sem recebimento anterior -> pendente
  const t5 = await addTx(db, 'ESTORNO FARMACIA', 3000, '2026-03-25', { type: 'estorno' });
  await saveManualAllocation(db, rent, [{ cycleId: `${a.id}@2026-03-15`, amount: 60000 }, { cycleId: `${b.id}@2026-03-20`, amount: 40000 }]);

  const model = await loadModel(db, { focusMonth: '2026-03', today: '2026-03-31' });
  const allocatedTotal = model.summaries.reduce((s, c) => s + c.allocated, 0);
  assertEqual(allocatedTotal, 10000 + 20000 + 100000 - 3000, 'soma dos ciclos = soma das despesas alocadas:');
  assertEqual(model.pending.length, 1);
  assertEqual(model.pending[0].tx.id, t4, 'a antiga está nas pendências e fora dos ciclos:');
  for (const id of [t1, t2, rent, t5]) {
    const alloc = model.allocations.byTransaction.get(id);
    assert(alloc, `transação ${id} deveria estar alocada`);
    const appearances = model.summaries.flatMap((s) => s.expenses).filter((e) => e.tx.id === id);
    assertEqual(sumOf(appearances), sumOf(alloc.parts), `transação ${id} aparece nos ciclos exatamente pelo valor alocado:`);
  }
  assertEqual(model.allocations.byTransaction.has(t4), false);
  await dispose(db);
});

test('renda editada: alocação manual quebrada vai para pendências (nunca conta nem some)', async () => {
  const { db, a, b, rent } = await rentScenario();
  await saveManualAllocation(db, rent, [{ cycleId: `${a.id}@2026-03-15`, amount: 60000 }, { cycleId: `${b.id}@2026-03-20`, amount: 40000 }]);
  await updateSource(db, a.id, mensal('Adiantamento', 16, 1500)); // dia 15 -> 16: o ciclo antigo deixa de existir
  const model = await loadModel(db, { focusMonth: '2026-03', today: '2026-03-31' });
  assertEqual(model.allocations.byTransaction.has(rent), false, 'não conta em nenhum ciclo:');
  const p = model.pending.find((x) => x.tx.id === rent);
  assert(p && /não existe mais/.test(p.reason), 'está nas pendências com motivo');
  assertEqual(model.summaries.reduce((s, c) => s + c.allocated, 0), 0, 'nenhum ciclo conta a despesa:');
  assertEqual((await db.get('transactions', rent)).amount, -100000, 'transação intacta:');
  await dispose(db);
});

test('excluir renda: remove só as alocações/vínculos dela; transações e outras rendas ficam', async () => {
  const { db, a, b, rent } = await rentScenario();
  const other = await addTx(db, 'FARMACIA', -8000, '2026-03-22');
  await saveManualAllocation(db, rent, [{ cycleId: `${a.id}@2026-03-15`, amount: 60000 }, { cycleId: `${b.id}@2026-03-20`, amount: 40000 }]);
  await saveManualAllocation(db, other, [{ cycleId: `${b.id}@2026-03-20`, amount: 8000 }]);
  const salario = await addTx(db, 'SALARIO', 150000, '2026-03-16');
  await linkReceipt(db, salario, `${a.id}@2026-03-15`);
  const impact = await deleteImpact(db, a.id);
  assertEqual(impact.manualAllocations, 1);
  assertEqual(impact.receiptLinks, 1);
  const result = await deleteSource(db, a.id);
  assertEqual(result.manualAllocations, 1);
  assertEqual((await listSources(db)).length, 1);
  const rows = await db.getAll('allocations');
  assertEqual(rows.length, 1, 'sobrou só a do outro ciclo:');
  assertEqual(rows[0].transactionId, other);
  assertEqual((await db.getAll('receiptLinks')).length, 0);
  assertEqual(await db.count('transactions'), 3, 'nenhuma transação apagada:');
  const model = await loadModel(db, { focusMonth: '2026-03', today: '2026-03-31' });
  assert(model.allocations.byTransaction.has(rent) || model.pending.some((p) => p.tx.id === rent), 'o aluguel voltou ao cálculo automático ou às pendências');
  await dispose(db);
});

// ------------------------------------------------------------ recebimentos previstos x realizados
const RECEIPT_SOURCES = [
  { id: 1, name: 'Adiantamento', frequency: 'mensal', day: 15, amount: 150000 },
  { id: 2, name: 'Extra', frequency: 'mensal', day: 20, amount: 100000 },
];
const inc = (id, date, amount, type = 'pix_recebido') => ({ id, date, amount, type });

test('recebimentos: liga entradas aos ciclos por data e valor (melhor par vence)', () => {
  const cycles = buildCycles(RECEIPT_SOURCES, '2026-03-01', '2026-03-31');
  const txs = [
    inc(1, '2026-03-16', 150000),  // 1 dia do ciclo 1, valor igual: ligação
    inc(2, '2026-03-15', 500),     // valor muito diferente: sem ligação
    inc(3, '2026-03-24', 100000),  // 4 dias do ciclo 2: ligação
    inc(4, '2026-03-10', 150000),  // 5 dias do ciclo 1, mas o ciclo 1 já tem uma melhor
    inc(5, '2026-03-15', 120000),  // 20% abaixo: fora da tolerância
    inc(6, '2026-03-18', 100000, 'estorno'), // estorno não é recebimento
  ];
  const r = matchReceipts({ cycles, transactions: txs });
  assertEqual(r.linkOf.get(1).cycleId, '1@2026-03-15');
  assertEqual(r.linkOf.get(1).origin, 'auto');
  assertEqual(r.linkOf.get(3).cycleId, '2@2026-03-20');
  assertEqual(r.linkOf.has(2), false);
  assertEqual(r.linkOf.has(4), false, 'só uma automática por ciclo:');
  assertEqual(r.linkOf.has(5), false);
  assertEqual(r.linkOf.has(6), false);
  assertEqual(r.unlinked.map((t) => t.id).sort().join(), '2,4,5');
});

test('recebimentos: vínculo manual vale mais que o automático e dá para desvincular', () => {
  const cycles = buildCycles(RECEIPT_SOURCES, '2026-03-01', '2026-03-31');
  const txs = [inc(1, '2026-03-16', 150000), inc(4, '2026-03-10', 150000)];
  // você liga a #4 ao ciclo 1: a automática da #1 sai (o ciclo já tem recebimento seu)
  let r = matchReceipts({ cycles, transactions: txs, links: [{ transactionId: 4, cycleId: '1@2026-03-15' }] });
  assertEqual(r.linkOf.get(4).origin, 'manual');
  assertEqual(r.byCycle.get('1@2026-03-15').length, 1);
  assertEqual(r.linkOf.has(1) && r.linkOf.get(1).cycleId, false, 'a #1 ficou sem ciclo:');
  // desvincular a #1 explicitamente (cycleId null)
  r = matchReceipts({ cycles, transactions: txs, links: [{ transactionId: 1, cycleId: null }] });
  assertEqual(r.linkOf.get(1).cycleId, null);
  assertEqual(r.linkOf.get(4).cycleId, '1@2026-03-15', 'a #4 assume a automática:');
  // vínculo para ciclo que não existe mais é ignorado
  r = matchReceipts({ cycles, transactions: txs, links: [{ transactionId: 1, cycleId: '9@2026-03-15' }] });
  assertEqual(r.linkOf.get(1).cycleId, '1@2026-03-15');
});

test('ciclo: previsto x recebido, saldo planejado x saldo real e situação', () => {
  const txs = [
    { id: 1, date: '2026-03-16', amount: 140000, type: 'pix_recebido', originalDescription: 'SALARIO' }, // 6,7% abaixo: casa
    { id: 2, date: '2026-03-17', amount: -30000, type: 'compra' },
    { id: 3, date: '2026-03-18', amount: -20000, type: 'compra' },
  ];
  const model = buildModel({ transactions: txs, sources: RECEIPT_SOURCES, today: '2026-03-31', focusMonth: '2026-03' });
  const by = (id) => model.summaries.find((s) => s.cycle.id === id);
  const c1 = by('1@2026-03-15');
  assertEqual(c1.expected, 150000);
  assertEqual(c1.received, 140000);
  assertEqual(c1.status, 'parcial', 'recebeu menos que o previsto:');
  assertEqual(c1.allocated, 50000, 'as 2 despesas (17 e 18) caem no ciclo do dia 15:');
  assertEqual(c1.plannedBalance, 100000, 'previsto − despesas:');
  assertEqual(c1.realBalance, 90000, 'recebido − despesas:');
  assertEqual(by('2@2026-03-20').status, 'sem_recebimento', 'passou a data e nada foi identificado:');
  assertEqual(by('2@2026-03-20').realBalance, 0);
  assertEqual(by('1@2026-04-15').status, 'previsto', 'ciclo futuro:');
  assertEqual(by('1@2026-04-15').received, 0);
  const full = buildModel({ transactions: [{ ...txs[0], amount: 150000 }], sources: RECEIPT_SOURCES, today: '2026-03-31', focusMonth: '2026-03' });
  assertEqual(full.summaries.find((s) => s.cycle.id === '1@2026-03-15').status, 'recebido');
});

test('despesas comprometidas (antes do recebimento) x realizadas (depois), no modo próximo recebimento', () => {
  const txs = [
    { id: 1, date: '2026-03-10', amount: -40000, type: 'compra' },  // antes do dia 15
    { id: 2, date: '2026-03-18', amount: -10000, type: 'compra' },  // depois do dia 15
  ];
  const sources = [RECEIPT_SOURCES[0]];
  const proximo = buildModel({ transactions: txs, sources, mode: 'proximo', today: '2026-03-31', focusMonth: '2026-03' });
  const c = proximo.summaries.find((s) => s.cycle.id === '1@2026-03-15');
  assertEqual(c.committed, 40000, 'adiantada, conta com o recebimento do dia 15:');
  assertEqual(c.realized, 0, 'a de dia 18 vai para o recebimento seguinte:');
  const auto = buildModel({ transactions: txs, sources, mode: 'auto', today: '2026-03-31', focusMonth: '2026-03' });
  const a = auto.summaries.find((s) => s.cycle.id === '1@2026-03-15');
  assertEqual(a.realized, 10000);
  assertEqual(a.committed, 0);
});

// ------------------------------------------------------------ persistência
test('ciclos persistem após fechar e reabrir o banco (atualizar a página)', async () => {
  const { db, a, b, rent } = await rentScenario();
  const salario = await addTx(db, 'SALARIO', 150000, '2026-03-16');
  await saveManualAllocation(db, rent, [{ cycleId: `${a.id}@2026-03-15`, amount: 60000 }, { cycleId: `${b.id}@2026-03-20`, amount: 40000 }]);
  await linkReceipt(db, salario, `${a.id}@2026-03-15`);
  await setMode(db, 'proximo');
  const before = await loadModel(db, { focusMonth: '2026-03', today: '2026-03-31' });
  const name = db._testName;
  db.close();

  const reopened = await new Database(name).open();
  reopened._testName = name;
  const after = await loadModel(reopened, { focusMonth: '2026-03', today: '2026-03-31' });
  assertEqual(await getMode(reopened), 'proximo');
  assertEqual((await listSources(reopened)).length, 2, 'rendas:');
  assertEqual(sumOf(after.allocations.byTransaction.get(rent).parts), 100000, 'alocação manual:');
  assertEqual(after.receipts.linkOf.get(salario).cycleId, `${a.id}@2026-03-15`, 'vínculo manual:');
  assertEqual(JSON.stringify(after.summaries.map((s) => [s.cycle.id, s.allocated, s.received])),
    JSON.stringify(before.summaries.map((s) => [s.cycle.id, s.allocated, s.received])), 'resumos idênticos:');
  await clearReceiptLink(reopened, salario);
  assertEqual((await reopened.getAll('receiptLinks')).length, 0);
  await dispose(reopened);
});

test('modo de alocação: padrão automático, aceita só modos válidos', async () => {
  const db = await freshDb();
  assertEqual(await getMode(db), 'auto');
  await setMode(db, 'proximo');
  assertEqual(await getMode(db), 'proximo');
  try { await setMode(db, 'inventado'); assert(false); } catch (e) { assert(/inválido/.test(e.message)); }
  await dispose(db);
});
