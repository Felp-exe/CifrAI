# Catálogo de ferramentas do agente

> Arquivo **gerado a partir do código** (`js/agent/skills/*.js`): 20 ferramentas, todas **somente leitura**.

## Regras que valem para todas as ferramentas

1. **Parâmetros validados** (`js/agent/validate.js`): tipo, valores permitidos, limites e formato. Parâmetro desconhecido ou inválido → erro `invalid_parameters`, a ferramenta nem executa.
2. **Ferramenta inexistente** (inclusive nomes como `apply_categorization` ou `delete_transaction`) → erro `unknown_tool`.
3. **Somente leitura**: as ferramentas recebem uma *fotografia congelada* dos dados (`js/agent/snapshot.js`), nunca o banco de dados. Nada é gravado.
4. **Valores prontos**: dinheiro vem como `{ "cents": 12345, "brl": "R$ 123,45" }`. O modelo não calcula nem formata.
5. **Ausência de dados** nunca é preenchida com palavras genéricas: o resultado traz `empty: true`, `enough_data: false` ou uma nota explicando.
6. **Erros** voltam como `{ "ok": false, "error": { "code", "message" } }`. Erros internos não vazam detalhes.
7. **Tamanho limitado**: resultados maiores que 12 000 caracteres são encurtados antes de irem ao modelo (`truncated: true`).

## Formato de resposta

```json
{ "ok": true, "data": { "...": "..." }, "notes": ["avisos para o modelo repetir ao usuário"] }
{ "ok": false, "error": { "code": "unknown_category", "message": "...", "valid_categories": ["..."] } }
```

Códigos de erro: `unknown_tool`, `invalid_parameters`, `invalid_period`, `unknown_category`, `unknown_transactions`, `no_income_sources`, `internal_error`.

## Parâmetro de período (`period`)

Objeto com **um** destes jeitos: `{ "preset": "mes_atual" | "mes_anterior" | "ultimos_30" | "ultimos_90" | "ano_atual" | "ultimo_com_dados" | "tudo" }`, `{ "month": "AAAA-MM" }` ou `{ "start": "AAAA-MM-DD", "end": "AAAA-MM-DD" }`. Padrão: `mes_atual`. As datas são calculadas pelo app, nunca pelo modelo.

## Skill: Categorização de transações

_Identifica transações sem categoria, consulta regras, sugere classificações, aponta possíveis erros e propõe correções (aplicadas só com confirmação)._  
Documentação: `skills/categorizacao/SKILL.md`

### `get_pending_transactions`

Transações pendentes de revisão/categorização, com a categoria atual e a sugestão automática.

| Parâmetro | Tipo / regras | Obrigatório |
|---|---|---|
| `limit` | integer — mín. 1; máx. 50; padrão: 15 | não |
| `only_uncategorized` | boolean — padrão: false | não |

**Retorna:** Transações pendentes de revisão com categoria atual, sugestão, confiança e motivo.

### `suggest_categorization`

Recalcula a sugestão de categoria (com motivo e confiança) para transações específicas ou para as pendentes. Não altera nada.

| Parâmetro | Tipo / regras | Obrigatório |
|---|---|---|
| `transaction_ids` | lista de integer (até 20) | não |
| `limit` | integer — mín. 1; máx. 20; padrão: 10 | não |

**Retorna:** Sugestão recalculada (categoria, confiança, motivo) para cada transação, indicando se difere da atual e se é protegida por correção manual. NÃO altera nada.

### `find_categorization_issues`

Aponta possíveis erros: mesmo estabelecimento em categorias diferentes, correção manual que contradiz uma regra forte, despesas sem categoria.

| Parâmetro | Tipo / regras | Obrigatório |
|---|---|---|
| `limit` | integer — mín. 1; máx. 20; padrão: 10 | não |

**Retorna:** Possíveis erros: mesmo estabelecimento em categorias diferentes, correção manual que contradiz uma regra forte, despesas sem categoria.

### `get_categorization_rules`

Regras de categorização existentes (iniciais e do usuário).

| Parâmetro | Tipo / regras | Obrigatório |
|---|---|---|
| `origin` | uma de: usuario, inicial | não |
| `only_active` | boolean — padrão: false | não |

**Retorna:** Regras existentes (texto, tipo de comparação, categoria, origem, ativa).

### `propose_categorization`

PROPÕE mudar a categoria de transações. NÃO altera nada: cria uma proposta que o usuário precisa confirmar na tela. Avise o usuário que a confirmação é necessária.

| Parâmetro | Tipo / regras | Obrigatório |
|---|---|---|
| `transaction_ids` | lista de integer (até 50) | sim |
| `category` | string — até 40 caracteres | sim |
| `remember` | boolean — padrão: false | não |

**Retorna:** Cria uma PROPOSTA (`proposal_id`, `requires_user_confirmation: true`, `applied: false`) com a prévia da mudança. Nada é gravado: o usuário confirma na tela.

## Skill: Análise financeira

_Consulta receitas e despesas, compara períodos, aponta maiores categorias, aumentos, reduções, padrões e recorrências._  
Documentação: `skills/analise-financeira/SKILL.md`

### `get_financial_summary`

Receitas, despesas, estornos, saldo do período e despesas pendentes de revisão. Use para "quanto recebi e quanto gastei".

| Parâmetro | Tipo / regras | Obrigatório |
|---|---|---|
| `period` | objeto (período) | não |

**Retorna:** Receitas, despesas brutas, estornos, despesas líquidas, saldo, quantidades e despesas pendentes. Sem transações no período: `empty: true` + mês mais recente com dados.

### `get_expenses_by_category`

Despesas líquidas por categoria no período, com percentual. Com "category", devolve só o total daquela categoria.

| Parâmetro | Tipo / regras | Obrigatório |
|---|---|---|
| `period` | objeto (período) | não |
| `category` | string — até 40 caracteres | não |
| `limit` | integer — mín. 1; máx. 20; padrão: 10 | não |

**Retorna:** Lista de categorias com valor líquido e percentual (ou, com `category`, o total daquela categoria). Categoria inexistente: erro `unknown_category` com as categorias válidas.

### `compare_periods`

Compara dois períodos (receitas, despesas, saldo e categorias que mais subiram ou caíram). Ex.: este mês x mês passado.

| Parâmetro | Tipo / regras | Obrigatório |
|---|---|---|
| `period_a` | objeto (período) | sim |
| `period_b` | objeto (período) | sim |

**Retorna:** Totais dos dois períodos, diferença de despesas (direção `more`/`less`/`same` e percentual), diferença de receitas e saldo, e as categorias que mais subiram e caíram. Se um período não tem dados: `comparable: false`.

### `search_transactions`

Busca movimentações específicas (maior despesa, gastos em um estabelecimento etc.). Devolve no máximo 50 linhas.

| Parâmetro | Tipo / regras | Obrigatório |
|---|---|---|
| `query` | string — até 60 caracteres | não |
| `category` | string — até 40 caracteres | não |
| `direction` | uma de: saida, entrada, estorno | não |
| `period` | objeto (período) | não |
| `min_amount_cents` | integer — mín. 0 | não |
| `max_amount_cents` | integer — mín. 0 | não |
| `sort` | uma de: date_desc, date_asc, amount_desc, amount_asc — padrão: "date_desc" | não |
| `limit` | integer — mín. 1; máx. 50; padrão: 10 | não |

**Retorna:** Até 50 transações (id, data, descrição, estabelecimento, valor, categoria, situação) e o total líquido do que casou com os filtros.

### `get_top_merchants`

Estabelecimentos que mais aparecem (quantidade de lançamentos e total) no período.

| Parâmetro | Tipo / regras | Obrigatório |
|---|---|---|
| `period` | objeto (período) | não |
| `direction` | uma de: saida, entrada — padrão: "saida" | não |
| `limit` | integer — mín. 1; máx. 20; padrão: 10 | não |

**Retorna:** Estabelecimentos com quantidade de lançamentos e total.

### `get_recurring_expenses`

Despesas que parecem recorrentes: mesmo estabelecimento em 2+ meses com valores até 10% diferentes.

**Parâmetros:** nenhum.

**Retorna:** Estabelecimentos que aparecem em 2+ meses com valor parecido. Com menos de 2 meses de dados: `enough_data: false`.

### `get_spending_trend`

Evolução mensal das despesas (total ou de uma categoria) nos últimos meses, com variação do último mês.

| Parâmetro | Tipo / regras | Obrigatório |
|---|---|---|
| `category` | string — até 40 caracteres | não |
| `months` | integer — mín. 2; máx. 12; padrão: 3 | não |
| `until_month` | string | não |

**Retorna:** Série mensal de despesas (total ou de uma categoria), variação do último mês e direção (`increasing`/`decreasing`/`stable`, só acima de 10%). Dados insuficientes: `enough_data: false`.

### `get_spending_patterns`

Padrões de consumo no período: ticket médio, maior despesa, dia da semana em que mais gasta, dias com gasto.

| Parâmetro | Tipo / regras | Obrigatório |
|---|---|---|
| `period` | objeto (período) | não |

**Retorna:** Ticket médio, dias com gasto, maior despesa, dia da semana com mais gasto. Menos de 5 despesas: `enough_data: false`.

## Skill: Monitoramento de orçamento

_Compara limites e gastos, aponta categorias em alerta, calcula o valor disponível e projeta o ritmo de gasto._  
Documentação: `skills/monitoramento-orcamento/SKILL.md`

### `get_budget_status`

Orçamentos do mês: limite, gasto, valor disponível, percentual consumido e alerta (em dia, próximo do limite, ultrapassado).

| Parâmetro | Tipo / regras | Obrigatório |
|---|---|---|
| `month` | string | não |
| `category` | string — até 40 caracteres | não |
| `only_alerts` | boolean — padrão: false | não |

**Retorna:** Por categoria: limite, gasto, disponível (ou excedente), percentual e alerta; totais do mês. Mês sem transações: `empty: true`. Sem orçamentos: `no_budgets: true`.

### `project_budget`

PROJEÇÃO do mês em andamento: ritmo diário de gasto, total estimado até o fim do mês e data estimada para atingir o limite.

| Parâmetro | Tipo / regras | Obrigatório |
|---|---|---|
| `month` | string | não |
| `category` | string — até 40 caracteres | não |

**Retorna:** PROJEÇÃO (`is_projection: true`) só para o mês em andamento: ritmo diário, total estimado e data estimada de atingir o limite. Poucos dados: `insufficient_data`.

## Skill: Gestão de ciclos de recebimento

_Fontes de renda, próximos recebimentos, ciclos, despesas comprometidas/realizadas, pendências de alocação e valor disponível._  
Documentação: `skills/ciclos-recebimento/SKILL.md`

### `list_income_sources`

Fontes de renda cadastradas (nome, valor esperado, frequência, próximas datas).

**Parâmetros:** nenhum.

**Retorna:** Fontes de renda com valor, frequência, se está ativa e as próximas datas.

### `get_upcoming_income`

Próximos recebimentos previstos a partir de hoje.

| Parâmetro | Tipo / regras | Obrigatório |
|---|---|---|
| `days` | integer — mín. 1; máx. 365; padrão: 60 | não |
| `limit` | integer — mín. 1; máx. 20; padrão: 5 | não |
| `source` | string — até 40 caracteres | não |

**Retorna:** Próximos recebimentos (data, fonte, valor, dias até lá) e o total esperado na janela.

### `get_cycle_details`

Detalhes de ciclos: previsto, recebido, despesas comprometidas e realizadas, valor disponível (planejado e real) e percentual comprometido.

| Parâmetro | Tipo / regras | Obrigatório |
|---|---|---|
| `when` | uma de: current, next, last, month — padrão: "current" | não |
| `month` | string | não |
| `source` | string — até 40 caracteres | não |

**Retorna:** Ciclos: previsto, recebido, comprometido, realizado, disponível planejado e real, percentual comprometido e as maiores despesas alocadas.

### `get_upcoming_commitment`

Quanto do PRÓXIMO recebimento já está comprometido por despesas feitas antes dele (ex.: "quanto do meu próximo salário já está comprometido?").

| Parâmetro | Tipo / regras | Obrigatório |
|---|---|---|
| `source` | string — até 40 caracteres | não |

**Retorna:** Quanto do próximo recebimento já está comprometido no modo de alocação em uso e numa simulação com o modo "Próximo recebimento".

### `get_pending_allocations`

Despesas sem alocação válida a um ciclo de recebimento (não entram no saldo de nenhum ciclo).

| Parâmetro | Tipo / regras | Obrigatório |
|---|---|---|
| `period` | objeto (período) | não |
| `limit` | integer — mín. 1; máx. 50; padrão: 20 | não |

**Retorna:** Despesas sem alocação válida a um ciclo, com o motivo.

