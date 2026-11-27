// Categorias: criar, editar e excluir, sem quebrar as transações que já usam cada uma.
import { normalizeText } from '../utils/format.js';

export async function listCategories(db) {
  const all = await db.getAll('categories');
  // Iniciais primeiro (na ordem original), depois as suas por nome.
  return all.sort((a, b) => Number(Boolean(b.padrao)) - Number(Boolean(a.padrao)) || a.nome.localeCompare(b.nome, 'pt-BR'));
}

function cleanName(nome) {
  const name = String(nome ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('Digite um nome para a categoria.');
  if (name.length > 30) throw new Error('O nome pode ter no máximo 30 caracteres.');
  return name;
}

function cleanColor(cor) {
  if (!/^#[0-9a-f]{6}$/i.test(cor || '')) throw new Error('Escolha uma cor válida.');
  return cor.toLowerCase();
}

export async function createCategory(db, { nome, cor }) {
  const name = cleanName(nome);
  const color = cleanColor(cor);
  const all = await db.getAll('categories');
  if (all.some((c) => normalizeText(c.nome) === normalizeText(name))) {
    throw new Error('Já existe uma categoria com esse nome.');
  }
  const base = normalizeText(name).replace(/ /g, '-') || 'categoria';
  let id = base;
  for (let n = 2; all.some((c) => c.id === id); n++) id = `${base}-${n}`;
  const category = { id, nome: name, cor: color, padrao: false };
  await db.put('categories', category);
  return category;
}

export async function updateCategory(db, id, { nome, cor }) {
  const current = await db.get('categories', id);
  if (!current) throw new Error('Categoria não encontrada.');
  const color = cleanColor(cor);
  if (current.padrao) {
    if (nome !== undefined && cleanName(nome) !== current.nome) {
      throw new Error('As categorias iniciais só permitem mudar a cor.');
    }
    const updated = { ...current, cor: color };
    await db.put('categories', updated);
    return updated;
  }
  const name = cleanName(nome);
  const all = await db.getAll('categories');
  if (all.some((c) => c.id !== id && normalizeText(c.nome) === normalizeText(name))) {
    throw new Error('Já existe uma categoria com esse nome.');
  }
  const updated = { ...current, nome: name, cor: color };
  await db.put('categories', updated);
  return updated;
}

/** Quantas transações, regras e orçamentos usam a categoria. */
export async function categoryUsage(db, id) {
  const [transactions, rules, budgets] = await Promise.all([db.getAll('transactions'), db.getAll('rules'), db.getAll('budgets')]);
  return {
    transactions: transactions.filter((t) => t.categoryId === id || t.suggestedCategoryId === id).length,
    rules: rules.filter((r) => r.categoryId === id).length,
    budgets: budgets.filter((b) => b.categoryId === id).length,
  };
}

/**
 * Exclui uma categoria PERSONALIZADA. Se houver transações/regras usando, é obrigatório escolher
 * outra categoria de destino: tudo é movido numa única operação "tudo ou nada".
 */
export async function deleteCategory(db, id, moveToId = null) {
  const category = await db.get('categories', id);
  if (!category) return { movedTransactions: 0, movedRules: 0 };
  if (category.padrao) throw new Error('As categorias iniciais não podem ser excluídas.');

  const [transactions, rules, budgets] = await Promise.all([db.getAll('transactions'), db.getAll('rules'), db.getAll('budgets')]);
  const usedTx = transactions.filter((t) => t.categoryId === id || t.suggestedCategoryId === id);
  const usedRules = rules.filter((r) => r.categoryId === id);
  const usedBudgets = budgets.filter((b) => b.categoryId === id); // o orçamento da categoria excluída também é excluído

  if (usedTx.length || usedRules.length) {
    if (!moveToId || moveToId === id) throw new Error('Escolha para qual categoria mover as transações e regras.');
    if (!(await db.get('categories', moveToId))) throw new Error('A categoria de destino não existe.');
  }

  await db.transact(['categories', 'transactions', 'rules', 'budgets'], (stores) => {
    for (const b of usedBudgets) stores.budgets.delete(b.id);
    for (const t of usedTx) {
      const moved = { ...t };
      if (moved.categoryId === id) {
        moved.categoryId = moveToId;
        moved.reason = `Categoria "${category.nome}" foi excluída; movida para outra categoria.`;
      }
      if (moved.suggestedCategoryId === id) moved.suggestedCategoryId = moveToId;
      stores.transactions.put(moved); // data, valor e descrição não são tocados
    }
    for (const r of usedRules) stores.rules.put({ ...r, categoryId: moveToId });
    stores.categories.delete(id);
  });
  return { movedTransactions: usedTx.length, movedRules: usedRules.length, deletedBudgets: usedBudgets.length };
}
