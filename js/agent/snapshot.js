// "Fotografia" SOMENTE LEITURA dos dados, entregue às ferramentas.
//
// Segurança: as ferramentas nunca recebem o banco de dados (IndexedDB). Elas recebem este objeto,
// que é uma cópia congelada (nada pode ser alterado). Por isso o modelo de linguagem não tem
// como ler ou gravar "qualquer coisa": só o que as ferramentas declaradas devolvem.
import { buildModel } from '../cycles/model.js';
import { normalizeText } from '../utils/format.js';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value) && !(value instanceof Map)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** Monta a fotografia a partir de dados já lidos (usado nos testes e por loadSnapshot). */
export function buildSnapshot({
  today, transactions = [], categories = [], budgets = [], rules = [], sources = [], manual = [], links = [], allocationMode = 'auto', defaultPeriod = null,
}) {
  const snapshot = {
    today, transactions, categories, budgets, rules, sources, manual, links, allocationMode, defaultPeriod,
    categoriesById: new Map(categories.map((c) => [c.id, c])),
    _models: new Map(),
  };
  const maps = { categoriesById: snapshot.categoriesById, _models: snapshot._models };
  deepFreeze({ ...snapshot, categoriesById: null, _models: null });
  return Object.assign(snapshot, maps);
}

/** Lê o IndexedDB (leitura apenas) e devolve a fotografia. */
export async function loadSnapshot(db, { today, defaultPeriod = null }) {
  const [transactions, categories, budgets, rules, sources, manual, links, mode] = await Promise.all([
    db.getAll('transactions'), db.getAll('categories'), db.getAll('budgets'), db.getAll('rules'),
    db.getAll('incomes'), db.getAll('allocations'), db.getAll('receiptLinks'), db.getMeta('allocationMode'),
  ]);
  return buildSnapshot({
    today, transactions, categories, budgets, rules, sources, manual, links, allocationMode: mode || 'auto', defaultPeriod,
  });
}

/** Modelo de ciclos (Etapa 4) calculado sobre a fotografia, com cache por foco/modo. */
export function getModel(snapshot, focus = null, mode = null) {
  const m = mode || snapshot.allocationMode;
  const key = `${m}|${typeof focus === 'string' ? focus : JSON.stringify(focus)}`;
  if (!snapshot._models.has(key)) {
    snapshot._models.set(key, buildModel({
      transactions: snapshot.transactions, sources: snapshot.sources, manual: snapshot.manual, links: snapshot.links,
      mode: m, today: snapshot.today, focusMonth: focus,
    }));
  }
  return snapshot._models.get(key);
}

/** Encontra uma categoria pelo id ou pelo nome (sem diferenciar acentos e maiúsculas). */
export function findCategory(snapshot, text) {
  if (!text) return null;
  const wanted = normalizeText(text);
  return snapshot.categories.find((c) => c.id === text || normalizeText(c.nome) === wanted || normalizeText(c.id) === wanted) || null;
}
