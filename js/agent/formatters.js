// Transforma o resultado de uma ferramenta em texto legível para a tela (modo local e "dados consultados").
// Os valores NUNCA são recalculados aqui: vêm prontos do resultado ({ cents, brl }).
// Saída: { paragraphs: [texto com **negrito**], table?: { headers, rows }, notes: [texto] }
import { formatDate } from '../utils/format.js';

const B = (text) => `**${text}**`;
const pctText = (n) => `${String(n).replace('.', ',')}%`;
const SIGN = { more: 'a mais', less: 'a menos', same: 'igual' };
const LEVEL_ICON = { ok: '✓', atencao: '!', excedido: '✕' };

function empty(data) {
  const label = data.period?.label || data.month?.label || 'o período';
  const latest = data.latest_month_with_data;
  return {
    paragraphs: [`Não encontrei transações em ${B(label)}.${latest ? ` O mês mais recente com dados é ${B(latest.label)}: pergunte, por exemplo, "e em ${latest.label.split(' de ')[0]}?" ou escolha outro período.` : ' Importe um extrato para eu ter o que analisar.'}`],
    notes: [],
  };
}

const formatters = {
  get_financial_summary(r) {
    const d = r.data;
    if (d.empty) return empty(d);
    return {
      paragraphs: [
        `${B(d.period.label)}: você recebeu ${B(d.income.brl)} e gastou ${B(d.expenses_net.brl)} (despesas líquidas). Saldo do período: ${B(d.balance.brl)}.`,
        d.pending_expenses.count ? `Há ${B(d.pending_expenses.count)} despesa(s) pendentes de revisão (${d.pending_expenses.amount.brl}); as categorias delas podem mudar.` : '',
      ].filter(Boolean),
      table: {
        headers: ['Item', 'Valor'],
        rows: [['Receitas', d.income.brl], ['Despesas brutas', d.expenses_gross.brl], ['Estornos', d.refunds.brl], ['Despesas líquidas', d.expenses_net.brl], ['Saldo do período', d.balance.brl]],
      },
      notes: [],
    };
  },

  get_expenses_by_category(r) {
    const d = r.data;
    if (d.empty) return empty(d);
    if (d.category) {
      return {
        paragraphs: [d.expense_count
          ? `Em ${B(d.period.label)} você gastou ${B(d.total.brl)} com ${B(d.category.name)} (${pctText(d.percent_of_expenses)} das despesas, ${d.expense_count} lançamento(s)).`
          : `Em ${B(d.period.label)} não encontrei despesas em ${B(d.category.name)}.`],
        notes: [],
      };
    }
    return {
      paragraphs: [`Despesas de ${B(d.period.label)}: ${B(d.total_expenses.brl)}, distribuídas assim:`],
      table: { headers: ['Categoria', 'Valor', '% das despesas'], rows: d.categories.map((c) => [c.category, c.total.brl, pctText(c.percent)]) },
      notes: [],
    };
  },

  compare_periods(r) {
    const d = r.data;
    if (!d.comparable) {
      return { paragraphs: [`Não consigo comparar: não há transações em ${B(d.periods_without_data.join(' e '))}.${d.latest_month_with_data ? ` O mês mais recente com dados é ${B(d.latest_month_with_data.label)}.` : ''}`], notes: [] };
    }
    const e = d.expenses_difference;
    const rows = [
      ...d.biggest_increases.map((c) => [c.category, c.period_a.brl, c.period_b.brl, `+${c.delta.brl}`]),
      ...d.biggest_decreases.map((c) => [c.category, c.period_a.brl, c.period_b.brl, c.delta.brl]),
    ];
    return {
      paragraphs: [
        e.direction === 'same'
          ? `As despesas de ${B(d.period_a.label)} e de ${B(d.period_b.label)} foram iguais (${d.period_a.expenses_net.brl}).`
          : `Em ${B(d.period_a.label)} você gastou ${B(d.period_a.expenses_net.brl)}, contra ${B(d.period_b.expenses_net.brl)} em ${B(d.period_b.label)}: ${B(e.delta.brl.replace('-', ''))} ${SIGN[e.direction]}${e.percent === null ? '' : ` (${pctText(Math.abs(e.percent))})`}.`,
        `Receitas: ${d.period_a.income.brl} x ${d.period_b.income.brl}.`,
      ],
      table: rows.length ? { headers: ['Categoria', d.period_a.label, d.period_b.label, 'Diferença'], rows } : undefined,
      notes: [],
    };
  },

  search_transactions(r, args = {}) {
    const d = r.data;
    if (d.empty) return empty(d);
    if (!d.matched_count) return { paragraphs: ['Não encontrei transações com esses filtros.'], notes: [] };
    const first = d.transactions[0];
    const biggest = args.sort === 'amount_desc' && args.direction === 'saida';
    return {
      paragraphs: [
        biggest ? `A maior despesa em ${B(d.period.label)} foi ${B(first.amount.brl.replace('-', ''))}: ${first.description} (${formatDate(first.date)}).` : `Encontrei ${B(d.matched_count)} transação(ões) em ${B(d.period.label)}; total líquido dessas linhas: ${B(d.net_total_of_matches.brl)}.`,
      ],
      table: { headers: ['Data', 'Descrição', 'Valor', 'Categoria'], rows: d.transactions.map((t) => [formatDate(t.date), t.description, t.amount.brl, t.category || 'sem categoria']) },
      notes: [],
    };
  },

  get_top_merchants(r) {
    const d = r.data;
    if (d.empty) return empty(d);
    if (!d.merchants.length) return { paragraphs: ['Não há lançamentos desse tipo no período.'], notes: [] };
    return {
      paragraphs: [`Estabelecimentos que mais aparecem em ${B(d.period.label)} (${d.distinct_merchants} diferentes):`],
      table: { headers: ['Estabelecimento', 'Lançamentos', 'Total'], rows: d.merchants.map((m) => [m.merchant, String(m.count), m.total.brl]) },
      notes: [],
    };
  },

  get_recurring_expenses(r) {
    const d = r.data;
    if (!d.enough_data) return { paragraphs: ['Ainda não consigo identificar despesas recorrentes: preciso de dados de pelo menos 2 meses diferentes.'], notes: [] };
    if (!d.items.length) return { paragraphs: ['Não encontrei despesas recorrentes nos seus dados (mesmo estabelecimento em 2 ou mais meses com valor parecido).'], notes: [] };
    return {
      paragraphs: [`Encontrei ${B(d.items.length)} possível(is) despesa(s) recorrente(s):`],
      table: { headers: ['Estabelecimento', 'Meses', 'Valor típico'], rows: d.items.map((i) => [i.merchant, String(i.months), i.typical_amount.brl]) },
      notes: [],
    };
  },

  get_spending_trend(r) {
    const d = r.data;
    if (!d.series.length) return { paragraphs: ['Ainda não há transações para analisar.'], notes: [] };
    const label = d.category ? ` em ${d.category.name}` : '';
    const change = d.last_month_change;
    const dir = { increasing: 'aumentando', decreasing: 'diminuindo', stable: 'estável' };
    return {
      paragraphs: [
        d.enough_data && change
          ? `Seus gastos${label} estão ${B(dir[change.direction])}: variação de ${B(change.delta.brl)} (${pctText(change.percent)}) no último mês da série.`
          : `Não há dados suficientes para falar em tendência${label}.`,
      ],
      table: { headers: ['Mês', 'Despesas'], rows: d.series.map((p) => [p.label, p.total.brl]) },
      notes: [],
    };
  },

  get_spending_patterns(r) {
    const d = r.data;
    if (d.empty) return empty(d);
    if (!d.enough_data) return { paragraphs: ['Preciso de pelo menos 5 despesas no período para identificar padrões.'], notes: [] };
    return {
      paragraphs: [`Em ${B(d.period.label)}: ${d.expense_count} despesas, ticket médio de ${B(d.average_ticket.brl)}, gastos em ${d.days_with_spending} de ${d.days_in_period} dias. O dia da semana com mais gasto foi ${B(d.top_weekday.name)} (${d.top_weekday.total.brl}).`],
      table: { headers: ['Dia da semana', 'Total'], rows: d.by_weekday.map((w) => [w.weekday, w.total.brl]) },
      notes: [],
    };
  },

  get_budget_status(r) {
    const d = r.data;
    if (d.no_budgets) return { paragraphs: ['Você ainda não cadastrou orçamentos. Crie limites na aba Orçamento.'], notes: [] };
    if (d.empty) return empty(d);
    if (!d.rows.length) return { paragraphs: [`Nenhuma categoria em alerta em ${B(d.month.label)}.`], notes: [] };
    return {
      paragraphs: [`Orçamento de ${B(d.month.label)}: limite total ${d.totals.limit.brl}, gasto ${d.totals.spent.brl}, ${B(d.totals.remaining.brl)} ${d.totals.remaining.cents >= 0 ? 'ainda disponíveis' : '(excedido)'}. ${d.totals.alerts ? `${B(d.totals.alerts)} categoria(s) em alerta.` : 'Nenhuma categoria em alerta.'}`],
      table: {
        headers: ['Categoria', 'Limite', 'Gasto', 'Disponível', '% usado', 'Situação'],
        rows: d.rows.map((x) => [x.category, x.limit.brl, x.spent.brl, x.exceeded_by ? `excedido em ${x.exceeded_by.brl}` : x.available.brl, pctText(x.percent_used), `${LEVEL_ICON[x.level]} ${x.level_label}`]),
      },
      notes: [],
    };
  },

  project_budget(r) {
    const d = r.data;
    if (d.not_applicable) return { paragraphs: [r.notes[0]], notes: [] };
    if (d.no_budgets) return { paragraphs: ['Você ainda não cadastrou orçamentos.'], notes: [] };
    if (d.empty) return empty(d);
    const label = { already_exceeded: 'Já estourou', will_exceed: 'Deve estourar', on_track: 'Dentro do limite', insufficient_data: 'Poucos dados' };
    return {
      paragraphs: [`${B('Projeção')} para ${B(d.month.label)} (dia ${d.days_elapsed} de ${d.days_in_month}), assumindo que o ritmo de gasto até agora continue:`],
      table: {
        headers: ['Categoria', 'Limite', 'Gasto até hoje', 'Total estimado no mês', 'Quando atinge o limite', 'Situação'],
        rows: d.rows.map((x) => [x.category, x.limit.brl, x.spent_so_far.brl, x.projected_month_total?.brl || '—', x.estimated_limit_date ? formatDate(x.estimated_limit_date) : '—', label[x.status]]),
      },
      notes: [],
    };
  },

  list_income_sources(r) {
    const d = r.data;
    if (!d.sources.length) return { paragraphs: ['Nenhuma fonte de renda cadastrada. Cadastre em Ciclos > Rendas.'], notes: [] };
    return {
      paragraphs: [`Você tem ${B(d.sources.length)} fonte(s) de renda:`],
      table: { headers: ['Fonte', 'Valor esperado', 'Quando paga', 'Próximas datas'], rows: d.sources.map((s) => [s.name + (s.active ? '' : ' (inativa)'), s.expected_amount.brl, s.schedule, s.next_dates.map(formatDate).join(', ') || '—']) },
      notes: [],
    };
  },

  get_upcoming_income(r) {
    const d = r.data;
    if (!d.upcoming.length) return { paragraphs: [`Nenhum recebimento previsto nos próximos ${d.days_ahead} dias.`], notes: [] };
    const n = d.upcoming[0];
    return {
      paragraphs: [`O próximo recebimento é ${B(n.source)} em ${B(formatDate(n.date))} (${n.days_until === 0 ? 'hoje' : `em ${n.days_until} dia(s)`}), previsto em ${B(n.expected.brl)}.`],
      table: { headers: ['Data', 'Fonte', 'Previsto', 'Em quantos dias'], rows: d.upcoming.map((u) => [formatDate(u.date), u.source, u.expected.brl, String(u.days_until)]) },
      notes: [],
    };
  },

  get_cycle_details(r) {
    const d = r.data;
    if (!d.cycles.length) return { paragraphs: ['Não encontrei ciclos para essa consulta.'], notes: [] };
    return {
      paragraphs: d.cycles.map((c) => `${B(`${c.source} · ${formatDate(c.date)}`)} (${c.status_label}): previsto ${c.expected.brl}, recebido ${c.received.brl}; despesas comprometidas ${c.committed.brl} e realizadas ${c.realized.brl}. Disponível planejado ${B(c.available_planned.brl)}; disponível real ${B(c.available_real.brl)}${c.commitment_percent === null ? '' : `; ${pctText(c.commitment_percent)} do previsto está comprometido`}.`),
      table: { headers: ['Ciclo', 'Previsto', 'Recebido', 'Comprometido', 'Realizado', 'Disponível planejado', 'Disponível real'], rows: d.cycles.map((c) => [`${c.source} ${formatDate(c.date)}`, c.expected.brl, c.received.brl, c.committed.brl, c.realized.brl, c.available_planned.brl, c.available_real.brl]) },
      notes: [],
    };
  },

  get_upcoming_commitment(r) {
    const d = r.data;
    if (!d.cycle) return { paragraphs: ['Não encontrei um próximo recebimento. Cadastre ou ative uma fonte de renda.'], notes: [] };
    const c = d.cycle;
    return {
      paragraphs: [
        `Próximo recebimento: ${B(c.source)} em ${B(formatDate(c.date))}, previsto em ${B(c.expected.brl)}.`,
        `No seu modo de alocação atual, ${B(d.committed_in_current_mode.brl)} já estão comprometidos com ele.`,
        `Se ele pagar as despesas feitas desde o recebimento anterior, ${B(d.committed_if_next_receipt_pays_recent_expenses.brl)} (${pctText(d.percent_committed_if_next_receipt_pays_recent_expenses ?? 0)}) já estariam comprometidos e sobrariam ${B(d.available_if_next_receipt_pays_recent_expenses.brl)}.`,
      ],
      notes: [],
    };
  },

  get_pending_allocations(r) {
    const d = r.data;
    if (!d.pending_count) {
      return { paragraphs: [d.no_data_in_period ? `Não há transações em ${B(d.period.label)}.` : `Nenhuma despesa sem alocação (período: ${B(d.period.label)}): todas estão ligadas a algum ciclo.`], notes: [] };
    }
    return {
      paragraphs: [`${B(d.pending_count)} despesa(s) sem alocação em ${B(d.period.label)}, somando ${B(d.pending_total.brl)}. Elas não entram no saldo de nenhum ciclo.`],
      table: { headers: ['Data', 'Descrição', 'Valor', 'Motivo'], rows: d.items.map((i) => [formatDate(i.date), i.description, i.amount.brl, i.reason]) },
      notes: [],
    };
  },

  get_pending_transactions(r) {
    const d = r.data;
    if (!d.pending_count) return { paragraphs: ['Nenhuma transação pendente de revisão.'], notes: [] };
    return {
      paragraphs: [`${B(d.pending_count)} transação(ões) pendente(s) de revisão (despesas somam ${B(d.pending_expense_total.brl)}).`],
      table: { headers: ['Data', 'Descrição', 'Valor', 'Categoria atual', 'Sugestão'], rows: d.transactions.map((t) => [formatDate(t.date), t.description, t.amount.brl, t.current_category || 'sem categoria', t.suggested_category || '—']) },
      notes: [],
    };
  },

  suggest_categorization(r) {
    const d = r.data;
    if (!d.count) return { paragraphs: ['Não há transações para sugerir categoria.'], notes: [] };
    return {
      paragraphs: [`Sugestões para ${B(d.count)} transação(ões) (nada foi alterado):`],
      table: { headers: ['Descrição', 'Atual', 'Sugestão', 'Confiança', 'Motivo'], rows: d.suggestions.map((t) => [t.description, t.current_category || 'sem categoria', t.suggestion.category || 'revisão manual', t.suggestion.confidence, t.suggestion.reason]) },
      notes: [],
    };
  },

  find_categorization_issues(r) {
    const d = r.data;
    if (!d.issues.length && !d.counts.uncategorized_expenses) return { paragraphs: ['Não encontrei problemas de categorização.'], notes: [] };
    return {
      paragraphs: [
        `Encontrei ${B(d.counts.inconsistent_merchants)} estabelecimento(s) em categorias diferentes, ${B(d.counts.manual_vs_rule)} correção(ões) manual(is) que contradizem uma regra e ${B(d.counts.uncategorized_expenses)} despesa(s) sem categoria (${d.uncategorized_total.brl}).`,
      ],
      table: d.issues.length ? {
        headers: ['Tipo', 'Detalhe'],
        rows: d.issues.map((i) => (i.type === 'inconsistent_merchant'
          ? ['Mesmo estabelecimento, categorias diferentes', `${i.merchant}: ${i.categories.map((c) => `${c.category} (${c.transactions})`).join(', ')}`]
          : ['Correção manual x regra', `${i.description}: você escolheu ${i.current_category}; a regra indica ${i.rule_suggests}`])),
      } : undefined,
      notes: [],
    };
  },

  get_categorization_rules(r) {
    const d = r.data;
    return {
      paragraphs: [`${B(d.count)} regra(s) de categorização:`],
      table: d.count ? { headers: ['Texto', 'Como compara', 'Categoria', 'Origem', 'Ativa'], rows: d.rules.map((x) => [x.pattern, x.match, x.category, x.origin, x.active ? 'sim' : 'não']) } : undefined,
      notes: [],
    };
  },

  propose_categorization(r) {
    const d = r.data;
    const p = d.preview;
    return {
      paragraphs: [
        `Proponho colocar ${B(p.transactions)} transação(ões) em ${B(p.category)}${p.will_change < p.transactions ? ` (${p.already_in_category} já estão nela)` : ''}. ${B('Nada foi alterado ainda')}: confirme abaixo para aplicar.`,
        p.user_corrected_that_will_change ? `Atenção: ${p.user_corrected_that_will_change} delas foram corrigidas manualmente por você e mudariam.` : '',
        p.rule_would_be_created_for.length ? `Também seria criada uma regra para: ${p.rule_would_be_created_for.join(', ')}.` : '',
      ].filter(Boolean),
      notes: [],
    };
  },
};

/** Formata o resultado de uma ferramenta. Resultados com erro viram uma mensagem clara. */
export function formatToolResult(name, result, args = {}) {
  if (!result.ok) return { paragraphs: [`Não consegui fazer essa consulta: ${result.error.message}`], notes: [] };
  const base = (formatters[name] || ((r) => ({ paragraphs: [JSON.stringify(r.data)], notes: [] })))(result, args);
  return { ...base, notes: [...(base.notes || []), ...(result.notes || [])] };
}
