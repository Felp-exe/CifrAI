// Registro de interpretadores (parsers) de extrato, um por formato de banco.
//
// COMO ADICIONAR UM NOVO BANCO NO FUTURO:
//   1. Crie um arquivo em js/pdf/parsers/ (ex.: nubank.js) exportando um objeto com:
//        id, name,
//        detect(lines) -> número de 0 a 1 (quão provável é que o PDF seja deste banco),
//        parse(lines)  -> { transactions, unrecognized, ignored, meta }
//      onde `lines` é uma lista de { page, text } e cada transação segue o formato de generic.js.
//   2. Importe o parser aqui e coloque na lista PARSERS.
//   Nenhuma outra parte do app precisa mudar: o parser com a maior nota em detect() é usado.
import { genericParser } from './generic.js';

export const PARSERS = [genericParser];

/** Escolhe o parser que melhor reconhece o documento e o executa. */
export function parseStatement(lines, parsers = PARSERS) {
  const ranked = parsers
    .map((parser) => ({ parser, score: parser.detect(lines) }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score <= 0) {
    return {
      parserId: null, parserName: null,
      transactions: [], unrecognized: [], ignored: [], meta: { period: null },
    };
  }
  const result = best.parser.parse(lines);
  return { parserId: best.parser.id, parserName: best.parser.name, ...result };
}
