---
name: monitoramento-orcamento
description: Consulta os orçamentos cadastrados, compara limites e gastos, identifica categorias próximas ou acima do limite, calcula o valor disponível, aponta tendências de consumo e estima (como projeção) quando um orçamento pode ser atingido.
---

# Skill 3 — Monitoramento de orçamento

## Objetivo
Dizer, com números reais, como está o consumo de cada orçamento e o que ainda está disponível.

## Quando usar
"Quanto ainda tenho disponível no orçamento?", "Quais categorias estão próximas do limite?", "Quando vou estourar o orçamento de Alimentação?", "Meus gastos com transporte estão aumentando?".

## Ferramentas (todas somente leitura)
| Ferramenta | O que faz |
|---|---|
| `get_budget_status` | Por categoria: limite, gasto, disponível (ou excedente), percentual consumido e alerta. Filtros: mês, categoria, só alertas. |
| `project_budget` | **PROJEÇÃO** para o mês em andamento: ritmo diário, total estimado até o fim do mês e data estimada de atingir o limite. |
| `get_spending_trend` (da Skill 2) | Tendência mensal das despesas de uma categoria (aumentando, diminuindo, estável). |

## Regras
- O gasto de um orçamento é o mesmo do Painel/Orçamento: **só saídas com categoria do mês**; estornos da categoria abatem; entradas e itens sem categoria não entram (a quantidade fica sinalizada).
- Alertas: até 79,9% = em dia; de 80% até 100% = próximo do limite; acima de 100% = ultrapassado.
- Despesas ainda **pendentes de revisão** dentro da categoria são sinalizadas: o valor pode mudar quando o usuário confirmar.

## Projeções (sempre rotuladas)
- Resultado traz `is_projection: true` e o aviso de que é uma **projeção simples** (assume o ritmo atual) e não uma previsão garantida.
- Fórmula: ritmo diário = gasto até hoje ÷ dias decorridos; total estimado = ritmo × dias do mês; data de atingir o limite = início do mês + (limite ÷ ritmo) dias.
- Só vale para o **mês em andamento**. Antes do 5º dia do mês, ou sem gasto na categoria, a resposta é `insufficient_data`.
- Se o último lançamento importado tem mais de 7 dias, avisa que os dados podem estar desatualizados.

## Quando não há dados
Mês sem transações → `empty: true` (não se afirma que "ainda restam R$ X" de um mês sem dados). Sem orçamentos → `no_budgets: true`.

## Reutiliza (sem duplicar regras)
`js/budget/budgetEngine.js` (`monthlyBudgetReport`, níveis de alerta).

## Implementação e testes
- Código: `js/agent/skills/monitoramentoOrcamento.js`.
- Testes: `tests/agent.test.js` (grupo "Skill 3").
