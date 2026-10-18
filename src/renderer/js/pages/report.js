import { h, append, clear, toast } from '../dom.js';
import { t, errorMessage, locale } from '../i18n.js';
import { icon } from '../icons.js';
import { formatMoney, formatMonth, formatMonthShort, formatDate, formatDayShort, currentMonth, addMonths, moneyClass, SCALE } from '../format.js';
import { getViewedMonth, setViewedMonth } from '../month-state.js';
import { flowChart, barList } from '../charts.js';

/**
 * Monthly Report: the whole month on one page — headline numbers, daily money
 * flow, spending by category, top products, every product bought and a
 * day-by-day journal — plus a styled Excel export.
 */
export function mountReport(container, ctx) {
  const { call, navigate } = ctx;
  let month = getViewedMonth();
  let report = null;
  let chart = null;
  let flowAsTable = false;
  let sort = { key: 'total', dir: -1 };
  let filter = '';
  let lastExport = null;

  const monthBar = h('div', { class: 'month-bar' });
  const kpiGrid = h('div', { class: 'kpi-grid', id: 'report-kpis' });
  const flowCard = h('section', { class: 'card report-card', id: 'report-flow' });
  const categoryCard = h('section', { class: 'card report-card', id: 'report-categories' });
  const topCard = h('section', { class: 'card report-card', id: 'report-top' });
  const productsCard = h('section', { class: 'card report-card', id: 'report-products' });
  const journalCard = h('section', { class: 'card report-card', id: 'report-journal' });
  const page = h('div', { class: 'page report-page' }, monthBar, kpiGrid, flowCard, h('div', { class: 'report-grid' }, categoryCard, topCard), productsCard, journalCard);
  container.append(page);

  const money = (minor, opts) => formatMoney(minor, opts);
  const pct = (ratio) => new Intl.NumberFormat(locale(), { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(ratio);
  const compact = (minor, digits = 2) => new Intl.NumberFormat(locale(), { notation: 'compact', maximumSignificantDigits: digits }).format(minor / SCALE);
  const productLabel = (p) => (p.standard ? `${p.name} · ${p.standard}` : p.name);

  function cardHeader(title, subtitle, ...tools) {
    return h('div', { class: 'report-card-header' }, h('div', {}, h('h3', {}, title), subtitle ? h('p', { class: 'muted small' }, subtitle) : null), h('div', { class: 'spacer' }), ...tools);
  }

  async function load() {
    page.classList.add('is-loading');
    try {
      report = await call('report:month', { month });
      setViewedMonth(month);
      render();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      page.classList.remove('is-loading');
    }
  }

  function changeMonth(m) {
    month = m;
    load();
  }

  function render() {
    renderMonthBar();
    renderKpis();
    renderFlow();
    renderCategories();
    renderTop();
    renderProducts();
    renderJournal();
  }

  // ---- header -----------------------------------------------------------------
  function renderMonthBar() {
    clear(monthBar);
    append(monthBar, [
      h('button', { class: 'btn btn-icon', id: 'report-prev', title: t('purchases.prevMonth'), onclick: () => changeMonth(addMonths(month, -1)) }, icon('left')),
      h('h2', { class: 'month-title', id: 'report-month' }, formatMonth(month)),
      h('button', { class: 'btn btn-icon', id: 'report-next', title: t('purchases.nextMonth'), onclick: () => changeMonth(addMonths(month, 1)) }, icon('right')),
      month !== currentMonth() ? h('button', { class: 'btn btn-ghost', onclick: () => changeMonth(currentMonth()) }, t('purchases.thisMonth')) : null,
      report.status.confirmed
        ? h('span', { class: 'badge badge-confirmed' }, icon('lock', { size: 13 }), t('purchases.statusConfirmed'))
        : h('span', { class: 'badge badge-open' }, icon('unlock', { size: 13 }), t('purchases.statusOpen')),
      h('div', { class: 'spacer' }),
      lastExport
        ? h('button', { class: 'btn btn-ghost', id: 'report-open-export', title: lastExport, onclick: () => call('report:openExport').catch((e) => toast(errorMessage(e), 'error')) }, t('report.openExport'))
        : null,
      h('button', { class: 'btn btn-primary', id: 'report-export', onclick: exportExcel }, icon('download', { size: 16 }), t('report.export')),
    ]);
  }

  async function exportExcel() {
    try {
      const res = await call('report:exportExcel', { month });
      if (res.canceled) return;
      lastExport = res.file;
      renderMonthBar();
      toast(t('report.exported', { file: res.file }), 'success', 6000);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  // ---- headline numbers -----------------------------------------------------------
  function tile(id, label, value, { valueClass = '', sub = null, delta = null } = {}) {
    return h(
      'div',
      { class: 'kpi', id },
      h('span', { class: 'kpi-label' }, label),
      h('span', { class: `kpi-value ${valueClass}` }, value),
      delta,
      sub ? h('span', { class: 'kpi-sub' }, sub) : null
    );
  }

  function renderKpis() {
    const s = report.summary;
    clear(kpiGrid);
    let delta = null;
    if (s.spentChange !== null) {
      const up = s.spentChange > 0;
      const same = s.spentChange === 0;
      delta = h(
        'span',
        { class: `kpi-delta ${same ? '' : up ? 'delta-bad' : 'delta-good'}` },
        same ? null : icon(up ? 'arrowUp' : 'arrowDown', { size: 13 }),
        t('report.vsLastMonth', { change: pct(Math.abs(s.spentChange)), month: formatMonthShort(report.prevMonth) })
      );
    }
    append(kpiGrid, [
      tile('kpi-carry', t('purchases.sumCarryOver'), money(s.carryOver, { symbol: true }), { sub: t('report.fromMonth', { month: formatMonthShort(report.prevMonth) }) }),
      tile('kpi-in', t('purchases.sumFundIn'), money(s.fundIn, { symbol: true }), { sub: t('purchases.countRecords', { count: s.fundInCount }) }),
      tile('kpi-spent', t('purchases.sumSpent'), money(s.spent, { symbol: true }), {
        delta,
        sub: s.spentChange === null ? t('report.noComparison') : null,
      }),
      tile('kpi-balance', t('purchases.sumBalance'), money(s.balance, { symbol: true }), {
        valueClass: s.balance < 0 ? 'amount-minus' : '',
        sub: report.status.confirmed ? t('report.carriedTo', { month: formatMonthShort(report.nextMonth) }) : t('purchases.statusOpen'),
      }),
      tile('kpi-purchases', t('report.kpi.purchases'), String(s.purchaseCount), {
        sub: t('report.itemsProducts', { items: s.lineCount, products: s.productCount }),
      }),
      tile('kpi-avg', t('report.kpi.avgPerDay'), money(s.avgDailySpend, { symbol: true }), {
        sub: s.daysCounted ? t('report.overDays', { count: s.daysCounted }) : t('report.notStarted'),
      }),
    ]);
  }

  // ---- daily money flow ---------------------------------------------------------
  function renderFlow() {
    if (chart) chart.destroy();
    chart = null;
    clear(flowCard);
    const toggle = h(
      'button',
      {
        class: 'btn btn-small',
        id: 'report-flow-toggle',
        onclick: () => {
          flowAsTable = !flowAsTable;
          renderFlow();
        },
      },
      flowAsTable ? t('report.showChart') : t('report.showTable')
    );
    flowCard.append(cardHeader(t('report.flowTitle'), t('report.flowSubtitle'), toggle));
    if (flowAsTable) {
      flowCard.append(dailyTable());
      return;
    }
    const host = h('div', { class: 'flow-host', id: 'report-flow-chart' });
    flowCard.append(host);
    chart = flowChart(host, {
      days: report.days,
      fmtMoney: (v) => money(v, { symbol: true }),
      fmtCompact: compact,
      fmtDay: (d) => formatDate(d),
      labels: {
        spentTitle: t('report.spentPerDay'),
        balanceTitle: t('report.balanceOverMonth'),
        balance: t('purchases.sumBalance'),
        fundIn: t('purchases.sumFundIn'),
        carryOver: t('purchases.sumCarryOver'),
        spentRow: (count) => `${t('purchases.sumSpent')} · ${t('report.purchaseCount', { count })}`,
      },
    });
  }

  function dailyTable() {
    const dash = (v) => (v ? money(v) : '—');
    return h(
      'div',
      { class: 'table-scroll report-table-scroll' },
      h(
        'table',
        { class: 'grid report-table', id: 'report-daily-table' },
        h(
          'thead',
          {},
          h('tr', {}, h('th', {}, t('common.date')), h('th', { class: 'num' }, t('purchases.sumFundIn')), h('th', { class: 'num' }, t('purchases.sumSpent')), h('th', { class: 'num' }, t('report.kpi.purchases')), h('th', { class: 'num' }, t('purchases.sumBalance')))
        ),
        h(
          'tbody',
          {},
          report.days.map((d) =>
            h(
              'tr',
              { class: d.spent || d.fundIn || d.carryOver ? '' : 'row-quiet' },
              h('td', {}, formatDayShort(d.date)),
              h('td', { class: `num ${d.fundIn ? 'amount-plus' : ''}` }, dash(d.fundIn + d.carryOver)),
              h('td', { class: `num ${d.spent ? 'amount-minus' : ''}` }, dash(d.spent)),
              h('td', { class: 'num' }, d.purchaseCount || '—'),
              h('td', { class: 'num' }, d.balance === null ? '' : money(d.balance))
            )
          )
        )
      )
    );
  }

  // ---- categories & top products ------------------------------------------------------
  function emptyState(text) {
    return h('p', { class: 'empty-state' }, text);
  }

  function renderCategories() {
    clear(categoryCard);
    categoryCard.append(cardHeader(t('report.byCategory'), t('report.byCategorySubtitle')));
    if (!report.categories.length) return categoryCard.append(emptyState(t('report.noPurchases')));
    const rows = [];
    for (const c of report.categories) {
      rows.push({ label: c.name ?? t('products.uncategorized'), value: c.spent, valueText: money(c.spent), shareText: pct(c.share), title: t('report.lineCount', { count: c.lineCount }) });
      for (const child of c.children) {
        rows.push({ label: child.name ?? t('report.directly'), value: child.spent, valueText: money(child.spent), shareText: pct(child.share), child: true });
      }
    }
    categoryCard.append(barList(rows, { max: report.categories[0].spent }));
  }

  function renderTop() {
    clear(topCard);
    topCard.append(cardHeader(t('report.topProducts'), t('report.topProductsSubtitle')));
    if (!report.products.length) return topCard.append(emptyState(t('report.noPurchases')));
    const top = report.products.slice(0, 8);
    topCard.append(
      barList(
        top.map((p) => ({
          label: p.name,
          sub: p.standard || null,
          value: p.total,
          valueText: money(p.total),
          shareText: `×${p.qty}`,
          title: `${productLabel(p)} — ${t('report.purchaseCount', { count: p.purchaseCount })}`,
        }))
      )
    );
  }

  // ---- all products ---------------------------------------------------------------
  const COLUMNS = [
    { key: 'name', label: () => t('products.name') },
    { key: 'standard', label: () => t('products.standard') },
    { key: 'categoryPath', label: () => t('products.category') },
    { key: 'purchaseCount', label: () => t('report.kpi.purchases'), num: true },
    { key: 'qty', label: () => t('report.col.quantity'), num: true },
    { key: 'avgPrice', label: () => t('report.col.avgPrice'), num: true },
    { key: 'range', label: () => t('report.col.priceRange'), num: true, sortable: false },
    { key: 'total', label: () => t('report.col.spent'), num: true },
    { key: 'share', label: () => t('report.col.share'), num: true },
    { key: 'lastDate', label: () => t('report.col.lastDate') },
  ];

  function sortedProducts() {
    const q = filter.trim().toLowerCase();
    const list = report.products.filter((p) => !q || [p.name, p.standard, p.categoryPath || ''].some((v) => v.toLowerCase().includes(q)));
    const { key, dir } = sort;
    return [...list].sort((a, b) => {
      const x = a[key] ?? '';
      const y = b[key] ?? '';
      const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return cmp * dir || a.name.localeCompare(b.name);
    });
  }

  let productsBody;
  let productsFoot;
  let productsCount;

  function renderProducts() {
    clear(productsCard);
    const search = h('input', {
      type: 'search',
      class: 'input-search',
      id: 'report-product-search',
      placeholder: t('products.searchPlaceholder'),
      value: filter,
      oninput: () => {
        filter = search.value;
        fillProducts();
      },
    });
    productsCount = h('span', { class: 'muted small' });
    productsCard.append(cardHeader(t('report.allProducts'), t('report.allProductsSubtitle'), productsCount, search));
    if (!report.products.length) return productsCard.append(emptyState(t('report.noPurchases')));
    productsBody = h('tbody');
    productsFoot = h('tfoot');
    const head = h(
      'tr',
      {},
      COLUMNS.map((c) => {
        const activeSort = sort.key === c.key;
        const label = c.label();
        if (c.sortable === false) return h('th', { class: c.num ? 'num' : '' }, label);
        return h(
          'th',
          { class: c.num ? 'num' : '', 'aria-sort': activeSort ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none' },
          h(
            'button',
            {
              class: `th-sort${activeSort ? ' active' : ''}`,
              dataset: { sort: c.key },
              onclick: () => {
                sort = { key: c.key, dir: activeSort ? -sort.dir : c.num ? -1 : 1 };
                renderProducts();
              },
            },
            label,
            activeSort ? icon(sort.dir > 0 ? 'arrowUp' : 'arrowDown', { size: 12 }) : null
          )
        );
      })
    );
    productsCard.append(h('div', { class: 'table-scroll report-table-scroll' }, h('table', { class: 'grid report-table', id: 'report-products-table' }, h('thead', {}, head), productsBody, productsFoot)));
    fillProducts();
  }

  function fillProducts() {
    if (!productsBody) return;
    const list = sortedProducts();
    clear(productsBody);
    clear(productsFoot);
    productsCount.textContent = t('products.count', { count: list.length });
    for (const p of list) {
      productsBody.append(
        h(
          'tr',
          { dataset: { product: p.productId } },
          h('td', {}, p.name),
          h('td', { class: p.standard ? '' : 'muted' }, p.standard || '—'),
          h('td', { class: p.categoryPath ? 'muted' : 'muted' }, p.categoryPath || t('products.uncategorized')),
          h('td', { class: 'num' }, p.purchaseCount),
          h('td', { class: 'num' }, p.qty),
          h('td', { class: 'num' }, money(p.avgPrice)),
          h('td', { class: 'num muted' }, p.minPrice === p.maxPrice ? money(p.minPrice) : `${money(p.minPrice)} – ${money(p.maxPrice)}`),
          h('td', { class: 'num strong' }, money(p.total)),
          h('td', { class: 'num' }, pct(p.share)),
          h('td', {}, formatDate(p.lastDate, { weekday: false }))
        )
      );
    }
    const qty = list.reduce((sum, p) => sum + p.qty, 0);
    const total = list.reduce((sum, p) => sum + p.total, 0);
    const share = list.reduce((sum, p) => sum + p.share, 0);
    productsFoot.append(
      h(
        'tr',
        {},
        h('td', { colspan: 4 }, t('report.col.total')),
        h('td', { class: 'num' }, qty),
        h('td', {}),
        h('td', {}),
        h('td', { class: 'num', id: 'report-products-total' }, money(total, { symbol: true })),
        h('td', { class: 'num' }, pct(share)),
        h('td', {})
      )
    );
  }

  // ---- journal -----------------------------------------------------------------------
  function renderJournal() {
    clear(journalCard);
    journalCard.append(cardHeader(t('report.journal'), t('report.journalSubtitle')));
    if (!report.journal.length) return journalCard.append(emptyState(t('purchases.empty')));
    const tbody = h('tbody');
    for (const day of report.journal) {
      const facts = [];
      if (day.spent) facts.push(h('span', { class: 'amount-minus' }, `${t('purchases.sumSpent')} ${money(day.spent)}`));
      if (day.fundIn) facts.push(h('span', { class: 'amount-plus' }, `${t('purchases.sumFundIn')} ${money(day.fundIn)}`));
      tbody.append(
        h(
          'tr',
          { class: 'journal-day' },
          h('td', { colspan: 5 }, h('span', { class: 'journal-date' }, formatDate(day.date)), ...facts.map((f) => [' · ', f])),
          h('td', { class: 'num muted', colspan: 2 }, `${t('purchases.sumBalance')} ${money(day.balance ?? 0)}`)
        )
      );
      for (const e of day.entries) {
        if (e.kind === 'fund') {
          const carry = e.fundType === 0;
          tbody.append(
            h(
              'tr',
              { class: 'journal-entry' },
              h(
                'td',
                { colspan: 5 },
                h('span', { class: `tag ${carry ? 'tag-carry' : 'tag-fund'}` }, carry ? t('funds.typeCarryOver') : t('funds.typeInput')),
                carry ? t('purchases.carriedOverFrom', { month: e.sourceMonth ? formatMonth(e.sourceMonth) : '' }) : e.summary || ''
              ),
              h('td', { class: `num amount ${moneyClass(e.amount)}` }, money(e.amount, { sign: true })),
              h('td', { class: 'num running' }, money(e.runningBalance))
            )
          );
          continue;
        }
        tbody.append(
          h(
            'tr',
            { class: 'journal-entry journal-purchase', dataset: { purchase: e.id } },
            h(
              'td',
              { colspan: 5 },
              h(
                'button',
                { class: 'btn-link journal-open', title: t('report.openInPurchases'), onclick: () => navigate(`purchases?month=${month}&purchase=${e.id}`) },
                e.summary || t('purchases.noSummary')
              ),
              h('span', { class: 'muted small item-count' }, t('purchases.itemCount', { count: e.items.length }))
            ),
            h('td', { class: `num amount ${e.cost ? 'amount-minus' : 'amount-zero'}` }, money(-e.cost, { sign: true })),
            h('td', { class: 'num running' }, money(e.runningBalance))
          )
        );
        for (const it of e.items) {
          tbody.append(
            h(
              'tr',
              { class: 'journal-item' },
              h('td', { class: 'journal-item-name' }, it.name),
              h('td', { class: it.standard ? '' : 'muted' }, it.standard || '—'),
              h('td', { class: 'muted small' }, it.categoryPath || t('products.uncategorized')),
              h('td', { class: 'num' }, `${money(it.price)} × ${it.count}`),
              h('td', { class: 'num' }, money(it.total)),
              h('td', {}),
              h('td', {})
            )
          );
        }
      }
    }
    journalCard.append(
      h(
        'div',
        { class: 'table-scroll report-table-scroll' },
        h(
          'table',
          { class: 'grid report-table journal-table', id: 'report-journal-table' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              h('th', {}, t('purchases.description')),
              h('th', {}, t('products.standard')),
              h('th', {}, t('products.category')),
              h('th', { class: 'num' }, t('report.col.priceQty')),
              h('th', { class: 'num' }, t('items.lineTotal')),
              h('th', { class: 'num' }, t('common.amount')),
              h('th', { class: 'num' }, t('purchases.sumBalance'))
            )
          ),
          tbody
        )
      )
    );
  }

  load();
  return {
    unmount() {
      if (chart) chart.destroy();
    },
  };
}
