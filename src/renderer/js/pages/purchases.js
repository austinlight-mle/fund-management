import { h, append, clear, toast, confirmDialog } from '../dom.js';
import { t, errorMessage } from '../i18n.js';
import { icon } from '../icons.js';
import { attachAutocomplete } from '../autocomplete.js';
import {
  formatMoney,
  toInputMoney,
  parseMoney,
  parseCount,
  moneyClass,
  formatMonth,
  formatMonthShort,
  formatDate,
  formatDayShort,
  formatDateTime,
  currentMonth,
  addMonths,
  todayLocal,
  isValidDate,
} from '../format.js';
import { getViewedMonth, setViewedMonth } from '../month-state.js';

let keySeq = 0;
const newKey = () => `row${++keySeq}`;

function toDraft(items) {
  return items.map((it) => ({
    key: newKey(),
    id: it.id,
    product_id: it.product_id,
    product_name: it.product_name,
    standard: it.standard || '',
    category_name: it.category_name || '',
    priceText: toInputMoney(it.price),
    countText: String(it.count),
    editing: false,
    error: null,
    variants: null, // standards registered for this product name
    variantsFor: null, // normalized name the variants were loaded for
  }));
}

const norm = (s) => String(s ?? '').trim().toLowerCase();
const isBlankRow = (r) => r.id == null && !r.product_name.trim() && !r.priceText.trim();
const variantsKnown = (r) => Boolean(r.variants) && r.variantsFor === norm(r.product_name);
const matchingVariant = (r) => (variantsKnown(r) ? r.variants.find((v) => norm(v.standard) === norm(r.standard)) : null);

/** Links the row to the registered (name, standard) product, or marks it as new. */
function applyVariantMatch(r) {
  if (!variantsKnown(r)) return;
  const match = matchingVariant(r);
  r.product_id = match ? match.id : null;
  // A new standard of a known name takes over that name's category.
  r.category_name = match ? match.category_path || '' : r.variants[0] ? r.variants[0].category_path || '' : '';
}

function normalizedRows(rows) {
  return rows
    .filter((r) => !isBlankRow(r))
    .map((r) => [r.id ?? null, norm(r.product_name), norm(r.standard), parseMoney(r.priceText), parseCount(r.countText)]);
}

function rowTotal(r) {
  const price = parseMoney(r.priceText);
  const count = parseCount(r.countText);
  return Number.isFinite(price) && Number.isFinite(count) && price !== null && count !== null ? price * count : null;
}

function validateRow(r) {
  if (!r.product_name.trim()) return t('items.productRequired');
  // The name already has standards: pick one of them (or type a new one on purpose).
  if (variantsKnown(r) && r.variants.length && !matchingVariant(r) && !r.standard.trim()) {
    return t('items.chooseStandard', { name: r.product_name.trim() });
  }
  const price = parseMoney(r.priceText);
  if (price === null || Number.isNaN(price)) return t('items.invalidPrice');
  const count = parseCount(r.countText);
  if (count === null || Number.isNaN(count)) return t('items.invalidCount');
  return null;
}

export function mountPurchases(container, ctx) {
  const { call } = ctx;
  const S = {
    month: ctx.params.month || getViewedMonth(),
    ledger: null,
    selectedId: null,
    leftEdit: null, // { kind: 'purchase' | 'fund', id: number | null, date, summary, amountText }
    detail: null,
    original: [],
    draft: [],
  };
  let autocompletes = [];
  let disposed = false;
  let pendingFocus = null; // { el, select }: requested by a row while it is being rendered

  /**
   * Focuses the field a freshly rendered row asked for, synchronously, as soon
   * as the rows are in the page. (Deferring it to an animation frame let the
   * focus arrive late, e.g. in a throttled window, and pull it away from the
   * field the user was already typing in.)
   */
  function applyPendingFocus() {
    const p = pendingFocus;
    pendingFocus = null;
    if (!p || !p.el.isConnected) return;
    p.el.focus();
    if (p.select) p.el.select();
  }

  // ---- static layout -----------------------------------------------------
  const monthBar = h('div', { class: 'month-bar' });
  const banners = h('div', { class: 'banners' });
  const ledgerBody = h('tbody', { id: 'ledger-body' });
  const ledgerSummary = h('div', { class: 'ledger-summary', id: 'ledger-summary' });
  const itemsPane = h('section', { class: 'pane items-pane', id: 'items-pane' });

  const ledgerPane = h(
    'section',
    { class: 'pane ledger-pane' },
    h('div', { class: 'pane-header' }, h('h3', {}, t('purchases.listTitle')), h('span', { class: 'muted small' }, t('purchases.listHint'))),
    h(
      'div',
      { class: 'table-scroll' },
      h(
        'table',
        { class: 'grid ledger-table', id: 'ledger-table' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', { class: 'col-date' }, t('common.date')),
            h('th', {}, t('purchases.description')),
            h('th', { class: 'num' }, t('common.amount')),
            h('th', { class: 'num' }, t('purchases.balance')),
            h('th', { class: 'col-actions' }, '')
          )
        ),
        ledgerBody
      )
    ),
    ledgerSummary
  );

  container.append(
    h('div', { class: 'page purchases-page' }, monthBar, banners, h('div', { class: 'split' }, ledgerPane, itemsPane))
  );

  const locked = () => Boolean(S.ledger && S.ledger.status.confirmed);
  const isDirty = () => JSON.stringify(normalizedRows(S.draft)) !== JSON.stringify(normalizedRows(S.original));

  async function confirmDiscard() {
    if (!S.selectedId || !isDirty()) return true;
    return confirmDialog({
      title: t('items.unsavedTitle'),
      message: t('items.unsavedMessage'),
      confirmLabel: t('items.discard'),
      danger: true,
    });
  }

  const run = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      toast(errorMessage(err), 'error');
      return undefined;
    }
  };

  // ---- data loading ------------------------------------------------------
  async function loadLedger() {
    const ledger = await call('ledger:month', { month: S.month });
    if (disposed) return;
    S.ledger = ledger;
    setViewedMonth(S.month);
    const stillThere = ledger.entries.some((e) => e.kind === 'purchase' && e.id === S.selectedId);
    if (S.selectedId && !stillThere) {
      S.selectedId = null;
      S.detail = null;
      S.draft = [];
      S.original = [];
      renderItemsPane();
    }
    renderLeft();
  }

  async function loadDetail(id) {
    const detail = await call('purchases:get', { id });
    if (disposed) return;
    applyDetail(detail);
  }

  function applyDetail(detail) {
    S.detail = detail;
    S.original = toDraft(detail.items);
    S.draft = toDraft(detail.items);
    renderItemsPane();
  }

  async function selectPurchase(id, { force = false } = {}) {
    if (S.selectedId === id && !force) return;
    if (!force && !(await confirmDiscard())) return;
    S.selectedId = id;
    if (S.leftEdit && !(S.leftEdit.kind === 'purchase' && S.leftEdit.id === id)) S.leftEdit = null;
    renderLedgerRows();
    await run(() => loadDetail(id));
  }

  async function changeMonth(month) {
    if (!(await confirmDiscard())) return;
    S.month = month;
    S.selectedId = null;
    S.detail = null;
    S.draft = [];
    S.original = [];
    S.leftEdit = null;
    renderItemsPane();
    await run(loadLedger);
  }

  // ---- month bar and banners --------------------------------------------
  function renderMonthBar() {
    clear(monthBar);
    const { status } = S.ledger;
    const isFuture = S.month > S.ledger.currentMonth;
    append(monthBar, [
      h('button', { class: 'btn btn-icon', id: 'prev-month', title: t('purchases.prevMonth'), onclick: () => changeMonth(addMonths(S.month, -1)) }, icon('left')),
      h('h2', { class: 'month-title', id: 'month-title' }, formatMonth(S.month)),
      h('button', { class: 'btn btn-icon', id: 'next-month', title: t('purchases.nextMonth'), onclick: () => changeMonth(addMonths(S.month, 1)) }, icon('right')),
      S.month !== currentMonth()
        ? h('button', { class: 'btn btn-ghost', id: 'this-month', onclick: () => changeMonth(currentMonth()) }, t('purchases.thisMonth'))
        : null,
      status.confirmed
        ? h('span', { class: 'badge badge-confirmed', id: 'month-status' }, icon('lock', { size: 13 }), t('purchases.statusConfirmed'))
        : h('span', { class: 'badge badge-open', id: 'month-status' }, icon('unlock', { size: 13 }), t('purchases.statusOpen')),
      h('div', { class: 'spacer' }),
      !status.confirmed
        ? h('button', { class: 'btn', id: 'add-fund', onclick: startNewFund }, icon('plus', { size: 16 }), t('purchases.addFund'))
        : null,
      status.confirmed
        ? h('button', { class: 'btn', id: 'reopen-month', onclick: reopenMonth }, icon('unlock', { size: 16 }), t('purchases.reopen'))
        : null,
      !status.confirmed || status.nextCarryOverStale
        ? h(
            'button',
            {
              class: 'btn btn-primary',
              id: 'confirm-month',
              disabled: isFuture,
              title: isFuture ? t('error.ledger.futureMonth', { month: formatMonth(S.month) }) : '',
              onclick: confirmMonth,
            },
            icon('check', { size: 16 }),
            status.confirmed ? t('purchases.reconfirm') : t('purchases.confirm')
          )
        : null,
    ]);
  }

  function banner(kind, text) {
    return h('div', { class: `banner banner-${kind}` }, icon(kind === 'warn' ? 'alert' : kind === 'locked' ? 'lock' : 'info', { size: 16 }), h('span', {}, text));
  }

  function renderBanners() {
    clear(banners);
    const { status, summary, prevMonth, nextMonth } = S.ledger;
    if (status.confirmed) {
      banners.append(
        banner(
          'locked',
          t('purchases.bannerConfirmed', {
            date: formatDateTime(status.confirmedAt),
            amount: formatMoney(status.confirmedBalance, { symbol: true }),
            next: formatMonth(nextMonth),
          })
        )
      );
      if (status.nextCarryOverStale) banners.append(banner('warn', t('purchases.bannerStale', { next: formatMonth(nextMonth) })));
    }
    if (status.prevUnconfirmed) {
      banners.append(
        banner('info', t('purchases.bannerPrevUnconfirmed', { prev: formatMonth(prevMonth), amount: formatMoney(summary.prevBalance, { symbol: true }) }))
      );
    }
    if (status.carryOverMatchesPrev === false) {
      banners.append(
        banner(
          'warn',
          t('purchases.bannerMismatch', {
            carry: formatMoney(summary.carryOver, { symbol: true }),
            prev: formatMonth(prevMonth),
            amount: formatMoney(summary.prevBalance, { symbol: true }),
          })
        )
      );
    }
  }

  // ---- left: ledger list -------------------------------------------------
  function renderLeft() {
    renderMonthBar();
    renderBanners();
    renderLedgerRows();
    renderSummary();
  }

  function entryLabel(entry) {
    if (entry.kind === 'purchase') return entry.summary || t('purchases.noSummary');
    // The "Carried over" tag is shown next to it, so only the source month here.
    if (entry.fundType === 0) return t('purchases.carriedOverSource', { month: entry.sourceMonth ? formatMonthShort(entry.sourceMonth) : '' });
    return entry.summary || t('funds.typeInput');
  }

  function entryTitle(entry) {
    if (entry.kind === 'fund' && entry.fundType === 0 && entry.sourceMonth) {
      return t('purchases.carriedOverFrom', { month: formatMonth(entry.sourceMonth) });
    }
    return entryLabel(entry);
  }

  function renderLedgerRows() {
    if (!S.ledger) return;
    clear(ledgerBody);
    const isLocked = locked();
    for (const entry of S.ledger.entries) {
      const editing = S.leftEdit && S.leftEdit.id === entry.id && S.leftEdit.kind === entry.kind;
      ledgerBody.append(editing ? leftEditRow(entry) : ledgerRow(entry, isLocked));
    }
    if (S.leftEdit && S.leftEdit.id === null) ledgerBody.append(leftEditRow(null));
    if (!isLocked && !(S.leftEdit && S.leftEdit.id === null && S.leftEdit.kind === 'purchase')) {
      ledgerBody.append(
        h(
          'tr',
          { class: 'empty-row', id: 'ledger-new-row', ondblclick: startNewPurchase, title: t('purchases.newRowHint') },
          h('td', { colspan: 5 }, icon('plus', { size: 14 }), t('purchases.newRowHint'))
        )
      );
    }
    if (isLocked && S.ledger.entries.length === 0) {
      ledgerBody.append(h('tr', { class: 'placeholder-row' }, h('td', { colspan: 5 }, t('purchases.empty'))));
    }
    applyPendingFocus();
  }

  function ledgerRow(entry, isLocked) {
    const isPurchase = entry.kind === 'purchase';
    const isCarry = entry.kind === 'fund' && entry.fundType === 0;
    const kindClass = isPurchase ? 'kind-purchase' : isCarry ? 'kind-carry' : 'kind-fund';
    const selected = isPurchase && entry.id === S.selectedId;
    return h(
      'tr',
      {
        class: `ledger-row ${kindClass}${selected ? ' selected' : ''}`,
        dataset: { kind: entry.kind, id: entry.id },
        onclick: () => {
          if (isPurchase) selectPurchase(entry.id);
        },
        ondblclick: () => {
          if (isLocked) return toast(t('error.ledger.monthLocked', { month: formatMonth(S.month) }), 'info');
          if (isPurchase) return startEdit('purchase', entry);
          if (isCarry) return toast(t('purchases.carryReadOnly'), 'info');
          return startEdit('fund', entry);
        },
      },
      h('td', { class: 'col-date' }, formatDayShort(entry.date)),
      h(
        'td',
        { class: 'col-desc', title: entryTitle(entry) }, // full text on hover when truncated
        !isPurchase ? h('span', { class: `tag ${isCarry ? 'tag-carry' : 'tag-fund'}` }, isCarry ? t('funds.typeCarryOver') : t('funds.typeInput')) : null,
        h('span', { class: 'desc-text' }, entryLabel(entry)),
        isPurchase ? h('span', { class: 'muted small item-count' }, t('purchases.itemCount', { count: entry.itemCount })) : null
      ),
      h('td', { class: `num amount ${isPurchase && entry.amount === 0 ? 'amount-zero' : moneyClass(entry.amount)}` }, formatMoney(entry.amount, { sign: true })),
      h('td', { class: `num running ${entry.runningBalance < 0 ? 'amount-minus' : ''}` }, formatMoney(entry.runningBalance)),
      h(
        'td',
        { class: 'col-actions' },
        !isLocked && !isCarry
          ? h(
              'button',
              {
                class: 'icon-btn row-delete',
                title: t('common.delete'),
                onclick: (e) => {
                  e.stopPropagation();
                  deleteEntry(entry);
                },
              },
              icon('trash', { size: 15 })
            )
          : null
      )
    );
  }

  function defaultDate() {
    const today = todayLocal();
    if (today.slice(0, 7) === S.month) return today;
    const last = S.ledger.entries[S.ledger.entries.length - 1];
    return last ? last.date : `${S.month}-01`;
  }

  async function startEdit(kind, entry) {
    // Editing another purchase (or creating one) will switch the right pane.
    if (kind === 'purchase' && (!entry || entry.id !== S.selectedId)) {
      if (!(await confirmDiscard())) return;
      if (entry) {
        S.selectedId = entry.id;
        run(() => loadDetail(entry.id));
      }
    }
    S.leftEdit = entry
      ? { kind, id: entry.id, date: entry.date, summary: entry.summary || '', amountText: kind === 'fund' ? toInputMoney(entry.amount) : '', cost: -entry.amount }
      : { kind, id: null, date: defaultDate(), summary: '', amountText: '', cost: 0 };
    renderLedgerRows();
  }

  function startNewPurchase() {
    if (locked()) return;
    startEdit('purchase', null);
  }

  function startNewFund() {
    if (locked()) return;
    startEdit('fund', null);
  }

  function leftEditRow(entry) {
    const e = S.leftEdit;
    const isFund = e.kind === 'fund';
    const date = h('input', { type: 'date', class: 'cell-input', id: 'edit-date', value: e.date, oninput: () => (e.date = date.value) });
    const summary = h('input', {
      class: 'cell-input',
      id: 'edit-summary',
      value: e.summary,
      maxlength: 200,
      placeholder: isFund ? t('funds.memoPlaceholder') : t('purchases.summaryPlaceholder'),
      oninput: () => (e.summary = summary.value),
    });
    const amount = isFund
      ? h('input', { class: 'cell-input num', id: 'edit-amount', inputmode: 'decimal', value: e.amountText, placeholder: '0', oninput: () => (e.amountText = amount.value) })
      : null;
    const onKey = (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        saveLeftEdit();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        cancelLeftEdit();
      }
    };
    const row = h(
      'tr',
      { class: `ledger-row editing ${isFund ? 'kind-fund' : 'kind-purchase'}${!isFund && e.id === S.selectedId ? ' selected' : ''}`, id: 'ledger-edit-row', onkeydown: onKey },
      h('td', { class: 'col-date' }, date),
      h('td', { class: 'col-desc' }, isFund ? h('span', { class: 'tag tag-fund' }, t('funds.typeInput')) : null, summary),
      h(
        'td',
        { class: 'num' },
        isFund
          ? amount
          : h('span', { class: 'edit-cost', id: 'edit-cost', title: t('purchases.costHint') }, h('span', { class: 'muted small' }, t('purchases.cost')), ' ', h('strong', { class: e.cost ? 'amount-minus' : '' }, formatMoney(-e.cost)))
      ),
      h('td', {}),
      h(
        'td',
        { class: 'col-actions nowrap' },
        h('button', { class: 'icon-btn ok', id: 'edit-save', title: t('common.save'), onclick: (ev) => (ev.stopPropagation(), saveLeftEdit()) }, icon('check', { size: 16 })),
        h('button', { class: 'icon-btn', id: 'edit-cancel', title: t('common.cancel'), onclick: (ev) => (ev.stopPropagation(), cancelLeftEdit()) }, icon('x', { size: 16 }))
      )
    );
    pendingFocus = { el: isFund && e.id === null ? amount : summary, select: true };
    return row;
  }

  function cancelLeftEdit() {
    S.leftEdit = null;
    renderLedgerRows();
  }

  async function saveLeftEdit() {
    const e = S.leftEdit;
    if (!e) return;
    if (!isValidDate(e.date)) return toast(t('error.validation.date', { field: t('field.date') }), 'error');
    let created = null;
    let saved;
    if (e.kind === 'purchase') {
      saved = await run(() =>
        e.id ? call('purchases:update', { id: e.id, date: e.date, summary: e.summary }) : call('purchases:create', { date: e.date, summary: e.summary })
      );
      if (saved && !e.id) created = saved;
    } else {
      const amount = parseMoney(e.amountText);
      if (!(amount > 0)) return toast(t('funds.invalidAmount'), 'error');
      saved = await run(() =>
        e.id ? call('funds:update', { id: e.id, date: e.date, memo: e.summary, amount }) : call('funds:create', { date: e.date, memo: e.summary, amount })
      );
    }
    if (!saved) return;
    S.leftEdit = null;
    if (saved.date.slice(0, 7) !== S.month) toast(t('purchases.movedToMonth', { month: formatMonth(saved.date.slice(0, 7)) }), 'info');
    await run(loadLedger);
    if (created) {
      await selectPurchase(created.id, { force: true });
      addItemRow();
    } else if (e.kind === 'purchase' && e.id === S.selectedId && S.detail) {
      S.detail.purchase = { ...S.detail.purchase, date: saved.date, summary: saved.summary };
      renderItemsHeader();
    }
  }

  async function deleteEntry(entry) {
    const isPurchase = entry.kind === 'purchase';
    const ok = await confirmDialog({
      title: isPurchase ? t('purchases.deleteTitle') : t('funds.deleteTitle'),
      message: isPurchase
        ? t('purchases.deleteMessage', { name: entry.summary || t('purchases.noSummary'), count: entry.itemCount })
        : t('funds.deleteMessage', { amount: formatMoney(entry.amount, { symbol: true }), date: formatDate(entry.date) }),
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    const done = await run(() => call(isPurchase ? 'purchases:remove' : 'funds:remove', { id: entry.id }));
    if (!done) return;
    if (isPurchase && entry.id === S.selectedId) {
      S.selectedId = null;
      S.detail = null;
      S.draft = [];
      S.original = [];
      renderItemsPane();
    }
    toast(t('common.deleted'), 'success');
    await run(loadLedger);
  }

  function renderSummary() {
    const s = S.ledger.summary;
    clear(ledgerSummary);
    const line = (id, label, value, cls, extra) =>
      h('div', { class: `sum-line ${cls || ''}`, id }, h('span', { class: 'sum-label' }, label, extra ? h('span', { class: 'muted small' }, ` ${extra}`) : null), h('span', { class: 'sum-value' }, value));
    ledgerSummary.append(
      line('sum-carry', t('purchases.sumCarryOver'), formatMoney(s.carryOver, { sign: true }), moneyClass(s.carryOver)),
      line('sum-in', t('purchases.sumFundIn'), formatMoney(s.fundIn, { sign: true }), moneyClass(s.fundIn), s.fundInCount ? t('purchases.countRecords', { count: s.fundInCount }) : ''),
      line('sum-spent', t('purchases.sumSpent'), formatMoney(-s.spent, { sign: true }), s.spent ? 'amount-minus' : 'amount-zero', s.purchaseCount ? t('purchases.countPurchases', { count: s.purchaseCount }) : ''),
      line('sum-balance', t('purchases.sumBalance'), formatMoney(s.balance, { symbol: true }), `sum-total ${s.balance < 0 ? 'amount-minus' : ''}`)
    );
  }

  async function confirmMonth() {
    const { summary, nextMonth } = S.ledger;
    if (!(await confirmDiscard())) return;
    const ok = await confirmDialog({
      title: t('purchases.confirmTitle', { month: formatMonth(S.month) }),
      message: t('purchases.confirmMessage', {
        amount: formatMoney(summary.balance, { symbol: true }),
        next: formatMonth(nextMonth),
        date: formatDate(`${nextMonth}-01`, { weekday: false }),
      }),
      confirmLabel: t('purchases.confirm'),
    });
    if (!ok) return;
    const result = await run(() => call('ledger:confirm', { month: S.month }));
    if (!result) return;
    toast(t('purchases.confirmedToast', { amount: formatMoney(result.closingBalance, { symbol: true }), next: formatMonth(nextMonth) }), 'success', 5000);
    if (result.cascaded.length) {
      toast(t('purchases.cascadedToast', { months: result.cascaded.map((c) => formatMonth(c.month)).join(', ') }), 'info', 6000);
    }
    S.leftEdit = null;
    await run(loadLedger);
    if (S.selectedId) await run(() => loadDetail(S.selectedId));
  }

  async function reopenMonth() {
    const ok = await confirmDialog({
      title: t('purchases.reopenTitle', { month: formatMonth(S.month) }),
      message: t('purchases.reopenMessage', { next: formatMonth(S.ledger.nextMonth) }),
      confirmLabel: t('purchases.reopen'),
    });
    if (!ok) return;
    if (!(await run(() => call('ledger:reopen', { month: S.month })))) return;
    toast(t('purchases.reopenedToast'), 'success');
    await run(loadLedger);
    if (S.selectedId) await run(() => loadDetail(S.selectedId));
  }

  // ---- right: purchase items ---------------------------------------------
  let itemsHeader;
  let itemsBody;
  let footerTotal;
  let footerUnsaved;
  let saveBtn;
  let revertBtn;
  let matchNote;

  const itemsLocked = () => Boolean(S.detail && S.detail.purchase.month_confirmed);

  function destroyAutocompletes() {
    autocompletes.forEach((a) => a.destroy());
    autocompletes = [];
  }

  function renderItemsPane() {
    destroyAutocompletes();
    clear(itemsPane);
    if (!S.selectedId || !S.detail) {
      itemsPane.append(
        h('div', { class: 'pane-placeholder', id: 'items-placeholder' }, icon('receipt', { size: 40 }), h('p', {}, t('items.selectPrompt')), h('p', { class: 'muted small' }, t('items.selectHint')))
      );
      return;
    }
    itemsHeader = h('div', { class: 'pane-header items-header' });
    itemsBody = h('tbody', { id: 'items-body' });
    footerTotal = h('strong', { id: 'items-total' });
    footerUnsaved = h('span', { class: 'unsaved', id: 'items-unsaved', hidden: true }, t('items.unsaved'));
    matchNote = h('span', { class: 'muted small', id: 'items-match' });
    saveBtn = h('button', { class: 'btn btn-primary', id: 'items-save', onclick: saveItems }, icon('check', { size: 16 }), t('common.save'));
    revertBtn = h('button', { class: 'btn', id: 'items-revert', onclick: revertItems }, t('items.revert'));
    itemsPane.append(
      itemsHeader,
      h(
        'div',
        { class: 'table-scroll' },
        h(
          'table',
          { class: 'grid items-table', id: 'items-table' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              h('th', { class: 'col-idx' }, '#'),
              h('th', {}, t('items.product')),
              h('th', { class: 'col-standard' }, t('items.standard')),
              h('th', { class: 'num col-price' }, t('items.price')),
              h('th', { class: 'num col-count' }, t('items.count')),
              h('th', { class: 'num col-total' }, t('items.lineTotal')),
              h('th', { class: 'col-actions' }, '')
            )
          ),
          itemsBody
        )
      ),
      h(
        'div',
        { class: 'items-footer' },
        h('div', { class: 'items-total-line' }, h('span', {}, t('items.total')), footerTotal),
        h('div', { class: 'items-footer-row' }, matchNote, h('div', { class: 'spacer' }), footerUnsaved, itemsLocked() ? null : revertBtn, itemsLocked() ? null : saveBtn)
      )
    );
    renderItemsHeader();
    renderItems();
  }

  function renderItemsHeader() {
    if (!itemsHeader) return;
    const p = S.detail.purchase;
    clear(itemsHeader);
    itemsHeader.append(
      h(
        'div',
        { class: 'items-title' },
        h('h3', { id: 'items-title' }, p.summary || t('purchases.noSummary')),
        h('span', { class: 'muted small' }, formatDate(p.date)),
        itemsLocked() ? h('span', { class: 'badge badge-confirmed' }, icon('lock', { size: 12 }), t('purchases.statusConfirmed')) : null
      ),
      h('div', { class: 'muted small' }, itemsLocked() ? t('items.lockedHint') : t('items.editHint'))
    );
  }

  function renderItems() {
    destroyAutocompletes();
    clear(itemsBody);
    const isLocked = itemsLocked();
    S.draft.forEach((row, i) => itemsBody.append(row.editing && !isLocked ? editItemRow(row, i) : itemRow(row, i, isLocked)));
    if (!isLocked) {
      itemsBody.append(
        h(
          'tr',
          { class: 'empty-row', id: 'items-new-row', ondblclick: () => addItemRow(), title: t('items.newRowHint') },
          h('td', { colspan: 7 }, icon('plus', { size: 14 }), t('items.newRowHint'))
        )
      );
    } else if (!S.draft.length) {
      itemsBody.append(h('tr', { class: 'placeholder-row' }, h('td', { colspan: 7 }, t('items.empty'))));
    }
    updateTotals();
    applyPendingFocus();
  }

  function itemRow(row, i, isLocked) {
    const total = rowTotal(row);
    const price = parseMoney(row.priceText);
    return h(
      'tr',
      {
        class: `item-row${row.error ? ' has-error' : ''}`,
        dataset: { key: row.key },
        ondblclick: () => {
          if (!isLocked) editRow(row);
        },
        title: row.error || row.category_name || '',
      },
      h('td', { class: 'col-idx muted' }, i + 1),
      h(
        'td',
        { class: 'col-product' },
        h('span', { class: 'product-name' }, row.product_name),
        !row.product_id && row.product_name ? h('span', { class: 'tag tag-new' }, t('items.newProduct')) : null
      ),
      h('td', { class: `col-standard${row.standard ? '' : ' muted'}` }, row.standard || '—'),
      h('td', { class: 'num' }, Number.isFinite(price) ? formatMoney(price) : row.priceText),
      h('td', { class: 'num col-count' }, row.countText),
      h('td', { class: 'num line-total' }, total === null ? '' : formatMoney(total)),
      h(
        'td',
        { class: 'col-actions' },
        isLocked
          ? null
          : h(
              'button',
              {
                class: 'icon-btn row-delete',
                title: t('common.delete'),
                onclick: (e) => {
                  e.stopPropagation();
                  removeRow(row);
                },
              },
              icon('trash', { size: 15 })
            )
      )
    );
  }

  /** Loads the standards registered for the row's product name (once per name). */
  async function ensureVariants(row) {
    const key = norm(row.product_name);
    if (!key || variantsKnown(row)) return;
    const list = await call('products:variants', { name: row.product_name.trim() }).catch(() => null);
    if (list && norm(row.product_name) === key) {
      row.variants = list;
      row.variantsFor = key;
    }
  }

  function editItemRow(row, i) {
    const categoryHint = h('div', { class: 'cat-hint muted small' });
    const totalCell = h('td', { class: 'num line-total' });
    const refreshHint = () => {
      categoryHint.textContent = row.category_name || '';
    };
    const updateRowTotal = () => {
      const total = rowTotal(row);
      totalCell.textContent = total === null ? '' : formatMoney(total);
      updateTotals();
    };

    const name = h('input', {
      class: 'cell-input item-product',
      value: row.product_name,
      maxlength: 100,
      placeholder: t('items.productPlaceholder'),
      oninput: () => {
        row.product_name = name.value;
        row.product_id = null;
        row.category_name = '';
        refreshHint();
        updateTotals();
      },
    });
    const standard = h('input', {
      class: 'cell-input item-standard',
      value: row.standard,
      maxlength: 60,
      placeholder: t('items.standardPlaceholder'),
      oninput: () => {
        row.standard = standard.value;
        applyVariantMatch(row);
        refreshHint();
        updateTotals();
      },
    });
    const price = h('input', {
      class: 'cell-input num item-price',
      inputmode: 'decimal',
      value: row.priceText,
      placeholder: '0',
      oninput: () => {
        row.priceText = price.value;
        updateRowTotal();
      },
    });
    const count = h('input', {
      class: 'cell-input num item-count',
      inputmode: 'numeric',
      value: row.countText,
      oninput: () => {
        row.countText = count.value;
        updateRowTotal();
      },
    });

    const pickVariant = (v) => {
      row.standard = v.standard;
      standard.value = v.standard;
      row.product_id = v.id;
      row.category_name = v.category_path || '';
      refreshHint();
      if (!row.priceText.trim() && v.last_price !== null && v.last_price !== undefined) {
        row.priceText = toInputMoney(v.last_price);
        price.value = row.priceText;
      }
      updateRowTotal();
      price.focus();
      price.select();
    };

    // Product name: one suggestion per name; picking it lists that name's standards.
    autocompletes.push(
      attachAutocomplete(name, {
        source: async (term) => {
          const list = await call('products:searchNames', { term, limit: 10 }).catch(() => []);
          if (norm(name.value) === norm(term)) {
            const exact = list.find((n) => norm(n.name) === norm(term));
            row.variants = exact ? exact.standards : [];
            row.variantsFor = norm(term);
            applyVariantMatch(row);
            refreshHint();
          }
          return list;
        },
        renderItem: (n) => {
          const only = n.variant_count === 1 ? n.standards[0] : null;
          return [
            h('span', { class: 'ac-name' }, n.name),
            only
              ? only.standard
                ? h('span', { class: 'tag tag-standard' }, only.standard)
                : null
              : h('span', { class: 'tag tag-standard' }, t('items.standardCount', { count: n.variant_count })),
            h('span', { class: 'ac-meta' }, n.standards[0].category_path || t('products.uncategorized')),
            only && only.last_price !== null ? h('span', { class: 'ac-price' }, formatMoney(only.last_price)) : null,
          ];
        },
        onSelect: (n) => {
          row.product_name = n.name;
          name.value = n.name;
          row.variants = n.standards;
          row.variantsFor = norm(n.name);
          if (n.standards.length === 1) return pickVariant(n.standards[0]);
          // Several standards: the user has to choose one.
          if (!matchingVariant(row)) {
            row.standard = '';
            standard.value = '';
          }
          applyVariantMatch(row);
          refreshHint();
          updateTotals();
          standard.focus();
        },
        footer: (term, list) =>
          term && !list.some((n) => norm(n.name) === norm(term))
            ? h('span', { class: 'ac-new' }, icon('plus', { size: 13 }), t('items.willCreate', { name: term }))
            : null,
      })
    );

    // Standard: lists every standard registered for the name, opens on focus.
    autocompletes.push(
      attachAutocomplete(standard, {
        openOnFocus: true,
        source: async (term) => {
          await ensureVariants(row);
          applyVariantMatch(row);
          refreshHint();
          const q = norm(term);
          if (!variantsKnown(row)) return [];
          const list = row.variants.filter((v) => !q || norm(v.standard).includes(q));
          // An exact match is offered first so Enter picks it.
          return [...list.filter((v) => norm(v.standard) === q), ...list.filter((v) => norm(v.standard) !== q)];
        },
        renderItem: (v) => [
          h('span', { class: `ac-name${v.standard ? '' : ' muted'}` }, v.standard || t('items.noStandard')),
          h('span', { class: 'ac-meta' }, v.purchase_count ? t('items.boughtTimes', { count: v.purchase_count }) : t('items.neverBought')),
          v.last_price !== null && v.last_price !== undefined ? h('span', { class: 'ac-price' }, formatMoney(v.last_price)) : null,
        ],
        onSelect: pickVariant,
        footer: (term) => {
          if (!row.product_name.trim() || !variantsKnown(row)) return null;
          if (term && !matchingVariant(row)) {
            return h('span', { class: 'ac-new' }, icon('plus', { size: 13 }), t('items.willCreateStandard', { standard: term, name: row.product_name.trim() }));
          }
          if (!term && row.variants.length > 1) return h('span', { class: 'ac-hint' }, t('items.chooseStandardHint', { count: row.variants.length }));
          return null;
        },
      })
    );

    const onKey = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const isLast = S.draft[S.draft.length - 1] === row;
        const fromCount = e.target === count;
        finishRow(row).then((ok) => {
          if (ok && isLast && fromCount) addItemRow();
        });
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelRow(row);
      }
    };

    const tr = h(
      'tr',
      { class: `item-row editing${row.error ? ' has-error' : ''}`, dataset: { key: row.key }, onkeydown: onKey },
      h('td', { class: 'col-idx muted' }, i + 1),
      h('td', { class: 'col-product' }, name, categoryHint, row.error ? h('div', { class: 'row-error' }, row.error) : null),
      h('td', { class: 'col-standard' }, standard),
      h('td', { class: 'num' }, price),
      h('td', { class: 'num col-count' }, count),
      totalCell,
      h(
        'td',
        { class: 'col-actions nowrap' },
        h('button', { class: 'icon-btn ok row-done', title: t('items.doneRow'), onclick: () => finishRow(row) }, icon('check', { size: 15 })),
        h('button', { class: 'icon-btn row-delete', title: t('common.delete'), onclick: () => removeRow(row) }, icon('trash', { size: 15 }))
      )
    );
    refreshHint();
    updateRowTotal();
    if (row.focus) {
      pendingFocus = { el: { price, standard }[row.focus] || name, select: false };
      row.focus = null;
    }
    return tr;
  }

  function addItemRow() {
    if (itemsLocked() || !S.detail) return;
    S.draft.push({
      key: newKey(),
      id: null,
      product_id: null,
      product_name: '',
      standard: '',
      category_name: '',
      priceText: '',
      countText: '1',
      editing: true,
      error: null,
      variants: null,
      variantsFor: null,
      focus: 'name',
    });
    renderItems();
  }

  function editRow(row) {
    row.snapshot = {
      product_id: row.product_id,
      product_name: row.product_name,
      standard: row.standard,
      category_name: row.category_name,
      priceText: row.priceText,
      countText: row.countText,
    };
    row.editing = true;
    row.focus = 'name';
    renderItems();
  }

  /** Validates one row (loading its standards first) and leaves edit mode. */
  async function finishRow(row) {
    if (isBlankRow(row)) {
      S.draft = S.draft.filter((r) => r !== row);
      renderItems();
      return true;
    }
    await ensureVariants(row);
    applyVariantMatch(row);
    row.error = validateRow(row);
    if (row.error) {
      if (!row.product_id && variantsKnown(row) && row.variants.length && !row.standard.trim()) row.focus = 'standard';
      renderItems();
      return false;
    }
    row.editing = false;
    row.snapshot = null;
    renderItems();
    return true;
  }

  function cancelRow(row) {
    if (row.snapshot) {
      Object.assign(row, row.snapshot, { snapshot: null, editing: false, error: null });
    } else if (row.id == null) {
      S.draft = S.draft.filter((r) => r !== row);
    } else {
      row.editing = false;
    }
    renderItems();
  }

  function removeRow(row) {
    S.draft = S.draft.filter((r) => r !== row);
    renderItems();
  }

  function updateTotals() {
    if (!footerTotal) return;
    const total = S.draft.reduce((sum, r) => sum + (rowTotal(r) || 0), 0);
    footerTotal.textContent = formatMoney(total, { symbol: true });
    const dirty = isDirty();
    footerUnsaved.hidden = !dirty;
    saveBtn.disabled = !dirty;
    revertBtn.disabled = !dirty;
    const saved = S.detail.purchase.cost;
    matchNote.textContent = dirty
      ? t('items.savedCost', { amount: formatMoney(saved, { symbol: true }) })
      : t('items.matchesList');
  }

  async function revertItems() {
    S.draft = toDraft(S.detail.items);
    renderItems();
  }

  async function saveItems() {
    const rows = S.draft.filter((r) => !isBlankRow(r));
    saveBtn.disabled = true;
    await Promise.all(rows.map((r) => ensureVariants(r)));
    rows.forEach(applyVariantMatch);
    let invalid = false;
    for (const r of rows) {
      r.error = validateRow(r);
      if (r.error) {
        r.editing = true;
        invalid = true;
      }
    }
    if (invalid) {
      renderItems();
      toast(t('items.fixErrors'), 'error');
      return false;
    }
    const items = rows.map((r) => ({
      id: r.id,
      product_id: r.product_id,
      product_name: r.product_name.trim(),
      standard: r.standard.trim(),
      price: parseMoney(r.priceText),
      count: parseCount(r.countText),
    }));
    const result = await run(() => call('purchases:saveItems', { id: S.selectedId, items }));
    if (!result) {
      updateTotals();
      return false;
    }
    applyDetail(result);
    toast(t('items.saved', { amount: formatMoney(result.purchase.cost, { symbol: true }) }), 'success');
    if (result.createdProducts.length) {
      const names = result.createdProducts.map((p) => (p.standard ? `${p.name} (${p.standard})` : p.name));
      toast(t('items.productsCreated', { names: names.join(', ') }), 'info', 5000);
    }
    await run(loadLedger);
    return true;
  }

  // Closing or reloading the window with unsaved items: the main process asks.
  const onBeforeUnload = (e) => {
    if (S.selectedId && isDirty()) {
      e.preventDefault();
      e.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', onBeforeUnload);

  // ---- boot --------------------------------------------------------------
  renderItemsPane();
  run(loadLedger).then(() => {
    // Opened from the Monthly Report (#/purchases?month=..&purchase=..): select that purchase once.
    const target = Number(ctx.params.purchase);
    if (ctx.params.month || target) history.replaceState(null, '', '#/purchases');
    if (target && S.ledger && S.ledger.entries.some((e) => e.kind === 'purchase' && e.id === target)) selectPurchase(target);
  });

  return {
    async beforeLeave() {
      return confirmDiscard();
    },
    unmount() {
      disposed = true;
      window.removeEventListener('beforeunload', onBeforeUnload);
      destroyAutocompletes();
    },
  };
}
