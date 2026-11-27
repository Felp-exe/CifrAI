# Arquitetura do agente financeiro

## Em uma frase
O assistente **entende a pergunta, escolhe uma ferramenta, o app calcula com os dados reais e só então a resposta é montada**. Nenhum número vem da "cabeça" de um modelo de linguagem.

## Fluxo

```
            ┌──────────────── NAVEGADOR (seus dados ficam aqui) ────────────────┐
 Pergunta   │                                                                    │
 ─────────► │  orchestrator.js ──► escolhe o modo                                │
            │      │                                                             │
            │      ├─ MODO LOCAL ──► localAgent.js (regras) ──┐                  │
            │      │                                          ▼                  │
            │      │                              executeToolCall()  ◄── valida parâmetros
            │      │                                          │                  │
            │      └─ MODO IA ─► aiAgent.js ─► backend ─► LLM │  (só ferramentas │
            │            ▲              │     (chave de API)  │   declaradas)    │
            │            │      pede ferramenta ──────────────┘                  │
            │            │                                    ▼                  │
            │            │        skills/*.js (JavaScript) ── lê a FOTOGRAFIA    │
            │            │        somente leitura (snapshot.js) do IndexedDB     │
            │            │                                    │                  │
            │            └──── resultado estruturado ◄────────┘                  │
            │                         │                                          │
            │             resposta ◄──┘  (texto + tabela + "dados consultados")  │
            └────────────────────────────────────────────────────────────────────┘
```

No **modo IA**, o caminho é: Usuário → LLM (via backend) → intenção → ferramenta → JavaScript local → resultado estruturado → LLM → resposta. O LLM só vê o texto da conversa, a lista de ferramentas e os **resultados resumidos** delas.

## Os dois modos

| | Modo local (padrão) | IA conectada |
|---|---|---|
| Quem entende a pergunta | Regras e palavras-chave (`localAgent.js`) | Um modelo de linguagem, via backend |
| Quem calcula | Ferramentas (JavaScript) | Ferramentas (JavaScript) — **o modelo nunca calcula** |
| Quem escreve a resposta | Textos fixos (`formatters.js`) | O modelo, a partir dos resultados das ferramentas |
| Internet / backend | Não precisa | Precisa de um backend configurado |
| Rótulo na tela | "Modo local · sem IA generativa" | "IA conectada · endereço do backend" |
| Pode afirmar que usa LLM? | **Nunca** | Só quando o backend está configurado e respondeu |

**Sem backend configurado, a IA não existe**: o botão do modo IA fica desabilitado. Se o backend cair durante uma pergunta, a resposta vem do modo local **com um aviso explícito** de que a IA não respondeu.

## Peças (pasta `js/agent/`)

| Arquivo | Papel |
|---|---|
| `skills/*.js` | As 4 skills; cada uma declara suas ferramentas (nome, esquema de parâmetros, código). |
| `tools.js` | Registro e execução: valida parâmetros, recusa ferramentas desconhecidas, trata erros, limita o tamanho do resultado. |
| `validate.js` | Validador de parâmetros (tipos, enums, limites, formato). |
| `snapshot.js` | "Fotografia" **congelada** dos dados que as ferramentas recebem (nunca o banco). |
| `periodParam.js` | Converte "mês passado", "últimos 30 dias" etc. em datas (feito em JavaScript, não pelo modelo). |
| `results.js` | Formato padrão dos resultados (`{cents, brl}`, `ok`, `fail`). |
| `localAgent.js` + `formatters.js` | Modo local: intenção por regras e texto das respostas. |
| `llm/backendClient.js` | Cliente do backend (contrato em `docs/API-BACKEND.md`), com validação de respostas. |
| `llm/aiAgent.js` | Laço de tool calling (máx. 5 passos). |
| `orchestrator.js` | Escolhe o modo, trata falhas, lê configurações. |
| `proposals.js` / `proposalApply.js` | Propostas de alteração e sua aplicação (somente pela interface, com confirmação). |

As skills **não duplicam cálculos**: usam `dashboard/analytics.js`, `budget/budgetEngine.js`, `cycles/model.js`, `categorization/*` etc., os mesmos módulos que alimentam as telas.

## Modelo de segurança

1. **Sem acesso ao banco**: ferramentas recebem uma cópia congelada (`Object.freeze`). Tentar alterá-la gera erro.
2. **Somente leitura por padrão**: nenhuma das 20 ferramentas grava. Um teste automático varre o código das skills procurando operações de escrita.
3. **Alterações só com confirmação**: a única "escrita" é `propose_categorization`, que apenas cria uma proposta em memória. Aplicar exige o **clique real** do usuário (`isTrusted`) e `userConfirmed: true` em `applyProposal`. Esse módulo **não é importado** pelo registro de ferramentas.
4. **Parâmetros validados** antes de qualquer execução; ferramentas inexistentes (`apply_*`, `delete_*`...) são recusadas.
5. **Nenhuma chave de API no navegador**: o app não tem campo para isso. Só o endereço do backend é guardado (LocalStorage); a chave fica no servidor do backend. Um teste varre os arquivos do front-end atrás de padrões de chave.
6. **Backend é "não confiável" para o app**: toda resposta é validada (formato, tamanho, número de chamadas). O endereço precisa ser `https://` (ou `http://localhost`), sem usuário/senha e sem `?parâmetros`.
7. **Privacidade**: ao backend vão só a conversa, as definições das ferramentas e os resultados (limitados a 12 000 caracteres, no máximo 50 linhas de transações). Nunca PDFs, extratos completos ou o banco. A tela mostra os resultados enviados em "Dados consultados".
8. **Texto da IA é sempre escapado** antes de ir para a tela (nada de HTML vindo do modelo).
9. **Sem laço infinito**: no máximo 5 rodadas de ferramentas por pergunta.

## Por que as ferramentas rodam no navegador?
Porque os dados financeiros estão no IndexedDB do usuário. Rodar as ferramentas lá evita enviar o histórico para um servidor: o backend recebe apenas o que cada consulta devolve.

## Como adicionar uma ferramenta
1. Escreva `{ name, description, parameters, handler(snapshot, params) }` em uma skill (`js/agent/skills/`), reutilizando módulos existentes. Retorne `ok(...)` e valores com `money()`.
2. Lance `ToolError` para erros esperados. Nunca escreva no banco.
3. Se quiser que o modo local a reconheça, acrescente uma intenção em `localAgent.js` e um formatador em `formatters.js`.
4. Documente em `skills/<skill>/SKILL.md` e rode `tests/tests.html`. O catálogo `docs/FERRAMENTAS.md` pode ser regenerado a partir do código.

## Limitações conhecidas
- O modo local entende um conjunto limitado de perguntas (por regras). Perguntas livres exigem o modo IA.
- Não há backend de IA incluído: o contrato e as instruções estão prontos, mas **nenhum LLM está conectado** neste projeto.
- Propostas ficam só na memória da página: se você atualizar a página antes de confirmar, elas somem.
