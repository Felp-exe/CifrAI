// Detecção de duplicidades.
// Cada transação ganha uma "impressão digital": data + valor + nome normalizado + nº de ocorrência.
// O nº de ocorrência resolve um caso real: duas compras idênticas no mesmo dia (2 cafés de R$ 5,00)
// NÃO são duplicatas, então a 1ª vira "...#1" e a 2ª "...#2". Ao reimportar o mesmo extrato,
// as impressões já existem no banco e as transações aparecem marcadas como duplicadas.

/** Impressão digital base (sem o nº de ocorrência). */
export function baseFingerprint({ date, signedAmount, normalizedName }) {
  return `${date}|${signedAmount}|${normalizedName}`;
}

/**
 * Atribui `fingerprint` e `duplicate` a cada linha da revisão.
 * @param rows linhas com { date, signedAmount, normalizedName } (date/signedAmount podem ser null)
 * @param existing Set com impressões digitais já salvas no banco
 * Linhas incompletas (sem data ou valor) ficam sem impressão digital e não são duplicadas.
 */
export function markDuplicates(rows, existing) {
  const seen = new Map();
  for (const row of rows) {
    if (!row.date || row.signedAmount === null || row.signedAmount === undefined) {
      row.fingerprint = null;
      row.duplicate = false;
      row.repeatedInFile = false;
      continue;
    }
    const base = baseFingerprint(row);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    row.fingerprint = `${base}#${n}`;
    row.duplicate = existing.has(row.fingerprint);
    row.occurrence = n;
  }
  // Marca as que aparecem mais de uma vez no próprio arquivo (apenas informativo).
  for (const row of rows) {
    if (!row.fingerprint) continue;
    row.repeatedInFile = (seen.get(baseFingerprint(row)) || 0) > 1;
  }
  return rows;
}

/** Lê do banco todas as impressões digitais já salvas. */
export async function loadExistingFingerprints(db) {
  const all = await db.getAll('transactions');
  return new Set(all.map((t) => t.fingerprint).filter(Boolean));
}
