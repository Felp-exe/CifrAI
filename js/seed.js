// Carrega os dados iniciais (categorias e regras) na primeira vez que o app abre
// e mantém os bancos já existentes em dia quando o app ganha categorias/regras novas.
// Os dados ficam nos arquivos data/*.json e são lidos por HTTP (fetch).
import { normalizeText } from './utils/format.js';

/**
 * @param {Database} db banco já aberto
 * @param {string} baseUrl pasta onde ficam os JSON (ex.: "data/" ou "../data/")
 * @returns {Promise<boolean>} true se carregou agora, false se já estava carregado
 */
export async function seedDefaults(db, baseUrl = 'data/') {
  if (await db.getMeta('seeded')) return false;

  const [categories, rules] = await Promise.all([
    fetchJson(baseUrl + 'categories.json'),
    fetchJson(baseUrl + 'merchant-rules.json'),
  ]);

  await db.bulkPut('categories', categories);
  await db.bulkPut('rules', rules);
  await db.setMeta('seeded', true);
  return true;
}

/**
 * Garante que as categorias iniciais novas existam (ex.: Família, Esporte, Dízimo), sem apagar nem
 * renomear as suas. Se você já tinha criado uma categoria com o mesmo id, ela é mantida (nome e cor
 * ficam como estão) e só passa a contar como categoria inicial, para as regras não ficarem órfãs.
 * @returns {{ added: number, promoted: number }}
 */
export async function syncInitialCategories(db, baseUrl = 'data/') {
  const wanted = await fetchJson(baseUrl + 'categories.json');
  const existing = await db.getAll('categories');
  const byId = new Map(existing.map((c) => [c.id, c]));
  const byName = new Map(existing.map((c) => [normalizeText(c.nome), c]));
  const writes = [];
  let added = 0;
  let promoted = 0;
  for (const w of wanted) {
    const mine = byId.get(w.id) || byName.get(normalizeText(w.nome));
    if (!mine) { writes.push({ ...w }); added += 1; }
    else if (mine.id === w.id && !mine.padrao) { writes.push({ ...mine, padrao: true }); promoted += 1; }
  }
  if (writes.length) await db.bulkPut('categories', writes);
  return { added, promoted };
}

const RULE_FIELDS = ['categoryId', 'observacao', 'alternatives', 'aproximar', 'substring'];

/**
 * Mantém as regras INICIAIS do banco iguais às de data/merchant-rules.json:
 * acrescenta as novas e atualiza as que mudaram (categoria, variações, observação).
 * Nunca mexe nas regras do usuário nem no "ativa/desativada" das iniciais.
 * @returns {number} quantas regras foram acrescentadas ou atualizadas
 */
export async function syncInitialRules(db, baseUrl = 'data/') {
  const wanted = (await fetchJson(baseUrl + 'merchant-rules.json')).filter((r) => r.origem === 'inicial');
  const existing = await db.getAll('rules');
  const writes = [];
  for (const w of wanted) {
    const mine = existing.find((r) => r.origem === 'inicial' && r.pattern === w.pattern && r.matchType === w.matchType);
    if (!mine) { writes.push({ ...w }); continue; }
    const differs = RULE_FIELDS.some((f) => JSON.stringify(mine[f] ?? null) !== JSON.stringify(w[f] ?? null));
    if (differs) {
      const updated = { ...mine };
      for (const f of RULE_FIELDS) { if (w[f] === undefined) delete updated[f]; else updated[f] = w[f]; }
      writes.push(updated);
    }
  }
  if (writes.length) await db.bulkPut('rules', writes);
  return writes.length;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Não consegui carregar ${url} (erro ${response.status}).`);
  return response.json();
}
