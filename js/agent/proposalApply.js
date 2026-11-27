// Aplica uma proposta de categorização. ÚNICO ponto do agente que grava dados.
// Só pode ser chamado pela interface, depois de o usuário clicar em "Confirmar".
// Usa as mesmas regras da tela de Transações (setCategory): a correção fica protegida contra
// sobrescrita automática e, se pedido, cria a regra para o estabelecimento.
import { setCategory } from '../categorization/transactionService.js';
import { getProposal, markApplied } from './proposals.js';

/**
 * @param options.userConfirmed precisa ser exatamente `true` (gesto explícito do usuário)
 */
export async function applyProposal(db, id, { userConfirmed } = {}) {
  if (userConfirmed !== true) throw new Error('Esta alteração exige a confirmação explícita do usuário.');
  const proposal = getProposal(id);
  if (!proposal) throw new Error('Proposta não encontrada (ela só existe enquanto a página está aberta).');
  if (proposal.status !== 'pending') throw new Error(`Esta proposta já foi ${proposal.status === 'applied' ? 'aplicada' : 'cancelada'}.`);
  const result = await setCategory(db, proposal.transactionIds, proposal.categoryId, { remember: proposal.remember });
  markApplied(id);
  return result;
}
