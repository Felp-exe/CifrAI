// Extração do NOME DO ESTABELECIMENTO a partir da descrição do extrato.
// A descrição original (ex.: "COMPRA DEBITO IFD*IFOOD SAO PAULO BR") nunca é alterada.
// Aqui geramos, à parte, um nome limpo e normalizado (ex.: "ifd ifood sao paulo")
// que serve para comparar com as regras e para "memorizar" correções do usuário.
import { normalizeText } from '../utils/format.js';

// Expressões que descrevem o TIPO da operação, não o estabelecimento. Removidas do começo.
const LEADING_NOISE = [
  'compra no debito', 'compra debito', 'compra cartao debito', 'compra cartao credito',
  'compra no credito', 'compra credito', 'compra',
  'pix enviado', 'pix recebido', 'pix pagamento', 'pix',
  'transferencia enviada', 'transferencia recebida', 'ted enviada', 'ted recebida', 'ted', 'doc',
  'pagamento de boleto', 'pagamento', 'pagto', 'debito automatico', 'debito',
].sort((a, b) => b.length - a.length);

const TRAILING_NOISE = new Set(['br', 'brasil', 'ltda', 'sa', 'me', 'eireli', 'epp']);

export function extractMerchant(description) {
  const full = normalizeText(description);
  let text = full;

  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const noise of LEADING_NOISE) {
      if (text === noise) break; // nada além do ruído: mantém para não ficar vazio
      if (text.startsWith(noise + ' ')) {
        text = text.slice(noise.length).trim();
        stripped = true;
        break;
      }
    }
  }

  const tokens = text.split(' ').filter(Boolean);
  while (tokens.length > 1 && TRAILING_NOISE.has(tokens[tokens.length - 1])) tokens.pop();
  const cleaned = tokens.filter((t) => !/^\d{6,}$/.test(t)).join(' ').trim(); // remove números longos (cartão, protocolo)
  return cleaned || full;
}
