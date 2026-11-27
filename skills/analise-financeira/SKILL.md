---
name: analise-financeira
description: Consulta receitas e despesas, calcula o saldo do período, aponta as maiores categorias de gasto, compara períodos, identifica aumentos e reduções, padrões de consumo, despesas recorrentes e movimentações específicas.
---

# Skill 2 — Análise financeira

## Objetivo
Responder perguntas sobre o que entrou e saiu do dinheiro do usuário, sempre com números calculados pelo app a partir das transações reais.

## Quando usar
"Quanto recebi e gastei neste período?", "Quanto gastei com alimentação?", "Qual foi minha maior despesa nos últimos 30 dias?", "Quanto gastei a mais que no mês passado?", "Quais estabelecimentos mais aparecem?", "Quais são minhas despesas recorrentes?".

## Ferramentas (todas somente leitura)
| Ferramenta | O que faz |
|---|---|
| `get_financial_summary` | Receitas, despesas (brutas, estornos, líquidas), saldo do período e despesas pendentes. |
| `get_expenses_by_category` | Despesas líquidas por categoria, com percentual; ou o total de uma categoria. |
| `compare_periods` | Compara dois períodos: receitas, despesas, saldo e categorias que mais subiram/caíram. |
| `search_transactions` | Busca movimentações específicas (maior despesa, gastos em um estabelecimento, faixa de valor...). Máx. 50 linhas. |
| `get_top_merchants` | Estabelecimentos que mais aparecem (quantidade e total). |
| `get_recurring_expenses` | Despesas recorrentes (mesmo estabelecimento em 2+ meses, valor até 10% diferente). |
| `get_spending_trend` | Evolução mensal das despesas (total ou por categoria) e direção da variação. |
| `get_spending_patterns` | Padrões: ticket médio, dias com gasto, maior despesa, dia da semana com mais gasto. |

## Regras de cálculo (as mesmas do Painel)
- **Receita** = entrada que não é estorno. **Despesa** = saída. **Estorno** = entrada que devolve um gasto: **abate as despesas**, não é receita.
- **Despesas líquidas** = despesas brutas − estornos. **Saldo do período** = receitas − despesas líquidas.
- O saldo **não é o saldo bancário**: não sabemos quanto havia na conta antes das transações importadas. Toda resposta carrega esse aviso.
- Valores em centavos inteiros; o modelo recebe os valores já formatados (`R$ 1.234,56`).

## Quando não há dados
- Período sem transações → `empty: true` e a indicação do mês mais recente com dados. **Não** se usa outro período silenciosamente.
- Recorrência precisa de pelo menos 2 meses; tendência, de despesas em pelo menos 2 meses; padrões, de pelo menos 5 despesas. Senão: `enough_data: false` com explicação.
- Comparações com mês em andamento avisam que um mês parcial favorece o período menor.

## Reutiliza (sem duplicar regras)
`js/dashboard/analytics.js` (totais, categorias), `js/dashboard/insights.js` (recorrência), `js/dashboard/period.js` (períodos).

## Implementação e testes
- Código: `js/agent/skills/analiseFinanceira.js`.
- Testes: `tests/agent.test.js` (grupo "Skill 2").
