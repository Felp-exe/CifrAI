// Restauração do backup: PLANEJAR (sem gravar nada) e depois APLICAR (tudo numa única transação).
//
// Dois modos:
//  - "replace" (substituir): apaga os dados atuais e coloca os do backup, com os mesmos ids.
//  - "merge" (mesclar): acrescenta só o que ainda não existe, sem duplicar:
//      categorias por id · regras por (origem, texto, comparação) · orçamentos por categoria ·
//      rendas por nome · importações por id · transações pela "impressão digital" (data+valor+nome+ocorrência).
//      No que já existe, o dado ATUAL vence. Única exceção: se o backup tem uma CORREÇÃO MANUAL e a
//      transação atual não tem, a correção é trazida (nunca valores, datas ou descrições).
//      Alocações manuais e vínculos só entram para transações NOVAS, com os ids refeitos.
//
// Segurança: a aplicação usa UMA transação do IndexedDB. Se qualquer gravação falhar, o navegador desfaz
// tudo e o banco fica exatamente como estava (nunca "meio restaurado").
import { STORES, META_KEYS } from './backupFormat.js';
import { normalizeText } from '../utils/format.js';

export const MODES = { replace: 'Substituir os dados atuais pelo backup', merge: 'Mesclar com os dados atuais (sem duplicar)' };

const CYCLE_ID = /^(\d+)@(.+)$/;
const maxId = (rows) => rows.reduce((m, r) => (typeof r.id === 'number' && r.id > m ? r.id : m), 0);

/** Quantidade de registros atuais em cada tabela (para mostrar antes de restaurar). */
export async function currentCounts(db) {
  const counts = {};
  for (const store of STORES) counts[store] = await db.count(store);
  return counts;
}

async function readAll(db) {
  const all = {};
  for (const store of STORES) all[store] = await db.getAll(store);
  return all;
}

/**
 * Prepara a restauração SEM gravar nada.
 * @param backup objeto já validado e limpo (parseBackupText().backup)
 * @returns plano: { mode, clear:[stores], writes:{store:[registros]}, meta:{set:{}, remove:[]}, summary }
 */
export async function planRestore(db, backup, mode) {
  if (!(mode in MODES)) throw new Error('Escolha como restaurar: substituir ou mesclar.');
  const current = await readAll(db);
  const plan = mode === 'replace' ? planReplace(backup, current) : planMerge(backup, current);
  return { mode, ...plan };
}

function planReplace(backup, current) {
  const writes = {};
  const removed = {};
  const added = {};
  for (const store of STORES) {
    writes[store] = [...backup.data[store]]; // cópia: o plano nunca altera o objeto do backup
    removed[store] = current[store].length;
    added[store] = backup.data[store].length;
  }
  const set = {};
  const remove = [];
  for (const key of META_KEYS) { if (backup.meta[key] !== undefined) set[key] = backup.meta[key]; else if (key !== 'seeded') remove.push(key); }
  set.seeded = true; // o backup traz as categorias e regras; não recarregar os padrões por cima
  return {
    clear: [...STORES],
    writes, meta: { set, remove },
    summary: { added, removed, skipped: {}, notes: [`${current.transactions.length} transação(ões) que existiam foram substituídas por ${backup.data.transactions.length} do backup.`] },
  };
}

function planMerge(backup, current) {
  const writes = Object.fromEntries(STORES.map((s) => [s, []]));
  const added = Object.fromEntries(STORES.map((s) => [s, 0]));
  const skipped = Object.fromEntries(STORES.map((s) => [s, 0]));
  const notes = [];
  let updatedManual = 0;
  const put = (store, record) => { writes[store].push(record); added[store] += 1; };

  // categorias (por id)
  const catIds = new Set(current.categories.map((c) => c.id));
  for (const c of backup.data.categories) { if (catIds.has(c.id)) skipped.categories += 1; else { put('categories', c); catIds.add(c.id); } }

  // regras (origem + texto + comparação). Mapeia o id do backup para o id final.
  const ruleKey = (r) => `${r.origem}|${normalizeText(r.pattern)}|${r.matchType}`;
  const ruleByKey = new Map(current.rules.map((r) => [ruleKey(r), r.id]));
  const ruleIdMap = new Map();
  let nextRuleId = maxId(current.rules) + 1;
  let ruleConflicts = 0;
  for (const r of backup.data.rules) {
    const existingId = ruleByKey.get(ruleKey(r));
    if (existingId !== undefined) {
      ruleIdMap.set(r.id, existingId);
      skipped.rules += 1;
      const mine = current.rules.find((x) => x.id === existingId);
      if (mine && mine.categoryId !== r.categoryId) ruleConflicts += 1;
    } else {
      const id = nextRuleId++;
      ruleIdMap.set(r.id, id);
      ruleByKey.set(ruleKey(r), id);
      put('rules', { ...r, id });
    }
  }
  if (ruleConflicts) notes.push(`${ruleConflicts} regra(s) já existiam com outra categoria: ficou a regra atual.`);

  // orçamentos (um por categoria)
  const budgeted = new Set(current.budgets.map((b) => b.categoryId));
  let nextBudgetId = maxId(current.budgets) + 1;
  for (const b of backup.data.budgets) {
    if (budgeted.has(b.categoryId)) skipped.budgets += 1;
    else { put('budgets', { ...b, id: nextBudgetId++ }); budgeted.add(b.categoryId); }
  }

  // rendas (por nome). O mapa refaz o prefixo dos ciclos ("3@2026-03-15").
  const incomeByName = new Map(current.incomes.map((s) => [normalizeText(s.name), s.id]));
  const incomeIdMap = new Map();
  let nextIncomeId = maxId(current.incomes) + 1;
  for (const s of backup.data.incomes) {
    const key = normalizeText(s.name);
    if (incomeByName.has(key)) { incomeIdMap.set(s.id, incomeByName.get(key)); skipped.incomes += 1; }
    else { const id = nextIncomeId++; incomeIdMap.set(s.id, id); incomeByName.set(key, id); put('incomes', { ...s, id }); }
  }

  // importações (por id)
  const importIds = new Set(current.imports.map((m) => m.id));
  for (const m of backup.data.imports) { if (importIds.has(m.id)) skipped.imports += 1; else { put('imports', m); importIds.add(m.id); } }

  // transações (pela impressão digital)
  const fp = (t) => t.fingerprint || `${t.date}|${t.amount}|${t.normalizedName}`;
  const existingByFp = new Map(current.transactions.map((t) => [fp(t), t]));
  const txIdMap = new Map();
  const newTx = new Set();
  let nextTxId = maxId(current.transactions) + 1;
  for (const t of backup.data.transactions) {
    const mine = existingByFp.get(fp(t));
    if (mine) {
      txIdMap.set(t.id, mine.id);
      skipped.transactions += 1;
      if (t.manual && !mine.manual) { // traz a correção manual do backup (somente classificação)
        updatedManual += 1;
        writes.transactions.push({
          ...mine, categoryId: t.categoryId ?? null, status: t.status || 'classificada', categorySource: t.categorySource || 'manual',
          confidence: t.confidence, reason: t.reason, manual: true, categorizedAt: t.categorizedAt,
          suggestedCategoryId: t.suggestedCategoryId, ruleId: t.ruleId === undefined ? mine.ruleId : (ruleIdMap.get(t.ruleId) ?? null),
        });
      }
    } else {
      const id = nextTxId++;
      txIdMap.set(t.id, id);
      newTx.add(t.id);
      const record = { ...t, id };
      if (t.ruleId !== undefined) record.ruleId = ruleIdMap.get(t.ruleId) ?? null;
      put('transactions', record);
      existingByFp.set(fp(t), record);
    }
  }
  if (updatedManual) notes.push(`${updatedManual} correção(ões) manual(is) do backup foram trazidas para transações que já existiam.`);

  // alocações manuais e vínculos: só para transações NOVAS (as que já existiam mantêm as decisões atuais)
  const remapCycle = (cycleId) => {
    const m = CYCLE_ID.exec(cycleId);
    if (!m) return null;
    const newIncome = incomeIdMap.get(Number(m[1]));
    return newIncome === undefined ? null : `${newIncome}@${m[2]}`;
  };
  let nextAllocId = maxId(current.allocations) + 1;
  let lostAllocs = 0;
  for (const a of backup.data.allocations) {
    if (!newTx.has(a.transactionId)) { skipped.allocations += 1; continue; }
    const cycleId = remapCycle(a.cycleId);
    if (!cycleId) { lostAllocs += 1; continue; }
    put('allocations', { ...a, id: nextAllocId++, transactionId: txIdMap.get(a.transactionId), cycleId });
  }
  let nextLinkId = maxId(current.receiptLinks) + 1;
  for (const l of backup.data.receiptLinks) {
    if (!newTx.has(l.transactionId)) { skipped.receiptLinks += 1; continue; }
    const cycleId = l.cycleId === null ? null : remapCycle(l.cycleId);
    if (l.cycleId !== null && !cycleId) { lostAllocs += 1; continue; }
    put('receiptLinks', { ...l, id: nextLinkId++, transactionId: txIdMap.get(l.transactionId), cycleId });
  }
  if (lostAllocs) notes.push(`${lostAllocs} alocação(ões)/vínculo(s) não puderam ser refeitos e foram ignorados.`);

  return {
    clear: [], writes, meta: { set: {}, remove: [] },
    summary: { added, removed: {}, skipped, updatedManual, notes },
  };
}

/**
 * Grava o plano numa ÚNICA transação (tudo ou nada).
 * Se qualquer gravação falhar, o navegador desfaz todas e o banco permanece como estava.
 */
export async function applyPlan(db, plan) {
  const names = [...new Set([...plan.clear, ...Object.keys(plan.writes).filter((s) => plan.writes[s].length), 'meta'])];
  await db.transact(names, (stores) => {
    for (const store of plan.clear) stores[store].clear();
    for (const store of Object.keys(plan.writes)) for (const record of plan.writes[store]) stores[store].put(record);
    for (const [key, value] of Object.entries(plan.meta.set)) stores.meta.put({ key, value });
    for (const key of plan.meta.remove) stores.meta.delete(key);
    plan.hooks?.afterWrites?.(); // gancho só para testes: simula uma falha no meio da gravação
  });
  return plan.summary;
}

/**
 * Restaura um backup. Exige confirmação explícita (`confirmed === true`) e nunca sobrescreve em silêncio.
 * @param options { mode: 'replace'|'merge', confirmed: true, plan?: plano já calculado }
 */
export async function restoreBackup(db, backup, { mode, confirmed, plan = null } = {}) {
  if (confirmed !== true) throw new Error('A restauração exige a confirmação explícita do usuário.');
  const finalPlan = plan || await planRestore(db, backup, mode);
  return applyPlan(db, finalPlan);
}
