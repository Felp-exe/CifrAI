// As quatro skills do agente. Cada skill agrupa ferramentas de um assunto; a documentação de cada uma
// está em skills/<id>/SKILL.md (na raiz do projeto).
import categorizacao from './categorizacao.js';
import analiseFinanceira from './analiseFinanceira.js';
import monitoramentoOrcamento from './monitoramentoOrcamento.js';
import ciclosRecebimento from './ciclosRecebimento.js';

export const SKILLS = [categorizacao, analiseFinanceira, monitoramentoOrcamento, ciclosRecebimento];
