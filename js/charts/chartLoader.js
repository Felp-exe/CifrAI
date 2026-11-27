// Carrega o Chart.js (biblioteca de gráficos copiada para lib/chartjs) e cuida do tema claro/escuro.
const SCRIPT_URL = new URL('../../lib/chartjs/chart.umd.js', import.meta.url).href;

let loading = null;

/** Carrega o Chart.js uma única vez e devolve a classe Chart. */
export function loadChart() {
  if (globalThis.Chart) return Promise.resolve(globalThis.Chart);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SCRIPT_URL;
      script.onload = () => resolve(globalThis.Chart);
      script.onerror = () => { loading = null; reject(new Error('Não consegui carregar a biblioteca de gráficos (Chart.js).')); };
      document.head.appendChild(script);
    });
  }
  return loading;
}

/** Lê as cores do tema atual (claro ou escuro) a partir das variáveis do CSS. */
export function themeColors() {
  const css = getComputedStyle(document.documentElement);
  const get = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  return {
    text: get('--text', '#0f172a'),
    muted: get('--muted', '#64748b'),
    grid: get('--border', '#e2e8f0'),
    surface: get('--surface', '#ffffff'),
    primary: get('--primary', '#0f766e'),
    positive: get('--positive', '#15803d'),
    negative: get('--negative', '#b91c1c'),
    warning: get('--warning', '#b45309'),
  };
}

/** Desenha (ou redesenha) um gráfico no canvas, destruindo o anterior se houver. */
export async function drawChart(canvas, config) {
  const Chart = await loadChart();
  Chart.getChart(canvas)?.destroy();
  return new Chart(canvas, config);
}

/** Chama `callback` quando o usuário troca entre tema claro e escuro (para redesenhar os gráficos). */
export function onThemeChange(callback) {
  const query = matchMedia('(prefers-color-scheme: dark)');
  query.addEventListener('change', callback);
  return () => query.removeEventListener('change', callback);
}
