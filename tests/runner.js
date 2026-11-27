// Mini executor de testes (sem bibliotecas externas).
// Cada teste é uma função; se ela lançar erro, o teste falhou.
const tests = [];

export function test(name, fn) { tests.push({ name, fn }); }

export function assert(condition, message = 'Condição falsa') {
  if (!condition) throw new Error(message);
}

export function assertEqual(actual, expected, message = '') {
  if (actual !== expected) {
    throw new Error(`${message} esperado ${JSON.stringify(expected)}, recebido ${JSON.stringify(actual)}`.trim());
  }
}

export async function runAll(listEl, summaryEl) {
  let passed = 0;
  const failures = [];
  for (const { name, fn } of tests) {
    const li = document.createElement('li');
    try {
      await fn();
      passed++;
      li.className = 'pass';
      li.textContent = `✔ ${name}`;
    } catch (error) {
      failures.push({ name, error: error.message });
      li.className = 'fail';
      li.textContent = `✘ ${name} — ${error.message}`;
    }
    listEl.appendChild(li);
  }
  const result = { total: tests.length, passed, failed: failures.length, failures, protocol: location.protocol };
  summaryEl.textContent = `${passed} de ${tests.length} testes passaram` + (failures.length ? ` (${failures.length} falharam)` : '');
  summaryEl.className = failures.length ? 'fail' : 'pass';
  window.__testResults = result; // permite ler o resultado automaticamente
  return result;
}
