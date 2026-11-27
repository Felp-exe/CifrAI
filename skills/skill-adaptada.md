---
name: cifrai
description: Organiza as finanças pessoais a partir do extrato bancário em PDF: lê as movimentações, categoriza os gastos por regras, acompanha orçamentos e ciclos de recebimento, mostra um painel com gráficos e responde perguntas sobre os próprios dados. Roda no navegador, sem login e sem envio de dados.
---

# Skill — CifrAI (versão adaptada: aplicativo web)

## Objetivo
Ajudar qualquer pessoa a entender para onde vai o seu dinheiro, de forma visual, simples e privada. A versão implementada é um aplicativo web estático (HTML, CSS e JavaScript) que funciona no navegador, sem login, sem servidor próprio, sem banco de dados online, sem integração com bancos e sem envio de dados.

Site: https://felp-exe.github.io/CifrAI/

## Funcionalidades implementadas
- **Tela inicial** que explica o site, mostra como funciona e permite testar com um extrato de exemplo (dados fictícios).
- **Importação de extrato em PDF** lido no próprio navegador (PDF.js), com tela de revisão antes de salvar: tipo, entrada/saída, valor, data e avisos por linha, detecção de possíveis duplicadas e opção de informar o ano quando o extrato não traz.
- **Categorização automática** por regras (iniciais e do usuário), com correção manual individual ou em lote, confirmação de sugestões, memorização de correções como regras e proteção das correções manuais.
- **Categorias editáveis**: 18 categorias iniciais; criação, edição e exclusão de categorias próprias (a exclusão move as transações para outra categoria), inclusive direto da lista de transações e do orçamento pela opção "+ Nova categoria…".
- **Regras do usuário** com tipo de comparação (exato, começa com, palavra inteira, contém), ativação/desativação e prioridade sobre as regras iniciais.
- **Orçamentos mensais por categoria**, com gasto, restante, percentual e alertas.
- **Ciclos de recebimento**: fontes de renda (mensal, quinzenal, semanal ou única), recebimentos previstos x recebidos, alocação de despesas aos ciclos (automática, para o próximo recebimento ou manual) e lista de despesas sem alocação.
- **Painel**: receitas, despesas, saldo do período, despesas pendentes, orçamento utilizado, filtros de período (abre automaticamente no período do último extrato), cinco gráficos (receitas x despesas, por categoria, evolução do saldo, evolução dos gastos e orçamento) com tabela equivalente e insights calculados com os dados.
- **Assistente** com quatro skills (categorização, análise financeira, monitoramento de orçamento e ciclos de recebimento) e 20 ferramentas somente leitura. Funciona em **modo local, sem IA generativa**, e já tem a arquitetura pronta para um modelo de linguagem via backend seguro (nenhum está conectado).
- **Backup e limpeza**: exportar e restaurar dados em arquivo JSON (com validação, resumo e confirmação; substituir ou mesclar), excluir uma importação inteira e apagar todos os dados.
- **Privacidade e acessibilidade**: dados apenas no navegador (IndexedDB e LocalStorage), navegação por teclado, rótulos e contraste de texto auditados nos modos claro e escuro.

## Entradas e configurações
### Extrato
PDF com texto, baixado do app ou site do banco, em que cada movimentação ocupa uma linha com **data** no início e **valor** em formato brasileiro. PDFs escaneados (imagens) não são suportados.

### Categorias e regras
- Nome e cor da categoria.
- Regra: texto, tipo de comparação, categoria de destino e, opcionalmente, variações do texto.

### Orçamentos
Categoria e limite mensal em reais.

### Fontes de renda
Nome, valor esperado, frequência (mensal, quinzenal, semanal ou única), dia ou data e período de validade.

### Período do painel
Automático (período do último extrato), mês atual, mês anterior, últimos 30 ou 90 dias, ano atual, mês mais recente com dados ou intervalo personalizado.

## Lógica de categorização
A decisão é determinística e segue esta ordem:
1. Regras do usuário vencem as regras iniciais.
2. Entre regras do mesmo grupo vence a mais específica: nome exato, depois o texto mais longo, depois o tipo de comparação.
3. A comparação ignora maiúsculas, acentos e números extras; palavras curtas só valem como palavra inteira.
4. Sem correspondência exata, tenta uma correspondência aproximada (uma letra diferente): a transação fica **pendente** com a sugestão.
5. Sem regra: entradas não recebem categoria de gasto; saídas desconhecidas vão para "Outros" como pendentes.
6. Casos ambíguos (por exemplo, "99" sozinho ou "Mercado Pago") ficam pendentes de revisão em vez de serem adivinhados.
7. Correções manuais nunca são sobrescritas pelo recálculo automático.

## Lógica dos cálculos
- Todos os valores são guardados em **centavos inteiros**; datas como texto `AAAA-MM-DD`.
- **Gasto de um orçamento** = saídas com categoria do mês menos estornos da mesma categoria. Entradas e itens sem categoria não entram.
- **Alertas de orçamento**: até 79,9% em dia; de 80% a 100% próximo do limite; acima de 100% ultrapassado.
- **Saldo do período** = receitas − despesas líquidas dos extratos importados (não é o saldo da conta bancária).
- **Ciclo**: previsto (quanto a renda deveria pagar), recebido (o que entrou), comprometido (despesas antes do recebimento), gasto (depois) e disponível planejado/real.
- **Projeção de orçamento** (assistente): ritmo diário × dias do mês, sempre rotulada como projeção e só para o mês em andamento.

## Alertas e limitações conhecidas
- É um aplicativo local: não sincroniza com bancos, Open Finance, Google Agenda ou outros serviços.
- Lê um formato genérico de extrato (data + descrição + valor). Bancos com layout muito diferente podem exigir um novo leitor.
- Não lê o saldo da conta nem faz OCR de PDFs escaneados.
- O assistente é local, por regras: entende um conjunto limitado de perguntas e não mantém contexto de conversa. Nenhuma IA generativa está conectada.
- Os dados ficam só no navegador: limpar os dados do site ou trocar de computador os apaga. O backup (JSON) não é criptografado.
- Testado no Chrome/Edge. Firefox e Safari não foram testados, e a acessibilidade não foi validada com leitores de tela reais.
- As projeções são simples e não são previsão garantida. O app não substitui orientação financeira profissional.

## Saídas
- Lista de transações com categoria, situação (classificada ou pendente), motivo e confiança.
- Painel com indicadores, gráficos (com tabela equivalente) e insights.
- Orçamentos com percentual, restante e alertas.
- Ciclos de recebimento com previsto, recebido, comprometido e disponível.
- Respostas do assistente em texto e tabela, com a lista de "dados consultados".
- Arquivo de backup em JSON (`cifrai-backup-AAAA-MM-DD-HHMM.json`).

## Fluxo de uso
1. Abra o site e clique em **Começar agora** (ou em **Testar com um extrato de exemplo**).
2. Envie o PDF do extrato e **revise** as transações na tela de revisão.
3. Salve. O painel abre no período do extrato.
4. Corrija categorias em **Transações** (individual ou em lote) e crie categorias ou regras se precisar.
5. Defina **orçamentos** e cadastre **fontes de renda**, se quiser acompanhar ciclos.
6. Faça perguntas ao **Assistente**.
7. Exporte um **backup** de tempos em tempos; use **Ajustes** para excluir uma importação ou apagar tudo.

## Princípios
- Nada é salvo sem a pessoa revisar antes.
- O sistema nunca inventa dados: o que não é seguro fica pendente para decisão da pessoa.
- Correções manuais e regras do usuário têm prioridade e não são sobrescritas.
- O assistente só lê dados; qualquer alteração é uma **proposta** aplicada apenas por clique real da pessoa.
- Os números vêm de funções de cálculo do app, não de um modelo de linguagem.
- Os dados e os PDFs não saem do navegador; nenhuma chave de API fica no front-end.
- Ser transparente sobre limites: modo local sem IA generativa, saldo do período não é saldo bancário, projeções são estimativas.
