// Painel: resumo financeiro do período, gráficos (um por vez), insights, ciclos e próximos recebimentos.
// Todos os números vêm do IndexedDB (via loadDashboard) e são calculados em js/dashboard/*.
import { pageHeader, statCard } from './components.js';
import { escapeHtml, formatBRL, formatDate, monthLabel } from '../utils/format.js';
import { todayISO } from '../utils/dates.js';
import { getSetting, setSetting } from '../storage.js';
import { PRESETS, defaultPreset } from '../dashboard/period.js';
import { loadDashboard } from '../dashboard/dashboardData.js';
import { drawChart, themeColors, onThemeChange } from '../charts/chartLoader.js';
import {
  incomeVsExpenses, categoryDoughnut, balanceLine, spendingBars, budgetBars,
} from '../charts/chartConfigs.js';

const CHARTS = [
  { id: 'receitas', label: 'Receitas x despesas' },
  { id: 'categorias', label: 'Por categoria' },
  { id: 'saldo', label: 'Evolução do saldo' },
  { id: 'gastos', label: 'Evolução dos gastos' },
  { id: 'orcamento', label: 'Orçamento' },
];
const TONE_ICON = { ok: '✓', warn: '!', info: 'i', neutral: '•' };

const state = { chart: 'receitas' };
let stopThemeWatch = null;

export async function render(container, ctx) {
  stopThemeWatch?.(); // o ouvinte da tela anterior morre quando você sai e volta
  container.innerHTML = '<div></div>';
  await new DashboardView(container.firstElementChild, ctx.db).start();
}

class DashboardView {
  constructor(root, db) {
    this.root = root;
    this.db = db;
    this.today = todayISO();
  }

  async start() {
    const [txs, imports] = await Promise.all([this.db.getAll('transactions'), this.db.getAll('imports')]);
    this.preset = getSetting('dashboardPeriod') || defaultPreset(txs, this.today, imports);
    this.editingPeriod = false;
    this.custom = getSetting('dashboardCustom') || { start: '', end: '' };
    await this.load();
    this.root.addEventListener('click', (e) => this.onClick(e));
    this.root.addEventListener('change', (e) => this.onChange(e));
    stopThemeWatch = onThemeChange(() => this.paintChart());
    this.draw();
  }

  async load() {
    this.data = await loadDashboard(this.db, { preset: this.preset, custom: this.custom, today: this.today });
  }

  // ------------------------------------------------------------------ desenho
  draw() {
    const d = this.data;
    this.root.innerHTML = `
      ${pageHeader('Painel', d.valid ? `Resumo de ${d.period.label}` : 'Resumo financeiro')}
      ${this.filterHtml()}
      ${this.rulesNoticeHtml()}
      ${this.backupNoticeHtml()}
      ${this.bodyHtml()}`;
    this.paintChart();
  }

  filterHtml() {
    const d = this.data;
    const custom = this.preset === 'personalizado';
    // Período automático (do extrato): mostra só as datas e um botão "Alterar período".
    if (this.preset === 'ultimo_extrato' && !this.editingPeriod && d.valid && d.period.preset === 'ultimo_extrato') {
      return `<section class="card toolbar period-bar" aria-label="Período do extrato">
        <p class="period-auto"><strong>Período do extrato:</strong> ${formatDate(d.period.start)} a ${formatDate(d.period.end)}</p>
        <button class="btn small" type="button" data-act="edit-period">Alterar período</button>
      </section>`;
    }
    return `<section class="card toolbar period-bar" aria-label="Filtro de período">
      <label class="field"><span>Período</span>
        <select id="period">${Object.entries(PRESETS).map(([v, l]) => `<option value="${v}" ${this.preset === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      ${custom ? `
        <label class="field"><span>De</span><input type="date" id="custom-start" value="${escapeHtml(this.custom.start || '')}"></label>
        <label class="field"><span>Até</span><input type="date" id="custom-end" value="${escapeHtml(this.custom.end || '')}"></label>
        <button class="btn primary" id="apply-custom" type="button">Aplicar</button>` : ''}
      ${d.valid ? `<span class="period-range muted">${formatDate(d.period.start)} a ${formatDate(d.period.end)}</span>` : ''}
      ${!d.valid ? `<p class="w bloqueio" role="alert">${escapeHtml(d.period.error)}</p>` : ''}
    </section>`;
  }

  /** Aviso único depois que as regras de classificação são atualizadas (com a contagem de transações mudadas). */
  rulesNoticeHtml() {
    const n = getSetting('rulesUpdateNotice');
    if (!n) return '';
    return `<section class="card notice" aria-label="Regras de classificação atualizadas">
      <p><strong>As regras de classificação foram atualizadas.</strong> ${n.categories ? `${n.categories} categoria(s) nova(s) criada(s). ` : ''}
      ${n.reclassified} transação(ões) foram reclassificadas automaticamente. Suas correções manuais e regras personalizadas foram preservadas.
      Veja o que mudou em <a href="#/transacoes">Transações</a> e <a href="#/transacoes/revisao">Revisão</a>.</p>
      <button class="btn small" type="button" data-act="dismiss-rules-notice">Entendi</button></section>`;
  }

  /** Lembrete discreto: quem tem dados e não faz backup há mais de 30 dias. */
  backupNoticeHtml() {
    if (!this.data.hasTransactions) return '';
    const last = getSetting('lastBackup');
    const days = last ? Math.floor((Date.now() - Date.parse(last)) / 86400000) : null;
    if (days !== null && days <= 30) return '';
    return `<section class="card notice" aria-label="Lembrete de backup">
      <p><strong>Faça um backup dos seus dados.</strong> ${days === null ? 'Você ainda não exportou nenhum backup neste navegador.' : `Seu último backup tem ${days} dias.`}
      Se os dados do navegador forem apagados, eles não podem ser recuperados sem o arquivo.</p>
      <a class="btn small primary" href="#/configuracoes">Fazer backup</a></section>`;
  }

  bodyHtml() {
    const d = this.data;
    if (!d.hasTransactions) {
      return `<section class="card empty"><h2>Bem-vindo ao CifrAI</h2>
        <p>Ainda não há transações. Comece importando um extrato em PDF; depois cadastre orçamentos e suas fontes de renda.</p>
        <div class="action-buttons center"><a class="btn primary" href="#/importar">Importar extrato</a></div></section>`;
    }
    if (!d.valid) return '';
    if (d.isEmptyPeriod) {
      return `${this.kpiHtml()}
        <section class="card empty"><h2>Nenhuma movimentação neste período</h2>
        <p>Não há transações entre ${formatDate(d.period.start)} e ${formatDate(d.period.end)}. Escolha outro período.</p>
        <div class="action-buttons center"><button class="btn primary" type="button" data-preset="ultimo_com_dados">Ver o mês mais recente com dados</button></div></section>
        ${this.nextReceiptsHtml()}`;
    }
    return `${this.kpiHtml()}${this.chartPanelHtml()}${this.insightsHtml()}${this.nextReceiptsHtml()}`;
  }

  kpiHtml() {
    const d = this.data;
    const s = d.summary;
    const c = d.cycles.counts;
    const cycleHint = d.cycles.cycles.length
      ? [c.recebido && `${c.recebido} recebido(s)`, c.parcial && `${c.parcial} parcial(is)`, c.previsto && `${c.previsto} previsto(s)`, c.sem_recebimento && `${c.sem_recebimento} sem recebimento`].filter(Boolean).join(' · ')
      : 'nenhum recebimento no período';
    const usage = d.budgetUsage;
    return `<section class="grid kpis" aria-label="Indicadores do período">
      ${statCard({ label: 'Receitas', value: formatBRL(s.income), hint: `${s.incomeCount} entrada(s)`, tone: 'positive' })}
      ${statCard({ label: 'Despesas', value: formatBRL(s.expensesNet), hint: s.refunds ? `bruto ${formatBRL(s.expensesGross)} − estornos ${formatBRL(s.refunds)}` : `${s.expenseCount} saída(s)`, tone: 'negative' })}
      ${statCard({ label: 'Saldo do período', value: formatBRL(s.balance), hint: 'receitas − despesas (não é o saldo do banco)', tone: s.balance < 0 ? 'negative' : 'positive' })}
      ${statCard({ label: 'Despesas pendentes', value: String(s.pending.count), hint: s.pending.count ? `${formatBRL(s.pending.amount)} para revisar` : 'nada para revisar', tone: s.pending.count ? 'warning' : '' })}
      ${statCard({
        label: 'Orçamento utilizado',
        value: usage === null ? '—' : `${usage.toFixed(1).replace('.', ',')}%`,
        hint: usage === null ? 'sem orçamentos cadastrados' : `${formatBRL(d.budgetReport.totals.spent)} de ${formatBRL(d.budgetReport.totals.limit)} · ${monthLabel(d.refMonth)}`,
        tone: usage === null ? '' : usage > 100 ? 'negative' : usage >= 80 ? 'warning' : '',
      })}
      ${statCard({ label: 'Ciclos no período', value: String(d.cycles.cycles.length), hint: cycleHint })}
    </section>`;
  }

  // ------------------------------------------------------------------ gráficos
  buildChart(kind) {
    const d = this.data;
    const colors = themeColors();
    if (kind === 'receitas') return d.series.some((s) => s.income || s.expensesNet) ? incomeVsExpenses(d.series, colors) : null;
    if (kind === 'categorias') return d.byCategory.length ? categoryDoughnut(d.byCategory, colors) : null;
    if (kind === 'saldo') return d.balance.points.length ? balanceLine(d.balance, colors) : null;
    if (kind === 'gastos') return d.trend.some((t) => t.expenses) ? spendingBars(d.trend, colors) : null;
    if (kind === 'orcamento') return d.budgetReport.rows.length ? budgetBars(d.budgetReport.rows.slice().sort((a, b) => b.percent - a.percent), d.categoriesById, colors) : null;
    return null;
  }

  emptyChartText(kind) {
    return {
      receitas: 'Sem receitas nem despesas para comparar neste período.',
      categorias: 'Sem despesas neste período para dividir por categoria.',
      saldo: 'Sem movimentações neste período.',
      gastos: 'Sem despesas para comparar entre os meses.',
      orcamento: 'Você ainda não cadastrou orçamentos. Crie um na aba Orçamento.',
    }[kind];
  }

  chartPanelHtml() {
    const d = this.data;
    const built = this.buildChart(state.chart);
    const partial = d.series.some((s) => s.partial);
    const notes = {
      receitas: partial ? 'Meses marcados como parciais mostram só os dias do período escolhido.' : '',
      saldo: 'Soma acumulada das movimentações a partir de zero no início do período. Não é o saldo da conta bancária.',
      gastos: 'Vermelho = gastou mais que no mês anterior; verde = gastou menos. O mês anterior ao período entra para comparação.',
      orcamento: `Orçamentos de ${monthLabel(d.refMonth)} (último mês do período).`,
      categorias: 'Despesas líquidas: estornos abatem a categoria deles.',
    }[state.chart];

    return `<section class="card chart-card" aria-label="Gráficos">
      <div class="chart-tabs" role="group" aria-label="Escolher gráfico">
        ${CHARTS.map((c) => `<button type="button" class="chart-tab ${c.id === state.chart ? 'active' : ''}" data-chart="${c.id}" aria-pressed="${c.id === state.chart}">${c.label}</button>`).join('')}
      </div>
      ${notes ? `<p class="micro chart-note">${escapeHtml(notes)}</p>` : ''}
      ${built ? `
        <div class="chart-body ${state.chart === 'categorias' ? 'with-legend' : ''}">
          <div class="chart-wrap"><canvas id="chart" role="img" aria-label="${escapeHtml(built.summary)}"></canvas></div>
          ${state.chart === 'categorias' ? this.legendHtml() : ''}
        </div>
        <details class="chart-details"><summary>Ver os dados do gráfico em tabela</summary>
          <div class="table-card"><table class="data-table">
            <thead><tr>${built.table.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
            <tbody>${built.table.rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody>
          </table></div>
        </details>`
        : `<p class="empty-chart">${escapeHtml(this.emptyChartText(state.chart))}</p>`}
    </section>`;
  }

  legendHtml() {
    return `<ul class="legend-list" aria-label="Categorias e percentuais">
      ${this.data.byCategory.map((c) => `<li><span class="cat-dot" style="background:${escapeHtml(c.color)}"></span>
        <span class="grow">${escapeHtml(c.name)}</span><strong>${formatBRL(c.value)}</strong>
        <span class="muted">${c.percent.toFixed(1).replace('.', ',')}%</span></li>`).join('')}
    </ul>`;
  }

  async paintChart() {
    const canvas = this.root.querySelector('#chart');
    if (!canvas) return;
    const built = this.buildChart(state.chart);
    if (!built) return;
    try { await drawChart(canvas, built.config); } catch (error) {
      canvas.replaceWith(Object.assign(document.createElement('p'), { className: 'w bloqueio', textContent: error.message }));
    }
  }

  // ------------------------------------------------------------------ insights
  insightsHtml() {
    const { items, unavailable } = this.data.insights;
    return `<section class="card" aria-label="Insights">
      <h2>Insights do período</h2>
      <p class="micro">Calculados automaticamente com os seus dados (sem inteligência artificial). Só aparece o que os dados sustentam.</p>
      ${items.length ? `<ul class="insights">${items.map((i) => `<li class="insight ${i.tone}">
        <span class="insight-icon" aria-hidden="true">${TONE_ICON[i.tone] || '•'}</span>
        <div><strong>${escapeHtml(i.title)}</strong><p>${escapeHtml(i.text)}</p></div></li>`).join('')}</ul>` : '<p class="muted">Ainda não há dados suficientes para gerar insights.</p>'}
      ${unavailable.length ? `<details class="chart-details"><summary>${unavailable.length} insight(s) sem dados suficientes</summary>
        <ul class="plain-list">${unavailable.map((u) => `<li><strong>${escapeHtml(u.title)}:</strong> ${escapeHtml(u.reason)}</li>`).join('')}</ul></details>` : ''}
    </section>`;
  }

  nextReceiptsHtml() {
    const next = this.data.nextReceipts;
    return `<section class="card" aria-label="Próximos recebimentos">
      <h2>Próximos recebimentos</h2>
      ${next.length === 0 ? '<p class="muted">Nenhum recebimento previsto. <a href="#/ciclos/rendas">Cadastre uma fonte de renda</a>.</p>'
        : `<ul class="plain-list next-list">${next.map((n) => `<li><strong>${formatDate(n.date)}</strong> · ${escapeHtml(n.name)} · ${formatBRL(n.expected)}
          <span class="muted">${n.daysUntil === 0 ? 'hoje' : n.daysUntil === 1 ? 'amanhã' : `em ${n.daysUntil} dias`}</span></li>`).join('')}</ul>`}
    </section>`;
  }

  // ------------------------------------------------------------------ eventos
  async setPreset(preset) {
    this.preset = preset;
    if (preset === 'ultimo_extrato') this.editingPeriod = false;
    setSetting('dashboardPeriod', preset);
    await this.load();
    this.draw();
  }

  async onChange(e) {
    if (e.target.id === 'period') await this.setPreset(e.target.value);
  }

  async onClick(e) {
    const tab = e.target.closest('[data-chart]');
    if (tab) {
      state.chart = tab.dataset.chart;
      const panel = this.root.querySelector('.chart-card');
      panel.outerHTML = this.chartPanelHtml();
      return this.paintChart();
    }
    if (e.target.closest('[data-act="edit-period"]')) {
      this.editingPeriod = true;
      this.draw();
      return this.root.querySelector('#period')?.focus();
    }
    if (e.target.closest('[data-act="dismiss-rules-notice"]')) {
      setSetting('rulesUpdateNotice', null);
      return this.draw();
    }
    const preset = e.target.closest('[data-preset]');
    if (preset) return this.setPreset(preset.dataset.preset);
    if (e.target.id === 'apply-custom') {
      this.custom = { start: this.root.querySelector('#custom-start').value, end: this.root.querySelector('#custom-end').value };
      setSetting('dashboardCustom', this.custom);
      await this.load();
      this.draw();
    }
    return undefined;
  }
}
