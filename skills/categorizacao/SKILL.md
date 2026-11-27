---
name: categorizacao
description: Identifica transações sem categoria, consulta as regras existentes, sugere classificações, aponta possíveis erros de categorização e PROPÕE correções que só são aplicadas com a confirmação do usuário.
---

# Skill 1 — Categorização de transações

## Objetivo
Ajudar o usuário a manter as transações bem classificadas, sem nunca alterar dados por conta própria.

## Quando usar
Perguntas como: "quais transações estão pendentes de categorização?", "sugira categorias", "há erros de categorização?", "quais são minhas regras?", "categorizar iFood como Alimentação".

## Ferramentas (todas somente leitura)
| Ferramenta | O que faz |
|---|---|
| `get_pending_transactions` | Lista as transações pendentes de revisão, com categoria atual, sugestão, confiança e motivo. |
| `suggest_categorization` | Recalcula a sugestão (categoria, confiança, motivo) para transações específicas ou para as pendentes. **Não altera nada.** |
| `find_categorization_issues` | Aponta possíveis erros: mesmo estabelecimento em categorias diferentes; correção manual que contradiz uma regra forte; despesas sem categoria. |
| `get_categorization_rules` | Consulta as regras existentes (iniciais e do usuário). |
| `propose_categorization` | **Propõe** mudar a categoria de transações (e, opcionalmente, memorizar uma regra). Cria uma proposta; **não grava nada**. |

Detalhes de parâmetros: `docs/FERRAMENTAS.md`.

## Como as correções funcionam (confirmação obrigatória)
1. O assistente (modo local ou IA) chama `propose_categorization` → o resultado diz `requires_user_confirmation: true` e `applied: false`.
2. A tela mostra um cartão **"Proposta aguardando sua confirmação"** com os botões *Confirmar alteração* e *Cancelar*.
3. Só o **clique real do usuário** em "Confirmar" executa a alteração (`js/agent/proposalApply.js`). Cliques simulados por scripts são ignorados, e a função recusa chamadas sem `userConfirmed: true`.
4. A alteração usa o mesmo serviço da tela Transações (`setCategory`): a categoria fica **protegida** contra sobrescrita automática e, se pedido, **cria a regra** do estabelecimento (aprendizado a partir da correção manual).

## Regras e limites
- Correções manuais anteriores **nunca** são sobrescritas pelo recálculo automático; a proposta avisa quando vai alterar uma delas.
- Valores, datas e descrições originais nunca são tocados.
- O modelo de linguagem não tem ferramenta para gravar; a única "escrita" possível é a proposta, que depende do usuário.
- Sugestões de confiança média/baixa são apresentadas como sugestões, nunca como fatos.

## Reutiliza (sem duplicar regras)
`js/categorization/categorizer.js` (motor de regras), `merchant.js` (nome do estabelecimento), `transactionService.js` (aplicação e proteção), `ruleService.js` (memorização).

## Implementação e testes
- Código: `js/agent/skills/categorizacao.js`, `js/agent/proposals.js`, `js/agent/proposalApply.js`.
- Testes: `tests/agent.test.js` (grupo "Skill 1").
