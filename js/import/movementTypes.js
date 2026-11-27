// Tipos de movimentação e como reconhecê-los pelo texto da descrição.
// ATENÇÃO: isto NÃO é categorização (Alimentação, Transporte...). Aqui só dizemos
// o TIPO da operação bancária (PIX, compra no débito, tarifa...) e, quando o texto
// deixa claro, se entrou ou saiu dinheiro. A categorização é da Etapa 3.
import { normalizeText } from '../utils/format.js';

export const MOVEMENT_TYPES = {
  pix_recebido: 'PIX recebido',
  pix_enviado: 'PIX enviado',
  pix: 'PIX',
  compra_debito: 'Compra no débito',
  compra: 'Compra',
  estorno: 'Estorno',
  tarifa: 'Tarifa bancária',
  saque: 'Saque',
  entrada: 'Entrada',
  saida: 'Saída',
  outro: 'Outro',
};

// Regras em ordem de prioridade: a primeira que combinar vence.
// direction: 'entrada' | 'saida' | null (null = o texto não diz).
const RULES = [
  { re: /\b(estorno|estornado|devolucao|reembolso|cashback)\b/, type: 'estorno', direction: 'entrada' },
  { re: /\bpix (recebido|receb)\b|\btransferencia recebida\b|\bted recebida\b|\bdoc recebido\b/, type: 'pix_recebido', direction: 'entrada' },
  { re: /\bpix (enviado|env|pagamento)\b|\btransferencia enviada\b|\bted enviada\b/, type: 'pix_enviado', direction: 'saida' },
  { re: /\b(tarifa|anuidade|iof|taxa)\b/, type: 'tarifa', direction: 'saida' },
  { re: /\bsaque\b/, type: 'saque', direction: 'saida' },
  { re: /\bcompra\b.*\bdeb(ito)?\b|\bdeb(ito)?\b.*\bcompra\b|\bcartao deb(ito)?\b/, type: 'compra_debito', direction: 'saida' },
  { re: /\bcompra\b/, type: 'compra', direction: 'saida' },
  { re: /\bpix\b/, type: 'pix', direction: null },
  { re: /\b(salario|deposito|rendimento|credito em conta|recebido)\b/, type: 'entrada', direction: 'entrada' },
  { re: /\b(pagamento|pagto|boleto|fatura|enviado)\b/, type: 'saida', direction: 'saida' },
];

/** Analisa a descrição e devolve { type, direction } (direction pode ser null). */
export function classifyMovement(description) {
  const text = normalizeText(description);
  for (const rule of RULES) {
    if (rule.re.test(text)) return { type: rule.type, direction: rule.direction };
  }
  return { type: 'outro', direction: null };
}
