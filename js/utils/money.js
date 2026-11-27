// Leitura de valores no formato brasileiro (R$ 1.234,56).
// Regra de segurança: só aceitamos o padrão brasileiro (vírgula antes dos 2 centavos).
// "12.50" é rejeitado de propósito, porque pode ser 12,50 ou 1.250: não vamos adivinhar.

/**
 * Padrão para ENCONTRAR valores dentro de uma linha de extrato.
 * Reconhece: 1.234,56  -1.234,56  1.234,56-  (1.234,56)  R$ 1.234,56  -R$ 89,90  1.234,56 D  100,00 C
 * Grupos: 1 "-" antes | 2 "-" depois do R$ | 3 inteiro | 4 centavos | 5 "-" depois | 6 C ou D
 */
export function moneyPattern() {
  return /(\()?\s*(-)?\s*(?:R\$\s*)?(-)?\s*((?<![\d.,])\d{1,3}(?:\.\d{3})+|(?<![\d.,])\d+),(\d{2})(?!\d)(\s*-(?![\w]))?(\s*\))?(?:\s+([CD])(?![A-Za-z0-9]))?/gi;
}

/**
 * Lê UM valor em texto e devolve { cents, negative, suffix } ou null se não for um valor válido.
 * `cents` é sempre positivo; `negative` indica sinal; `suffix` é "C", "D" ou null.
 */
export function parseMoneyBR(text) {
  const clean = String(text ?? '').trim();
  if (!clean) return null;
  const matches = [...clean.matchAll(moneyPattern())];
  if (matches.length !== 1) return null;
  const parsed = fromMatch(matches[0]);
  // O texto inteiro precisa ser o valor (sem lixo ao redor).
  if (matches[0][0].trim().length !== clean.length) return null;
  return parsed;
}

/**
 * Lê um valor DIGITADO pelo usuário em formulários: "600", "600,5", "1.234,56", "R$ 600".
 * Mais flexível que parseMoneyBR (aceita sem centavos), mas ainda recusa "12.50" (ambíguo).
 * Devolve centavos (inteiro positivo) ou null.
 */
export function parseAmountInput(text) {
  const clean = String(text ?? '').replace(/R\$/gi, '').replace(/\s/g, '');
  if (!clean) return null;
  const match = clean.match(/^(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?$/);
  if (!match) return null;
  const cents = Number(match[1].replace(/\./g, '')) * 100 + Number((match[2] || '').padEnd(2, '0') || 0);
  return cents > 0 ? cents : null;
}

/** Converte um resultado de `moneyPattern()` em { cents, negative, suffix }. */
export function fromMatch(match) {
  const [, open, minusBefore, minusAfterSymbol, integer, decimals, minusTrailing, , suffix] = match;
  const cents = Number(integer.replace(/\./g, '')) * 100 + Number(decimals);
  const negative = Boolean(minusBefore || minusAfterSymbol || minusTrailing || open);
  return { cents, negative, suffix: suffix ? suffix.toUpperCase() : null };
}
