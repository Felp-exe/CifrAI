// Formato padrão dos resultados das ferramentas.
// Os valores em dinheiro vão SEMPRE prontos: { cents: 12345, brl: "R$ 123,45" }.
// Assim o modelo de linguagem nunca precisa calcular nem formatar valores: só repetir o que veio.
import { formatBRL } from '../utils/format.js';

export const money = (cents) => ({ cents, brl: formatBRL(cents) });

export const pct = (n) => Math.round(n * 10) / 10; // 1 casa decimal

export const ok = (data, notes = []) => ({ ok: true, data, notes });

export const fail = (code, message, extra = {}) => ({ ok: false, error: { code, message, ...extra } });

/** Erro "esperado" dentro de uma ferramenta (vira { ok: false } para o chamador). */
export class ToolError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}
