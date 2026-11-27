// Regra de segurança do navegador (Content-Security-Policy) e hábitos de código que a mantêm funcionando.
import { test, assert, assertEqual } from './runner.js';

async function text(url) {
  const r = await fetch(url);
  assert(r.ok, `não consegui ler ${url}`);
  return r.text();
}

function cspOf(html) {
  const m = html.match(/<meta[^>]+http-equiv="Content-Security-Policy"[^>]+content="([^"]+)"/i);
  assert(m, 'o index.html precisa da regra Content-Security-Policy');
  const directives = {};
  for (const part of m[1].split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) directives[name] = values;
  }
  return directives;
}

test('segurança: o index.html tem uma regra CSP restritiva (só o próprio site; sem eval; sem script inline)', async () => {
  const csp = cspOf(await text('../index.html'));
  assertEqual(csp['default-src'].join(' '), "'self'", 'default-src:');
  assertEqual(csp['script-src'].join(' '), "'self'", 'scripts só do próprio site (sem unsafe-inline/unsafe-eval):');
  assertEqual(csp['connect-src'].join(' '), "'self'", 'conexões só com o próprio site:');
  assertEqual(csp['object-src'].join(' '), "'none'", 'sem plugins:');
  assertEqual(csp['base-uri'].join(' '), "'self'", 'base-uri:');
  assertEqual(csp['worker-src'].join(' '), "'self'", 'workers só do próprio site:');
  assert(csp['style-src'].includes("'self'"), 'estilos do próprio site');
  assert(csp['img-src'].every((v) => ["'self'", 'data:'].includes(v)), 'imagens só do site ou data:');
  const all = Object.values(csp).flat();
  assert(!all.includes("'unsafe-eval'"), 'nenhum unsafe-eval');
  assert(!all.includes('*') && !all.includes('https:') && !all.includes('http:'), 'sem curingas nem esquemas inteiros');
  const unsafeInline = Object.entries(csp).filter(([, v]) => v.includes("'unsafe-inline'")).map(([k]) => k);
  assertEqual(unsafeInline.join(), 'style-src', 'unsafe-inline só em estilos (cores por atributo style):');
});

test('segurança: a página não carrega nada de fora e não usa script inline nem eventos inline', async () => {
  const html = await text('../index.html');
  assert(!/(src|href)="https?:\/\//i.test(html), 'index.html não carrega arquivos de outros endereços');
  const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)];
  assert(scripts.length >= 1, 'o app tem o script principal');
  for (const s of scripts) assert(/\bsrc="/.test(s[1]), 'todo <script> usa src (nada de código inline)');
  assert(!/\son[a-z]+\s*=/i.test(html), 'sem atributos de evento inline no HTML');

  // As telas montam HTML por texto: nenhuma pode gerar onclick="...", javascript: etc. (a regra CSP os bloquearia)
  const screens = ['inicio', 'dashboard', 'importar', 'transacoes', 'orcamento', 'ciclos', 'assistente', 'configuracoes', 'categorias', 'regras', 'rendas', 'pendencias', 'alocacao', 'components', 'dialog'];
  const problems = [];
  for (const name of screens) {
    const source = await text(`../js/ui/${name}.js`);
    if (/\son(click|change|input|submit|load|error|focus|blur|keydown|keyup)\s*=\s*["'`\\]/i.test(source)) problems.push(`${name}.js: atributo de evento inline`);
    if (/javascript:/i.test(source)) problems.push(`${name}.js: link javascript:`);
    if (/\beval\s*\(|new Function\s*\(/.test(source)) problems.push(`${name}.js: eval/new Function`);
  }
  assertEqual(problems.join(' | '), '', 'problemas:');
});

test('segurança: bibliotecas (PDF.js e Chart.js) vêm de dentro do projeto, não de CDN', async () => {
  const reader = await text('../js/pdf/pdfReader.js');
  const loader = await text('../js/charts/chartLoader.js');
  assert(!/https?:\/\//.test(reader.replace(/\/\/.*$/gm, '')), 'pdfReader.js não aponta para endereços externos');
  assert(!/https?:\/\//.test(loader.replace(/\/\/.*$/gm, '')), 'chartLoader.js não aponta para endereços externos');
  assert((await fetch('../lib/pdfjs/pdf.min.mjs')).ok && (await fetch('../lib/pdfjs/pdf.worker.min.mjs')).ok && (await fetch('../lib/chartjs/chart.umd.js')).ok, 'arquivos das bibliotecas existem no projeto');
});
