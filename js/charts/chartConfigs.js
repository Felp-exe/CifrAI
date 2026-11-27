// Monta a configuração de cada gráfico (Chart.js) a partir dos números já calculados.
// Cada função devolve { config, summary, table }:
//   config  -> o que o Chart.js desenha;
//   summary -> frase curta que descreve o gráfico (leitor de tela e "texto alternativo");
//   table   -> os mesmos dados em tabela (alternativa acessível e "ver detalhes").
// Os cálculos são em centavos; só aqui os valores viram reais (centavos / 100), que é o que o Chart.js espera.
import { formatBRL, formatDate } from '../utils/format.js';
import { LEVEL_LABEL } from '../budget/budgetEngine.js';

const MONTHS_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
export const shortMonth = (key) => { const [y, m] = key.split('-'); return `${MONTHS_SHORT[Number(m) - 1]}/${y.slice(2)}`; };
const reais = (cents) => cents / 100;
const brlFromReais = (v) => formatBRL(Math.round(v * 100));
const pctText = (n) => `${n.toFixed(1).replace('.', ',')}%`;

function baseOptions(colors, extra = {}) {
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: reduce ? false : { duration: 350 },
    color: colors.text,
    plugins: {
      legend: { labels: { color: colors.text, boxWidth: 14 } },
      tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${brlFromReais(ctx.parsed.y ?? ctx.parsed.x ?? ctx.parsed)}` } },
    },
    ...extra,
  };
}

const moneyAxis = (colors, axis = 'y', extra = {}) => ({
  [axis]: {
    ticks: { color: colors.muted, callback: (v) => brlFromReais(v) },
    grid: { color: colors.grid },
    ...extra,
  },
});
const labelAxis = (colors, axis = 'x', extra = {}) => ({
  [axis]: { ticks: { color: colors.muted }, grid: { display: false }, ...extra },
});

// ------------------------------------------------------------------ 1) Receitas x despesas
export function incomeVsExpenses(series, colors) {
  const labels = series.map((s) => shortMonth(s.month));
  return {
    config: {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Receitas', data: series.map((s) => reais(s.income)), backgroundColor: colors.positive, borderRadius: 4 },
          { label: 'Despesas', data: series.map((s) => reais(s.expensesNet)), backgroundColor: colors.negative, borderRadius: 4 },
        ],
      },
      options: baseOptions(colors, { scales: { ...labelAxis(colors), ...moneyAxis(colors, 'y', { beginAtZero: true }) } }),
    },
    summary: `Receitas e despesas por mês. ${series.map((s) => `${shortMonth(s.month)}: receitas ${formatBRL(s.income)}, despesas ${formatBRL(s.expensesNet)}`).join('; ')}.`,
    table: {
      headers: ['Mês', 'Receitas', 'Despesas (líquidas)', 'Saldo'],
      rows: series.map((s) => [shortMonth(s.month), formatBRL(s.income), formatBRL(s.expensesNet), formatBRL(s.balance)]),
    },
  };
}

// ------------------------------------------------------------------ 2) Despesas por categoria
export function categoryDoughnut(list, colors) {
  return {
    config: {
      type: 'doughnut',
      data: {
        labels: list.map((c) => c.name),
        datasets: [{ data: list.map((c) => reais(c.value)), backgroundColor: list.map((c) => c.color), borderColor: colors.surface, borderWidth: 2 }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '60%',
        color: colors.text,
        plugins: {
          legend: { display: false }, // a legenda é uma lista em HTML, com valor e percentual
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.label}: ${brlFromReais(ctx.parsed)} (${pctText(list[ctx.dataIndex].percent)})`,
            },
          },
        },
      },
    },
    summary: `Despesas por categoria. ${list.map((c) => `${c.name}: ${formatBRL(c.value)} (${pctText(c.percent)})`).join('; ')}.`,
    table: {
      headers: ['Categoria', 'Valor', '% das despesas'],
      rows: list.map((c) => [c.name, formatBRL(c.value), pctText(c.percent)]),
    },
  };
}

// ------------------------------------------------------------------ 3) Evolução do saldo
export function balanceLine(series, colors) {
  const label = (key) => (series.granularity === 'dia' ? formatDate(key).slice(0, 5) : shortMonth(key));
  const points = series.points;
  return {
    config: {
      type: 'line',
      data: {
        labels: points.map((p) => label(p.key)),
        datasets: [{
          label: 'Saldo acumulado do período',
          data: points.map((p) => reais(p.balance)),
          borderColor: colors.primary, backgroundColor: colors.primary, pointRadius: points.length > 40 ? 0 : 3,
          tension: 0.2, fill: false,
        }],
      },
      options: baseOptions(colors, { scales: { ...labelAxis(colors, 'x', { ticks: { color: colors.muted, maxTicksLimit: 8 } }), ...moneyAxis(colors) } }),
    },
    summary: points.length
      ? `Saldo acumulado do período, começando em zero. Terminou em ${formatBRL(points[points.length - 1].balance)} após ${points.length} ${series.granularity === 'dia' ? 'dias com movimentação' : 'meses'}. Não é o saldo bancário.`
      : 'Sem movimentações no período.',
    table: {
      headers: [series.granularity === 'dia' ? 'Dia' : 'Mês', 'Movimento', 'Saldo acumulado'],
      rows: points.map((p) => [series.granularity === 'dia' ? formatDate(p.key) : shortMonth(p.key), formatBRL(p.flow), formatBRL(p.balance)]),
    },
  };
}

// ------------------------------------------------------------------ 4) Evolução dos gastos
export function spendingBars(trend, colors) {
  const tone = (t) => (t.delta === null ? colors.primary : t.delta > 0 ? colors.negative : colors.positive);
  const changeText = (t) => (t.delta === null ? 'primeiro mês exibido'
    : `${t.delta > 0 ? 'aumento' : t.delta < 0 ? 'redução' : 'igual'} de ${formatBRL(Math.abs(t.delta))}${t.deltaPercent === null ? '' : ` (${pctText(Math.abs(t.deltaPercent))})`}`);
  return {
    config: {
      type: 'bar',
      data: {
        labels: trend.map((t) => shortMonth(t.month)),
        datasets: [{ label: 'Despesas', data: trend.map((t) => reais(t.expenses)), backgroundColor: trend.map(tone), borderRadius: 4 }],
      },
      options: baseOptions(colors, {
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => `Despesas: ${brlFromReais(ctx.parsed.y)}`, afterLabel: (ctx) => changeText(trend[ctx.dataIndex]) } },
        },
        scales: { ...labelAxis(colors), ...moneyAxis(colors, 'y', { beginAtZero: true }) },
      }),
    },
    summary: `Despesas por mês. ${trend.map((t) => `${shortMonth(t.month)}: ${formatBRL(t.expenses)} (${changeText(t)})`).join('; ')}.`,
    table: {
      headers: ['Mês', 'Despesas', 'Variação', 'Variação %'],
      rows: trend.map((t) => [
        shortMonth(t.month), formatBRL(t.expenses),
        t.delta === null ? '—' : `${t.delta > 0 ? '+' : t.delta < 0 ? '−' : ''}${formatBRL(Math.abs(t.delta))}`,
        t.deltaPercent === null ? '—' : `${t.deltaPercent > 0 ? '+' : t.deltaPercent < 0 ? '−' : ''}${pctText(Math.abs(t.deltaPercent))}`,
      ]),
    },
  };
}

// ------------------------------------------------------------------ 5) Orçamento por categoria
export function budgetBars(rows, categoriesById, colors) {
  const name = (r) => categoriesById.get(r.categoryId)?.nome || r.categoryId;
  // Cores fixas por série (a legenda mostra uma cor só por série): dentro do limite = cor principal,
  // excedente = vermelho, restante = cinza claro. A situação de cada categoria fica no tooltip e na tabela.
  return {
    config: {
      type: 'bar',
      data: {
        labels: rows.map(name),
        datasets: [
          { label: 'Gasto (dentro do limite)', data: rows.map((r) => reais(Math.min(r.spent, r.limit))), backgroundColor: colors.primary, stack: 'o' },
          { label: 'Excedente', data: rows.map((r) => reais(Math.max(0, r.spent - r.limit))), backgroundColor: colors.negative, stack: 'o' },
          { label: 'Restante', data: rows.map((r) => reais(Math.max(0, r.limit - r.spent))), backgroundColor: colors.grid, stack: 'o' },
        ],
      },
      options: baseOptions(colors, {
        indexAxis: 'y',
        scales: { ...moneyAxis(colors, 'x', { stacked: true, beginAtZero: true }), ...labelAxis(colors, 'y', { stacked: true }) },
        plugins: {
          legend: { labels: { color: colors.text, boxWidth: 14 } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${brlFromReais(ctx.parsed.x)}`, afterBody: (items) => { const r = rows[items[0].dataIndex]; return `Limite ${formatBRL(r.limit)} · ${pctText(r.percent)} · ${LEVEL_LABEL[r.level]}`; } } },
        },
      }),
    },
    summary: rows.length
      ? `Orçamento por categoria. ${rows.map((r) => `${name(r)}: gasto ${formatBRL(r.spent)} de ${formatBRL(r.limit)} (${pctText(r.percent)}, ${LEVEL_LABEL[r.level].toLowerCase()})`).join('; ')}.`
      : 'Sem orçamentos cadastrados.',
    table: {
      headers: ['Categoria', 'Limite', 'Gasto', 'Restante', '% usado', 'Situação'],
      rows: rows.map((r) => [name(r), formatBRL(r.limit), formatBRL(r.spent),
        r.remaining >= 0 ? formatBRL(r.remaining) : `excedido em ${formatBRL(-r.remaining)}`, pctText(r.percent), LEVEL_LABEL[r.level]]),
    },
  };
}
