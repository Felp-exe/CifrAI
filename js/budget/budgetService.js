// Orçamentos no banco: um limite mensal por categoria, valendo para todos os meses.
export async function listBudgets(db) {
  return db.getAll('budgets');
}

async function checkCategory(db, categoryId) {
  if (!categoryId || !(await db.get('categories', categoryId))) throw new Error('Escolha uma categoria válida.');
}

function checkLimit(limit) {
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('Informe um limite maior que zero.');
}

export async function createBudget(db, { categoryId, limit }) {
  await checkCategory(db, categoryId);
  checkLimit(limit);
  const existing = await db.getAllByIndex('budgets', 'categoryId', categoryId);
  if (existing.length) throw new Error('Esta categoria já tem orçamento. Edite o existente.');
  const record = { categoryId, limit, month: null, createdAt: new Date().toISOString() };
  record.id = await db.add('budgets', record);
  return record;
}

export async function updateBudget(db, id, { limit }) {
  const current = await db.get('budgets', id);
  if (!current) throw new Error('Orçamento não encontrado.');
  checkLimit(limit);
  const updated = { ...current, limit };
  await db.put('budgets', updated);
  return updated;
}

export async function deleteBudget(db, id) {
  await db.delete('budgets', id);
}
