# Backup e restauração

## Para que serve
Seus dados ficam no **IndexedDB do navegador**. Se você limpar os dados do site, trocar de computador ou o navegador falhar, eles podem ser perdidos. O backup é um arquivo `.json` que você guarda e pode restaurar depois.

## Privacidade
- O arquivo é gerado **no seu computador**. O app **não envia** backups para nenhum servidor ou serviço (os módulos `js/backup/` não têm código de rede; um teste automático confere isso).
- O arquivo **contém suas informações financeiras pessoais** e **não é criptografado**. Guarde-o em local seguro.
- Não entram: chaves de API ou credenciais (o app não usa nenhuma), o endereço do backend de IA, preferências da tela e o texto bruto das linhas dos PDFs (`sourceLine`, que pode conter saldos da conta).

## Como exportar
**Ajustes › Backup dos seus dados › Exportar backup (.json)**. Em Chrome/Edge abre a janela "Salvar como", onde você escolhe a pasta. Nos outros navegadores, o arquivo é baixado (o navegador pode perguntar onde salvar, conforme a configuração). Nome sugerido: `cifrai-backup-AAAA-MM-DD-HHMM.json`.

## Como restaurar
**Ajustes › Restaurar um backup**
1. Escolha o arquivo. O app valida tudo **antes de mudar qualquer coisa** e mostra um resumo (data da exportação, versão do formato, o que há no arquivo × o que há agora).
2. Escolha o modo:
   - **Substituir**: apaga os dados atuais e coloca os do backup (mesmos ids). Exige marcar a confirmação **e digitar SUBSTITUIR**.
   - **Mesclar**: acrescenta só o que ainda não existe, sem duplicar. O dado atual vence; correções manuais do backup são trazidas para transações que você ainda não corrigiu.
3. Clique em **Restaurar backup**. A operação é **tudo ou nada**: usa uma única transação do IndexedDB; se algo falhar, nada é alterado.

### Como a mesclagem evita duplicação
| Dado | Chave de comparação |
|---|---|
| Transações | impressão digital (data + valor + nome normalizado + nº de ocorrência) |
| Categorias | id |
| Regras | origem + texto + tipo de comparação |
| Orçamentos | categoria (um por categoria) |
| Fontes de renda | nome |
| Importações | id |
| Alocações e vínculos | só entram para transações **novas**, com ids e ciclos refeitos |

## Formato (versão 1)
```json
{
  "format": "cifrai-backup",
  "formatVersion": 1,
  "exportedAt": "2026-04-02T15:30:00.000Z",
  "app": { "name": "CifrAI", "databaseVersion": 3 },
  "counts": { "transactions": 120, "categories": 9, "...": 0 },
  "data": {
    "categories": [], "rules": [], "budgets": [], "incomes": [], "imports": [],
    "transactions": [], "allocations": [], "receiptLinks": []
  },
  "meta": { "seeded": true, "allocationMode": "auto" }
}
```
- Valores em dinheiro em **centavos inteiros**; datas `AAAA-MM-DD`.
- Só campos conhecidos são gravados e lidos (o resto é descartado).
- `formatVersion` maior que a suportada → o arquivo é recusado ("criado por uma versão mais nova").

## O que a validação confere
Formato e versão; data da exportação; tipos de cada campo; ids repetidos; datas que existem no calendário; valores inteiros e diferentes de zero; categorias, regras e orçamentos apontando para categorias existentes; um orçamento por categoria; rendas válidas; alocações apontando para despesas e rendas existentes e **somando exatamente o valor da despesa**; vínculos apontando para entradas existentes; tamanho máximo de 50 MB.

## Limitações
- O backup não é criptografado nem tem senha.
- O texto bruto das linhas dos PDFs (`sourceLine`) não é guardado; a descrição original do extrato **é**.
- Preferências da tela (tema do painel, modo do assistente, endereço do backend de IA) não entram no backup.
- Uma restauração por **substituição** não pode ser desfeita: exporte um backup dos dados atuais antes.
