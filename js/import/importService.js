// Orquestra a importação: PDF -> linhas -> parser -> linhas de revisão -> (revisão do usuário) -> banco.
import { extractLines } from '../pdf/pdfReader.js';
import { parseStatement } from '../pdf/parsers/index.js';
import { markDuplicates, loadExistingFingerprints } from './duplicates.js';
import { categorize, applyCategorization } from '../categorization/categorizer.js';

let nextRowId = 1;

/** Lê o PDF e prepara os dados para a tela de revisão. NADA é salvo aqui. */
export async function analyzePdf(file, db, onProgress) {
  const { pageCount, lines, charCount } = await extractLines(file, onProgress);
  const parsed = parseStatement(lines);
  const rows = parsed.transactions.map(toReviewRow);
  const existing = await loadExistingFingerprints(db);
  markDuplicates(rows, existing);
  for (const row of rows) row.selected = isSavable(row) && !row.duplicate;
  return {
    fileName: file.name,
    pageCount,
    charCount,
    parserId: parsed.parserId,
    parserName: parsed.parserName,
    period: parsed.meta.period,
    rows,
    unrecognized: parsed.unrecognized,
    ignored: parsed.ignored,
    extractedLines: lines,
  };
}

/** Converte a transação do parser em uma linha editável da revisão. */
function toReviewRow(t) {
  const row = {
    id: nextRowId++,
    selected: false,
    ...t,
    signedAmount: null,
  };
  syncSignedAmount(row);
  return row;
}

/** Recalcula o valor com sinal (entrada +, saída −) a partir do valor e da direção. */
export function syncSignedAmount(row) {
  if (row.absAmount === null || row.absAmount === undefined || !row.direction) {
    row.signedAmount = null;
  } else {
    row.signedAmount = row.direction === 'entrada' ? row.absAmount : -row.absAmount;
  }
  return row;
}

/** Motivos que impedem salvar uma linha (lista vazia = pode salvar). */
export function blockingProblems(row) {
  const problems = [];
  if (!row.date) problems.push('data');
  if (!row.absAmount || row.absAmount <= 0) problems.push('valor');
  if (!row.direction) problems.push('entrada/saída');
  return problems;
}

export function isSavable(row) {
  return blockingProblems(row).length === 0;
}

/** Aplica um ano informado pelo usuário às linhas sem ano. Retorna quantas linhas mudaram. */
export function applyYear(rows, year) {
  let changed = 0;
  for (const row of rows) {
    if (row.date || !row.day || !row.month) continue;
    const iso = `${year}-${String(row.month).padStart(2, '0')}-${String(row.day).padStart(2, '0')}`;
    const d = new Date(Date.UTC(year, row.month - 1, row.day));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== row.month - 1 || d.getUTCDate() !== row.day) continue;
    row.date = iso;
    row.warnings = row.warnings.filter((w) => w.code !== 'sem_ano');
    row.warnings.push({ level: 'info', code: 'ano_informado', message: `Ano ${year} informado por você.` });
    changed++;
  }
  return changed;
}

/**
 * Salva no banco as linhas MARCADAS e completas, de uma só vez ("tudo ou nada").
 * Recusa o salvamento se alguma linha marcada estiver incompleta.
 * As transações já entram categorizadas pelas regras (as incertas ficam "pendentes" para revisão).
 */
export async function saveReviewed(db, analysis, rows = analysis.rows) {
  const chosen = rows.filter((r) => r.selected);
  if (chosen.length === 0) throw new Error('Nenhuma transação marcada para salvar.');
  const incomplete = chosen.filter((r) => !isSavable(r));
  if (incomplete.length) {
    throw new Error(`${incomplete.length} transação(ões) marcada(s) estão incompletas. Complete ou desmarque antes de salvar.`);
  }

  // Recalcula as impressões digitais com os dados já corrigidos pelo usuário.
  markDuplicates(rows, await loadExistingFingerprints(db));

  const importId = `imp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const importedAt = new Date().toISOString();
  const skippedDuplicates = rows.filter((r) => r.duplicate && !r.selected).length;
  const period = statementPeriodOf(analysis, chosen);

  // Categorização automática (Etapa 3): usa as regras e categorias atuais do banco.
  const [rules, categories] = await Promise.all([db.getAll('rules'), db.getAll('categories')]);
  const categoryIds = new Set(categories.map((c) => c.id));
  const now = new Date().toISOString();

  await db.transact(['transactions', 'imports'], ({ transactions, imports }) => {
    for (const r of chosen) {
      const base = {
        date: r.date,
        amount: r.signedAmount,            // centavos; saída negativa
        type: r.type,
        originalDescription: r.originalDescription,
        normalizedName: r.normalizedName,
        fingerprint: r.fingerprint,
        importId,
        sourceLine: r.rawLine,
        sourcePage: r.page,
      };
      transactions.add(applyCategorization(base, categorize(base, rules, categoryIds), now));
    }
    imports.add({
      id: importId, importedAt, fileName: analysis.fileName, parserId: analysis.parserId,
      savedCount: chosen.length, skippedDuplicates,
      periodStart: period.start, periodEnd: period.end, // período do extrato (painel abre nele)
    });
  });
  return { importId, savedCount: chosen.length, skippedDuplicates, period };
}

/**
 * Período do extrato: o do cabeçalho do PDF (se informado e coerente) ou, se não, a primeira e a última data
 * das transações. Se alguma transação cair fora do período do cabeçalho, ele é ampliado para cobri-la.
 */
export function statementPeriodOf(analysis, chosen) {
  const dates = chosen.map((r) => r.date).filter(Boolean).sort();
  const header = analysis.period;
  const ok = header && header.start && header.end && header.start <= header.end;
  if (ok) {
    return {
      start: dates.length && dates[0] < header.start ? dates[0] : header.start,
      end: dates.length && dates[dates.length - 1] > header.end ? dates[dates.length - 1] : header.end,
      source: 'cabecalho',
    };
  }
  return { start: dates[0] || null, end: dates[dates.length - 1] || null, source: 'transacoes' };
}
