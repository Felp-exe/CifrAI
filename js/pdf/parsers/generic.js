// Interpretador genérico: serve para extratos em que cada movimentação ocupa uma linha
// com DATA no começo e VALOR em algum ponto (formato brasileiro). Ex.:
//   03/03/2026 PIX RECEBIDO JOAO SILVA 250,00 1.750,00
// Princípio central: NUNCA inventar. O que não der para identificar com segurança vira
// aviso (ou fica em branco) para o usuário decidir na tela de revisão.
import { moneyPattern, fromMatch } from '../../utils/money.js';
import { classifyMovement } from '../../import/movementTypes.js';
import { normalizeText } from '../../utils/format.js';

const DATE_AT_START = /^\s*(\d{2})\/(\d{2})(?:\/(\d{4}|\d{2}))?(?!\d)/;
const PERIOD = /(\d{2})\/(\d{2})\/(\d{4})\s*(?:a|até|ate|-|à)\s*(\d{2})\/(\d{2})\/(\d{4})/i;
const BALANCE_LINE = /\bsaldo\b/;

export const genericParser = {
  id: 'generico',
  name: 'Formato genérico (data + descrição + valor)',

  /** Nota de 0 a 1: quão bem este formato combina com o documento. */
  detect(lines) {
    const candidates = lines.filter((l) => DATE_AT_START.test(l.text) && hasMoney(l.text)).length;
    return candidates > 0 ? 0.1 : 0; // baixo de propósito: formatos específicos devem vencer
  },

  parse(lines) {
    const period = findPeriod(lines);
    const transactions = [];
    const unrecognized = [];
    const ignored = [];

    for (const { page, text } of lines) {
      const hasDate = DATE_AT_START.test(text);
      const moneyMatches = [...text.matchAll(moneyPattern())];

      if (BALANCE_LINE.test(normalizeText(text)) && (hasDate || moneyMatches.length)) {
        ignored.push({ page, text, reason: 'Linha de saldo (não é uma movimentação)' });
        continue;
      }
      if (hasDate && moneyMatches.length) {
        transactions.push(buildTransaction({ page, text, moneyMatches, period }));
      } else if (hasDate) {
        unrecognized.push({ page, text, reason: 'Tem data, mas não encontrei um valor' });
      } else if (moneyMatches.length) {
        unrecognized.push({ page, text, reason: 'Tem valor, mas não encontrei uma data no início da linha' });
      }
      // Linhas só com texto (cabeçalhos, rodapés) são ignoradas em silêncio.
    }

    return { transactions, unrecognized, ignored, meta: { period } };
  },
};

function hasMoney(text) {
  return moneyPattern().test(text);
}

/** Procura "Período: 01/03/2026 a 31/03/2026" no documento. */
function findPeriod(lines) {
  for (const { text } of lines) {
    const m = text.match(PERIOD);
    if (m) {
      return { start: `${m[3]}-${m[2]}-${m[1]}`, end: `${m[6]}-${m[5]}-${m[4]}` };
    }
  }
  return null;
}

function buildTransaction({ page, text, moneyMatches, period }) {
  const warnings = [];
  const [, dd, mm, yy] = text.match(DATE_AT_START);

  // ---- Data ----
  const dateInfo = resolveDate(Number(dd), Number(mm), yy, period);
  warnings.push(...dateInfo.warnings);

  // ---- Valor: usamos o PRIMEIRO valor da linha; os demais costumam ser saldo ----
  const first = fromMatch(moneyMatches[0]);
  if (moneyMatches.length > 1) {
    const others = moneyMatches.slice(1).map((m) => m[0].trim()).join(' / ');
    warnings.push({
      level: 'atencao', code: 'varios_valores',
      message: `A linha tem mais de um valor. Usei o primeiro (${moneyMatches[0][0].trim()}) como valor da movimentação e ignorei "${others}", que parece ser o saldo. Confira.`,
    });
  }

  // ---- Descrição: o texto da linha sem a data e sem os valores ----
  let description = text.replace(DATE_AT_START, ' ');
  for (const m of moneyMatches) description = description.replace(m[0], ' ');
  description = description.replace(/\s+/g, ' ').trim();
  if (!description) {
    warnings.push({ level: 'atencao', code: 'sem_descricao', message: 'Não encontrei descrição nesta linha.' });
  }

  // ---- Entrada ou saída: sinal/C-D > palavras da descrição > desconhecido ----
  const fromText = classifyMovement(description);
  let direction = null;
  let directionSource = null;
  if (first.suffix) {
    direction = first.suffix === 'C' ? 'entrada' : 'saida';
    directionSource = 'cd';
  } else if (first.negative) {
    direction = 'saida';
    directionSource = 'sinal';
  } else if (fromText.direction) {
    direction = fromText.direction;
    directionSource = 'palavra';
  }

  if (directionSource && directionSource !== 'palavra' && fromText.direction && fromText.direction !== direction) {
    warnings.push({
      level: 'atencao', code: 'sinal_diverge',
      message: 'O sinal do valor e as palavras da descrição indicam direções diferentes. Usei o sinal. Confira.',
    });
  }
  if (!direction) {
    warnings.push({
      level: 'bloqueio', code: 'sem_direcao',
      message: 'Não consegui saber se é entrada ou saída (o valor não tem sinal e a descrição não diz). Escolha na revisão.',
    });
  } else if (directionSource === 'palavra') {
    warnings.push({
      level: 'info', code: 'direcao_por_palavra',
      message: 'Entrada/saída identificada pelas palavras da descrição (o valor não tinha sinal).',
    });
  }

  return {
    page,
    rawLine: text,
    dateRaw: `${dd}/${mm}${yy ? '/' + yy : ''}`,
    date: dateInfo.iso,                 // null se não foi possível determinar
    day: Number(dd), month: Number(mm), // guardados para o usuário informar o ano depois
    absAmount: first.cents,             // sempre positivo, em centavos
    direction,                          // 'entrada' | 'saida' | null
    directionSource,
    type: fromText.type,
    originalDescription: description,   // texto exatamente como veio do PDF
    normalizedName: normalizeText(description),
    warnings,
  };
}

/** Descobre a data completa sem inventar o ano. */
function resolveDate(day, month, yearText, period) {
  const warnings = [];
  const make = (year) => {
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const d = new Date(Date.UTC(year, month - 1, day));
    const valid = d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
    return valid ? iso : null;
  };

  if (yearText) {
    const year = yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText);
    if (yearText.length === 2) {
      warnings.push({ level: 'info', code: 'ano_2_digitos', message: `Ano com 2 dígitos (${yearText}) interpretado como ${year}.` });
    }
    const iso = make(year);
    if (!iso) warnings.push({ level: 'bloqueio', code: 'data_invalida', message: 'A data lida não existe no calendário. Corrija na revisão.' });
    return { iso, warnings };
  }

  // Sem ano na linha: só usamos o ano do período do cabeçalho do extrato, se existir.
  if (period) {
    const years = [...new Set([Number(period.start.slice(0, 4)), Number(period.end.slice(0, 4))])];
    const candidates = years.map(make).filter(Boolean).filter((iso) => iso >= period.start && iso <= period.end);
    if (candidates.length === 1) {
      warnings.push({ level: 'info', code: 'ano_do_periodo', message: 'A linha não tinha ano; usei o ano do período do cabeçalho do extrato.' });
      return { iso: candidates[0], warnings };
    }
  }
  warnings.push({
    level: 'bloqueio', code: 'sem_ano',
    message: 'A data não tem ano e o extrato não informa o período. Informe o ano na revisão.',
  });
  return { iso: null, warnings };
}
