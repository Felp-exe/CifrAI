// Formato do arquivo de backup (JSON) e quais campos de cada tabela entram nele.
//
// Decisões:
//  - Só entram campos conhecidos ("lista branca"). O que não está na lista nunca vai para o arquivo.
//  - NÃO entram: o endereço do backend de IA, preferências da tela, chaves/credenciais (o app não tem nenhuma),
//    a linha bruta do PDF (`sourceLine`, que pode conter saldos da conta) nem a página de origem.
//  - Valores em dinheiro continuam em CENTAVOS inteiros.
export const BACKUP_FORMAT = 'cifrai-backup';
// Backups feitos antes da troca de nome (My Finance Agent) continuam sendo aceitos.
export const LEGACY_BACKUP_FORMATS = ['my-finance-agent-backup'];
export const BACKUP_VERSION = 1; // aumente ao mudar o formato; versões maiores que esta são recusadas

/** Tabelas gravadas no backup, na ordem em que são restauradas. */
export const STORES = ['categories', 'rules', 'budgets', 'incomes', 'imports', 'transactions', 'allocations', 'receiptLinks'];

export const FIELDS = {
  categories: ['id', 'nome', 'cor', 'padrao'],
  rules: ['id', 'pattern', 'matchType', 'categoryId', 'origem', 'ativa', 'observacao', 'createdAt'],
  budgets: ['id', 'categoryId', 'limit', 'month', 'createdAt'],
  incomes: ['id', 'name', 'amount', 'frequency', 'day', 'weekday', 'date', 'startDate', 'endDate', 'ativa', 'createdAt'],
  imports: ['id', 'importedAt', 'fileName', 'parserId', 'savedCount', 'skippedDuplicates', 'periodStart', 'periodEnd'],
  transactions: [
    'id', 'date', 'amount', 'type', 'originalDescription', 'normalizedName', 'merchantName', 'categoryId', 'status',
    'fingerprint', 'importId', 'suggestedCategoryId', 'categorySource', 'confidence', 'reason', 'ruleId', 'manual', 'categorizedAt',
  ],
  allocations: ['id', 'transactionId', 'cycleId', 'amount', 'createdAt'],
  receiptLinks: ['id', 'transactionId', 'cycleId', 'createdAt'],
};

/** Chaves de metadados do banco que fazem parte do backup. */
export const META_KEYS = ['seeded', 'allocationMode'];

/** Copia só os campos permitidos (e ignora os que não existem). */
export function pick(record, fields) {
  const out = {};
  for (const f of fields) if (record[f] !== undefined) out[f] = record[f];
  return out;
}

export const PERSONAL_DATA_WARNING = 'Este arquivo contém suas informações financeiras pessoais (transações, valores, descrições). '
  + 'Ele NÃO é criptografado. Guarde-o em um local seguro e não o envie para quem você não confia.';
