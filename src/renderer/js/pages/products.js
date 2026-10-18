import { h, clear, toast, confirmDialog, openDialog, field, formError, showFormError, debounce } from '../dom.js';
import { t, errorMessage } from '../i18n.js';
import { icon } from '../icons.js';
import { formatMoney, formatDate } from '../format.js';

/** Builds <option>s for a category tree, indented by depth. */
export function categoryOptions(categories, { selected = null, exclude = new Set(), noneLabel = null } = {}) {
  const opts = [];
  if (noneLabel !== null) opts.push(h('option', { value: '', selected: selected === null }, noneLabel));
  for (const c of categories) {
    if (exclude.has(c.id)) continue;
    opts.push(h('option', { value: String(c.id), selected: c.id === selected }, `${'   '.repeat(c.depth)}${c.depth ? '└ ' : ''}${c.name}`));
  }
  return opts;
}

export function mountProducts(container, ctx) {
  const { call, params } = ctx;
  const state = {
    search: '',
    filter: params.category ? `c:${params.category}` : 'all', // all | none | c:<id>
    includeInactive: true,
    categories: [],
    products: [],
  };

  const search = h('input', {
    type: 'search',
    id: 'products-search',
    class: 'input-search',
    placeholder: t('products.searchPlaceholder'),
    oninput: debounce(() => {
      state.search = search.value;
      loadProducts();
    }, 150),
  });
  const filter = h('select', {
    id: 'products-filter',
    onchange: () => {
      state.filter = filter.value;
      loadProducts();
    },
  });
  const inactive = h('input', {
    type: 'checkbox',
    id: 'products-inactive',
    checked: state.includeInactive,
    onchange: () => {
      state.includeInactive = inactive.checked;
      loadProducts();
    },
  });
  const tableHost = h('div', { class: 'card' });
  const countLabel = h('span', { class: 'muted small', id: 'products-count' });

  container.append(
    h(
      'div',
      { class: 'page' },
      h(
        'div',
        { class: 'page-header' },
        h('h2', {}, t('products.title')),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn btn-primary', id: 'products-add', onclick: () => openEditor(null) }, icon('plus', { size: 16 }), t('products.add'))
      ),
      h('p', { class: 'page-intro muted' }, t('products.intro')),
      h(
        'div',
        { class: 'toolbar' },
        search,
        filter,
        h('label', { class: 'checkbox' }, inactive, t('products.showInactive')),
        h('div', { class: 'spacer' }),
        countLabel
      ),
      tableHost
    )
  );

  function renderFilter() {
    clear(filter);
    filter.append(
      h('option', { value: 'all', selected: state.filter === 'all' }, t('products.filterAll')),
      h('option', { value: 'none', selected: state.filter === 'none' }, t('products.uncategorized'))
    );
    for (const c of state.categories) {
      const value = `c:${c.id}`;
      filter.append(h('option', { value, selected: state.filter === value }, `${'   '.repeat(c.depth)}${c.depth ? '└ ' : ''}${c.name}`));
    }
  }

  async function loadCategories() {
    state.categories = await call('categories:list');
    renderFilter();
  }

  async function loadProducts() {
    const query = { search: state.search, includeInactive: state.includeInactive };
    if (state.filter === 'none') query.uncategorized = true;
    else if (state.filter.startsWith('c:')) query.categoryId = Number(state.filter.slice(2));
    try {
      state.products = await call('products:list', query);
    } catch (err) {
      toast(errorMessage(err), 'error');
      state.products = [];
    }
    renderTable();
  }

  function renderTable() {
    clear(tableHost);
    countLabel.textContent = t('products.count', { count: state.products.length });
    if (!state.products.length) {
      tableHost.append(h('p', { class: 'empty-state' }, t('products.empty')));
      return;
    }
    tableHost.append(
      h(
        'table',
        { class: 'grid', id: 'products-table' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', {}, t('products.name')),
            h('th', {}, t('products.standard')),
            h('th', {}, t('products.category')),
            h('th', { class: 'num' }, t('products.purchaseCount')),
            h('th', { class: 'num' }, t('products.totalCount')),
            h('th', { class: 'num' }, t('products.totalSpent')),
            h('th', { class: 'num' }, t('products.lastPrice')),
            h('th', {}, t('products.lastDate')),
            h('th', { class: 'col-actions' }, '')
          )
        ),
        h(
          'tbody',
          {},
          state.products.map((p) =>
            h(
              'tr',
              { class: `clickable${p.is_active ? '' : ' inactive'}`, dataset: { id: p.id }, ondblclick: () => openEditor(p) },
              h('td', {}, h('span', { class: 'product-name' }, p.name), p.is_active ? null : h('span', { class: 'tag tag-muted' }, t('products.inactive'))),
              h('td', { class: p.standard ? '' : 'muted' }, p.standard || '—'),
              h('td', { class: p.category_path ? '' : 'muted' }, p.category_path || t('products.uncategorized')),
              h('td', { class: 'num' }, p.purchase_count),
              h('td', { class: 'num' }, p.total_count),
              h('td', { class: 'num' }, formatMoney(p.total_spent)),
              h('td', { class: 'num' }, p.last_price === null ? '' : formatMoney(p.last_price)),
              h('td', {}, p.last_date ? formatDate(p.last_date, { weekday: false }) : ''),
              h(
                'td',
                { class: 'col-actions nowrap' },
                h('button', { class: 'icon-btn', title: t('common.edit'), onclick: () => openEditor(p) }, icon('edit', { size: 15 })),
                h('button', { class: 'icon-btn row-delete', title: t('common.delete'), onclick: () => remove(p) }, icon('trash', { size: 15 }))
              )
            )
          )
        )
      )
    );
  }

  function openEditor(product) {
    const name = h('input', { id: 'product-name', value: product ? product.name : '', maxlength: 100, required: true, autofocus: true });
    const standard = h('input', { id: 'product-standard', value: product ? product.standard : '', maxlength: 60, placeholder: t('items.standardPlaceholder') });
    const presetCategory = !product && state.filter.startsWith('c:') ? Number(state.filter.slice(2)) : null;
    const category = h(
      'select',
      { id: 'product-category' },
      categoryOptions(state.categories, { selected: product ? product.category_id : presetCategory, noneLabel: t('products.uncategorized') })
    );
    const memo = h('textarea', { id: 'product-memo', rows: 3, maxlength: 500 }, product ? product.memo || '' : '');
    const active = h('input', { type: 'checkbox', id: 'product-active', checked: product ? Boolean(product.is_active) : true });
    const error = formError();
    openDialog({
      title: product ? t('products.editTitle') : t('products.addTitle'),
      body: [
        field(t('products.name'), name),
        field(t('products.standard'), standard, t('products.standardHint')),
        field(t('products.category'), category),
        field(t('products.memo'), memo),
        h('label', { class: 'checkbox' }, active, t('products.activeLabel')),
        h('p', { class: 'field-hint' }, t('products.activeHint')),
        error,
      ],
      actions: [
        { id: 'cancel', label: t('common.cancel') },
        {
          id: 'save',
          label: t('common.save'),
          kind: 'primary',
          submit: true,
          onClick: async () => {
            const payload = { name: name.value, standard: standard.value, category_id: category.value ? Number(category.value) : null, memo: memo.value, is_active: active.checked };
            try {
              await call(product ? 'products:update' : 'products:create', product ? { id: product.id, ...payload } : payload);
              toast(t('common.saved'), 'success');
              await loadProducts();
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

  async function remove(product) {
    const ok = await confirmDialog({
      title: t('products.deleteTitle'),
      message: t('products.deleteMessage', { name: product.standard ? `${product.name} (${product.standard})` : product.name }),
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await call('products:remove', { id: product.id });
      toast(t('common.deleted'), 'success');
      await loadProducts();
    } catch (err) {
      toast(errorMessage(err), 'error', 6000);
    }
  }

  (async () => {
    try {
      await loadCategories();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
    await loadProducts();
  })();

  return {};
}
