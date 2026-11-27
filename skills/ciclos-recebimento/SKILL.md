---
name: ciclos-recebimento
description: Consulta fontes de renda, próximos recebimentos, ciclos ativos e anteriores, despesas comprometidas e realizadas, despesas sem alocação, valor disponível por ciclo e o comprometimento de cada recebimento.
---

# Skill 4 — Gestão de ciclos de recebimento

## Objetivo
Mostrar como cada recebimento (salário, adiantamento, renda extra...) está sendo usado pelas despesas.

## Quando usar
"Quais são meus próximos recebimentos?", "Quanto do meu próximo salário já está comprometido?", "Como está o ciclo atual?", "Quais despesas ainda não foram alocadas?", "Quais são minhas fontes de renda?".

## Ferramentas (todas somente leitura)
| Ferramenta | O que faz |
|---|---|
| `list_income_sources` | Fontes de renda: valor, frequência, ativa/inativa, próximas datas. |
| `get_upcoming_income` | Próximos recebimentos previstos a partir de hoje. |
| `get_cycle_details` | Ciclo atual, próximo, anterior ou de um mês: previsto, recebido, comprometido, realizado, disponível e % comprometido. |
| `get_upcoming_commitment` | Quanto do **próximo** recebimento já está comprometido. |
| `get_pending_allocations` | Despesas sem alocação válida a um ciclo (não entram no saldo de nenhum ciclo). |

## Vocabulário (igual ao app)
- **Previsto**: valor esperado da fonte de renda. **Recebido**: entradas do extrato ligadas ao ciclo.
- **Comprometidas**: despesas pagas **antes** do recebimento, contando com ele. **Realizadas**: pagas **depois**.
- **Disponível planejado** = previsto − despesas alocadas. **Disponível real** = recebido − despesas alocadas.
- Esses saldos **não são o saldo bancário**.

## A pergunta "quanto do meu próximo salário já está comprometido?"
No modo de alocação *Automático por data*, nenhuma despesa é atribuída a um recebimento futuro (cada despesa vai para o recebimento anterior). Por isso `get_upcoming_commitment` devolve **dois números**, sem esconder a diferença:
1. o comprometido **no modo atual do usuário**;
2. o comprometido **se o próximo recebimento pagar as despesas feitas desde o recebimento anterior** (simulação com o modo *Próximo recebimento*), com percentual e valor que sobraria.

## Quando não há dados
Sem fontes de renda → erro `no_income_sources` ("cadastre em Ciclos > Rendas"). Sem ciclo para a consulta → lista vazia com explicação. Dia 30 em fevereiro usa o último dia do mês (regra do app).

## Reutiliza (sem duplicar regras)
`js/cycles/model.js` (`buildModel`), `allocation.js`, `receipts.js`, `summary.js`, `incomeSchedule.js`.

## Implementação e testes
- Código: `js/agent/skills/ciclosRecebimento.js`.
- Testes: `tests/agent.test.js` (grupo "Skill 4").
