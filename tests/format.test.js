import { test, assertEqual } from './runner.js';
import { toCents, fromCents, formatBRL, formatDate, monthKey, monthLabel, escapeHtml, normalizeText } from '../js/utils/format.js';

test('formato: reais viram centavos sem erro de arredondamento', () => {
  assertEqual(toCents(12.34), 1234);
  assertEqual(toCents(0.1) + toCents(0.2), 30, 'soma 0,10 + 0,20:');
  assertEqual(toCents(19.99), 1999);
});

test('formato: centavos voltam para reais', () => {
  assertEqual(fromCents(1234), 12.34);
});

test('formato: moeda brasileira (R$)', () => {
  assertEqual(formatBRL(123456), 'R$ 1.234,56');
  assertEqual(formatBRL(0), 'R$ 0,00');
  assertEqual(formatBRL(-5000), '-R$ 50,00');
});

test('formato: datas em padrão brasileiro', () => {
  assertEqual(formatDate('2026-03-05'), '05/03/2026');
  assertEqual(formatDate('lixo'), '');
  assertEqual(monthKey('2026-03-05'), '2026-03');
  assertEqual(monthLabel('2026-03'), 'março de 2026');
});

test('formato: HTML é neutralizado (segurança)', () => {
  assertEqual(escapeHtml('<script>x</script>'), '&lt;script&gt;x&lt;/script&gt;');
});

test('formato: nome normalizado do estabelecimento', () => {
  assertEqual(normalizeText('  IFD*iFood São Paulo-BR '), 'ifd ifood sao paulo br');
});
