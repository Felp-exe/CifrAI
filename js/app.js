// Ponto de partida do app: abre o banco, carrega dados iniciais e controla a navegação.
// A navegação usa o "#" do endereço (ex.: index.html#/transacoes). Isso funciona em
// qualquer hospedagem de site estático, sem precisar configurar servidor.
import { Database } from './db.js';
import { seedDefaults, syncInitialRules, syncInitialCategories } from './seed.js';
import { setSetting } from './storage.js';
import { icons } from './ui/icons.js';
import * as inicio from './ui/inicio.js';
import * as dashboard from './ui/dashboard.js';
import * as importar from './ui/importar.js';
import * as transacoes from './ui/transacoes.js';
import * as orcamento from './ui/orcamento.js';
import * as ciclos from './ui/ciclos.js';
import * as assistente from './ui/assistente.js';
import * as configuracoes from './ui/configuracoes.js';
import { migrateLegacy, recategorize } from './categorization/transactionService.js';
import { escapeHtml } from './utils/format.js';

const ROUTES = [
  { id: 'inicio', label: 'Início', desc: 'Conheça o app', title: 'CifrAI', icon: 'home', render: inicio.render, homePage: true },
  { id: 'painel', label: 'Painel', desc: 'Resumo e gráficos', icon: 'dashboard', render: dashboard.render },
  { id: 'importar', label: 'Importar', desc: 'Envie o extrato em PDF', icon: 'upload', render: importar.render },
  { id: 'transacoes', label: 'Transações', desc: 'Revise e categorize', icon: 'list', render: transacoes.render },
  { id: 'orcamento', label: 'Orçamento', desc: 'Limites por categoria', icon: 'target', render: orcamento.render },
  { id: 'ciclos', label: 'Ciclos', desc: 'Rendas e recebimentos', icon: 'cycle', render: ciclos.render },
  { id: 'assistente', label: 'Assistente', desc: 'Pergunte sobre seus gastos', icon: 'chat', render: assistente.render },
  { id: 'configuracoes', label: 'Ajustes', desc: 'Backup e limpeza de dados', title: 'Configurações e backup', icon: 'settings', render: configuracoes.render },
];

const ctx = { db: new Database() };
const main = document.getElementById('view');
const nav = document.getElementById('nav');
let navigationToken = 0;

function buildNav() {
  nav.innerHTML = ROUTES.map((r) =>
    `<a href="#/${r.id}" class="nav-item" data-route="${r.id}" title="${r.desc}">${icons[r.icon]}<span class="nav-text"><span class="nav-label">${r.label}</span><small>${r.desc}</small></span></a>`
  ).join('');
}

// Endereço no formato #/rota ou #/rota/subpagina (ex.: #/transacoes/regras).
function parseRoute() {
  const [id, sub = ''] = (location.hash.replace(/^#\/?/, '') || 'inicio').split('/');
  return { route: ROUTES.find((r) => r.id === id) || ROUTES[0], sub };
}

function errorHtml(error) {
  return `<section class="card error" role="alert"><h2>Algo deu errado</h2><p>${escapeHtml(error.message)}</p>
    <p class="micro">Seus dados não foram alterados. Tente atualizar a página (F5).</p></section>`;
}

async function navigate() {
  const token = ++navigationToken;
  const { route, sub } = parseRoute();
  nav.querySelectorAll('.nav-item').forEach((a) => {
    const active = a.dataset.route === route.id;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  document.title = route.homePage ? 'CifrAI · Controle financeiro pessoal' : `${route.title || route.label} · CifrAI`;

  // Cada tela é desenhada em um elemento PRÓPRIO. Se você trocar de tela antes de a anterior terminar
  // de carregar, o elemento antigo já saiu da página e não consegue mais "pintar por cima" da nova tela.
  const view = document.createElement('div');
  view.innerHTML = '<p class="loading" role="status">Carregando…</p>';
  main.replaceChildren(view);
  main.setAttribute('aria-busy', 'true');
  try {
    await route.render(view, { ...ctx, sub });
  } catch (error) {
    console.error(error);
    if (token === navigationToken) view.innerHTML = errorHtml(error);
  }
  if (token !== navigationToken) return;
  main.removeAttribute('aria-busy');
  main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

// Qualquer erro inesperado aparece num aviso claro (e não some em silêncio no console).
function showAppError(message) {
  const box = document.getElementById('app-error');
  box.querySelector('span').textContent = message;
  box.hidden = false;
}

function installGlobalErrorHandlers() {
  window.addEventListener('unhandledrejection', (e) => {
    console.error(e.reason);
    showAppError(`Ocorreu um erro inesperado: ${e.reason?.message || 'tente novamente'}. Seus dados não foram apagados.`);
  });
  window.addEventListener('error', (e) => {
    if (e.target && e.target !== window) return; // erros de carregamento de imagens etc.
    showAppError(`Ocorreu um erro inesperado: ${e.message}.`);
  });
  document.getElementById('app-error-close').addEventListener('click', () => { document.getElementById('app-error').hidden = true; });
}

async function start() {
  buildNav();
  installGlobalErrorHandlers();
  if (location.protocol === 'file:') {
    document.getElementById('banner').hidden = false;
  }
  ctx.db.onOutdated = () => showAppError('O app foi atualizado em outra aba. Recarregue esta página (F5) para continuar.');
  try {
    await ctx.db.open();
    await seedDefaults(ctx.db, 'data/');
    // Categorias e regras iniciais novas ou alteradas chegam aos bancos já existentes; depois as transações
    // NÃO corrigidas por você são reclassificadas (correções manuais e regras suas nunca são tocadas).
    const categoryChanges = await syncInitialCategories(ctx.db, 'data/');
    const ruleChanges = await syncInitialRules(ctx.db, 'data/');
    if (categoryChanges.added || categoryChanges.promoted || ruleChanges) {
      const reclassified = await recategorize(ctx.db);
      setSetting('rulesUpdateNotice', {
        reclassified, rules: ruleChanges, categories: categoryChanges.added, at: new Date().toISOString(),
      });
    }
    await migrateLegacy(ctx.db); // categoriza (uma vez) transações salvas por versões antigas do app
  } catch (error) {
    console.error(error);
    main.innerHTML = errorHtml(error);
    return;
  }
  window.addEventListener('hashchange', navigate);
  await navigate();
}

start();
