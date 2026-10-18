import { h, clear, toast, confirmDialog, openDialog, field, formError, showFormError } from '../dom.js';
import { t, errorMessage } from '../i18n.js';
import { icon } from '../icons.js';
import { formatMoney, toInputMoney, parseMoney, formatMonth, formatDate, todayLocal, isValidDate, moneyClass } from '../format.js';

/** Fund records of a year: carried-over (system generated) and fund inputs. */
export function mountFunds(container, ctx) {
  const { call } = ctx;
  let year = Number(todayLocal().slice(0, 4));
  let rows = [];

  const yearTitle = h('h2', { class: 'month-title', id: 'funds-year' });
  const body = h('div', { class: 'funds-body' });
  const totals = h('div', { class: 'funds-totals', id: 'funds-totals' });

  container.append(
    h(
      'div',
      { class: 'page' },
      h(
        'div',
        { class: 'month-bar' },
        h('button', { class: 'btn btn-icon', id: 'funds-prev', title: t('funds.prevYear'), onclick: () => setYear(year - 1) }, icon('left')),
        yearTitle,
        h('button', { class: 'btn btn-icon', id: 'funds-next', title: t('funds.nextYear'), onclick: () => setYear(year + 1) }, icon('right')),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn btn-primary', id: 'funds-add', onclick: () => openEditor(null) }, icon('plus', { size: 16 }), t('funds.add'))
      ),
      h('p', { class: 'page-intro muted' }, t('funds.intro')),
      totals,
      h('div', { class: 'card' }, body)
    )
  );

  async function setYear(y) {
    year = y;
    await load();
  }

  async function load() {
    try {
      rows = await call('funds:list', { year });
    } catch (err) {
      toast(errorMessage(err), 'error');
      rows = [];
    }
    render();
  }

  function render() {
    yearTitle.textContent = t('funds.yearTitle', { year });
    clear(body);
    clear(totals);
    const inputs = rows.filter((r) => r.type === 1);
    const sumInputs = inputs.reduce((s, r) => s + r.amount, 0);
    totals.append(
      h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, t('funds.yearInputs')), h('span', { class: 'stat-value amount-plus' }, formatMoney(sumInputs, { symbol: true }))),
      h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, t('funds.yearInputCount')), h('span', { class: 'stat-value' }, String(inputs.length)))
    );
    if (!rows.length) {
      body.append(h('p', { class: 'empty-state' }, t('funds.empty')));
      return;
    }
    const table = h(
      'table',
      { class: 'grid', id: 'funds-table' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', { class: 'col-date' }, t('common.date')),
          h('th', {}, t('funds.type')),
          h('th', {}, t('funds.memo')),
          h('th', { class: 'num' }, t('common.amount')),
          h('th', { class: 'col-actions' }, '')
        )
      )
    );
    const tbody = h('tbody');
    let month = null;
    let monthTotal = 0;
    const flushMonth = () => {
      if (month) {
        tbody.append(
          h('tr', { class: 'subtotal-row' }, h('td', { colspan: 3 }, t('funds.monthTotal', { month: formatMonth(month) })), h('td', { class: 'num' }, formatMoney(monthTotal, { sign: true })), h('td'))
        );
      }
    };
    for (const r of rows) {
      const m = r.date.slice(0, 7);
      if (m !== month) {
        flushMonth();
        month = m;
        monthTotal = 0;
        tbody.append(
          h(
            'tr',
            { class: 'group-row' },
            h('td', { colspan: 5 }, formatMonth(m), r.month_confirmed ? h('span', { class: 'badge badge-confirmed' }, icon('lock', { size: 12 }), t('purchases.statusConfirmed')) : null)
          )
        );
      }
      monthTotal += r.amount;
      const editable = r.type === 1 && !r.month_confirmed;
      tbody.append(
        h(
          'tr',
          { class: `fund-row${editable ? ' clickable' : ''}`, dataset: { id: r.id }, ondblclick: () => editable && openEditor(r) },
          h('td', { class: 'col-date' }, formatDate(r.date)),
          h('td', {}, h('span', { class: `tag ${r.type === 0 ? 'tag-carry' : 'tag-fund'}` }, r.type === 0 ? t('funds.typeCarryOver') : t('funds.typeInput'))),
          h('td', {}, r.type === 0 ? t('purchases.carriedOverFrom', { month: r.source_month ? formatMonth(r.source_month) : '' }) : r.memo || ''),
          h('td', { class: `num ${moneyClass(r.amount)}` }, formatMoney(r.amount, { sign: true })),
          h(
            'td',
            { class: 'col-actions nowrap' },
            editable
              ? [
                  h('button', { class: 'icon-btn', title: t('common.edit'), onclick: () => openEditor(r) }, icon('edit', { size: 15 })),
                  h('button', { class: 'icon-btn row-delete', title: t('common.delete'), onclick: () => remove(r) }, icon('trash', { size: 15 })),
                ]
              : h('span', { class: 'muted', title: r.type === 0 ? t('purchases.carryReadOnly') : t('error.ledger.monthLocked', { month: formatMonth(m) }) }, icon('lock', { size: 14 }))
          )
        )
      );
    }
    flushMonth();
    table.append(tbody);
    body.append(table);
  }

  function openEditor(row) {
    const date = h('input', { type: 'date', id: 'fund-date', value: row ? row.date : todayLocal(), required: true });
    const amount = h('input', { id: 'fund-amount', inputmode: 'decimal', value: row ? toInputMoney(row.amount) : '', required: true, autofocus: true });
    const memo = h('input', { id: 'fund-memo', value: row ? row.memo || '' : '', maxlength: 200, placeholder: t('funds.memoPlaceholder') });
    const error = formError();
    openDialog({
      title: row ? t('funds.editTitle') : t('funds.addTitle'),
      body: [field(t('common.date'), date), field(t('common.amount'), amount), field(t('funds.memo'), memo), error],
      actions: [
        { id: 'cancel', label: t('common.cancel') },
        {
          id: 'save',
          label: t('common.save'),
          kind: 'primary',
          submit: true,
          onClick: async () => {
            const value = parseMoney(amount.value);
            if (!isValidDate(date.value)) {
              showFormError(error, t('error.validation.date', { field: t('field.date') }));
              return false;
            }
            if (!(value > 0)) {
              showFormError(error, t('funds.invalidAmount'));
              return false;
            }
            try {
              const payload = { date: date.value, amount: value, memo: memo.value };
              await call(row ? 'funds:update' : 'funds:create', row ? { id: row.id, ...payload } : payload);
              toast(t('common.saved'), 'success');
              const y = Number(date.value.slice(0, 4));
              if (y !== year) year = y;
              await load();
              return true;
            } catch (err) {
              showFormError(error, errorMessage(err));
              return false;
            }
          },
        },
      ],
    });
  }

  async function remove(row) {
    const ok = await confirmDialog({
      title: t('funds.deleteTitle'),
      message: t('funds.deleteMessage', { amount: formatMoney(row.amount, { symbol: true }), date: formatDate(row.date) }),
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await call('funds:remove', { id: row.id });
      toast(t('common.deleted'), 'success');
      await load();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  load();
  return {};
}
