// Propostas de alteração. Ficam só na MEMÓRIA da página e NÃO mexem em nenhum dado.
//
// O agente (modelo de linguagem ou modo local) só consegue CRIAR uma proposta (ferramenta
// "propose_categorization"). Para aplicar, o usuário precisa clicar em "Confirmar" na tela;
// quem aplica é proposalApply.js, que é importado apenas pela interface, nunca pelas ferramentas.
let sequence = 0;
const store = new Map();

export function createProposal({ transactionIds, categoryId, categoryName, remember, preview }) {
  sequence += 1;
  const id = `prop-${sequence}-${Math.random().toString(36).slice(2, 7)}`;
  const proposal = {
    id, status: 'pending', createdAt: new Date().toISOString(),
    transactionIds: [...transactionIds], categoryId, categoryName, remember: Boolean(remember), preview,
  };
  store.set(id, proposal);
  return proposal;
}

export const getProposal = (id) => store.get(id) || null;

export function cancelProposal(id) {
  const p = store.get(id);
  if (p && p.status === 'pending') p.status = 'cancelled';
  return p || null;
}

/** Uso interno: marca como aplicada (chamado somente por proposalApply.js). */
export function markApplied(id) {
  const p = store.get(id);
  if (p) p.status = 'applied';
}

export function clearProposals() {
  store.clear();
}
