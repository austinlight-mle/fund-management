import { h, clear, toast, confirmDialog, field, formError, showFormError } from '../dom.js';
import { t, errorMessage } from '../i18n.js';
import { icon } from '../icons.js';
import { formatDateTime } from '../format.js';
import { categoryOptions } from './products.js';

/** Nested category management: tree on the left, editor on the right. */
export function mountCategories(container, ctx) {
  const { call, navigate } = ctx;
  const state = {
    categories: [],
    selectedId: null,
    creating: null, // { parent_id } while adding a new category
    collapsed: new Set(),
  };

  const treeHost = h('div', { class: 'tree', id: 'category-tree', role: 'tree' });
  const editorHost = h('section', { class: 'pane editor-pane', id: 'category-editor' });

  container.append(
    h(
      'div',
      { class: 'page' },
      h(
        'div',
        { class: 'page-header' },
        h('h2', {}, t('categories.title')),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn', id: 'category-add-root', onclick: () => startCreate(null) }, icon('plus', { size: 16 }), t('categories.addRoot'))
      ),
      h('p', { class: 'page-intro muted' }, t('categories.intro')),
      h('div', { class: 'split split-tree' }, h('section', { class: 'pane tree-pane' }, treeHost), editorHost)
    )
  );

  const byId = () => new Map(state.categories.map((c) => [c.id, c]));

  async function load() {
    try {
      state.categories = await call('categories:list');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
    if (state.selectedId && !byId().has(state.selectedId)) state.selectedId = null;
    renderTree();
    renderEditor();
  }

  function isHidden(cat, map) {
    let parent = cat.parent_id;
    while (parent) {
      if (state.collapsed.has(parent)) return true;
      parent = map.get(parent)?.parent_id;
    }
    return false;
  }

  function renderTree() {
    clear(treeHost);
    if (!state.categories.length) {
      treeHost.append(h('p', { class: 'empty-state' }, t('categories.empty')));
      return;
    }
    const map = byId();
    for (const c of state.categories) {
      if (isHidden(c, map)) continue;
      const collapsed = state.collapsed.has(c.id);
      treeHost.append(
        h(
          'div',
          {
            class: `tree-node${c.id === state.selectedId ? ' selected' : ''}`,
            role: 'treeitem',
            dataset: { id: c.id, name: c.name },
            style: { paddingLeft: `${8 + c.depth * 20}px` },
            onclick: () => select(c.id),
          },
          c.child_count
            ? h(
                'button',
                {
                  class: 'tree-toggle',
                  title: collapsed ? t('categories.expand') : t('categories.collapse'),
                  onclick: (e) => {
                    e.stopPropagation();
                    if (collapsed) state.collapsed.delete(c.id);
                    else state.collapsed.add(c.id);
                    renderTree();
                  },
                },
                icon(collapsed ? 'chevronRight' : 'chevronDown', { size: 14 })
              )
            : h('span', { class: 'tree-toggle-spacer' }),
          icon('folder', { size: 16, cls: 'tree-icon' }),
          h('span', { class: 'tree-label' }, c.name),
          h('span', { class: 'count-pill', title: t('categories.productCountHint') }, String(c.total_product_count))
        )
      );
    }
  }

  function select(id) {
    state.selectedId = id;
    state.creating = null;
    renderTree();
    renderEditor();
  }

  function startCreate(parentId) {
    state.creating = { parent_id: parentId };
    renderEditor();
  }

  function renderEditor() {
    clear(editorHost);
    const map = byId();
    const current = state.creating ? null : map.get(state.selectedId);
    if (!state.creating && !current) {
      editorHost.append(h('div', { class: 'pane-placeholder' }, icon('folder', { size: 40 }), h('p', {}, t('categories.selectPrompt'))));
      return;
    }
    // A category cannot be moved under itself or one of its descendants.
    const exclude = new Set();
    if (current) {
      exclude.add(current.id);
      let changed = true;
      while (changed) {
        changed = false;
        for (const c of state.categories) {
          if (c.parent_id && exclude.has(c.parent_id) && !exclude.has(c.id)) {
            exclude.add(c.id);
            changed = true;
          }
        }
      }
    }
    const name = h('input', { id: 'category-name', value: current ? current.name : '', maxlength: 100, required: true });
    const parent = h(
      'select',
      { id: 'category-parent' },
      categoryOptions(state.categories, {
        selected: current ? current.parent_id : state.creating.parent_id,
        exclude,
        noneLabel: t('categories.noParent'),
      })
    );
    const description = h('textarea', { id: 'category-description', rows: 3, maxlength: 500 }, current ? current.description || '' : '');
    const sortOrder = h('input', { id: 'category-sort', type: 'number', min: -9999, max: 9999, step: 1, value: current ? String(current.sort_order) : '0' });
    const error = formError();

    const save = async (e) => {
      e.preventDefault();
      showFormError(error, '');
      const payload = {
        name: name.value,
        parent_id: parent.value ? Number(parent.value) : null,
        description: description.value,
        sort_order: sortOrder.value === '' ? 0 : Number(sortOrder.value),
      };
      try {
        const saved = current ? await call('categories:update', { id: current.id, ...payload }) : await call('categories:create', payload);
        toast(t('common.saved'), 'success');
        state.creating = null;
        state.selectedId = saved.id;
        if (saved.parent_id) state.collapsed.delete(saved.parent_id);
        await load();
      } catch (err) {
        showFormError(error, errorMessage(err));
      }
    };

    editorHost.append(
      h(
        'form',
        { class: 'editor-form', onsubmit: save },
        h('h3', {}, current ? t('categories.editTitle') : t('categories.addTitle')),
        current ? h('p', { class: 'muted small', id: 'category-path' }, current.path) : null,
        field(t('categories.name'), name),
        field(t('categories.parent'), parent),
        field(t('categories.description'), description),
        field(t('categories.sortOrder'), sortOrder, t('categories.sortHint')),
        error,
        h(
          'div',
          { class: 'form-actions' },
          h('button', { type: 'submit', class: 'btn btn-primary', id: 'category-save' }, icon('check', { size: 16 }), t('common.save')),
          state.creating ? h('button', { type: 'button', class: 'btn', onclick: () => select(state.selectedId) }, t('common.cancel')) : null,
          h('div', { class: 'spacer' }),
          current ? h('button', { type: 'button', class: 'btn', id: 'category-add-child', onclick: () => startCreate(current.id) }, icon('plus', { size: 16 }), t('categories.addChild')) : null,
          current ? h('button', { type: 'button', class: 'btn btn-danger', id: 'category-delete', onclick: () => remove(current) }, icon('trash', { size: 16 }), t('common.delete')) : null
        ),
        current
          ? h(
              'dl',
              { class: 'meta-list' },
              h('dt', {}, t('categories.subcategories')),
              h('dd', {}, String(current.child_count)),
              h('dt', {}, t('categories.products')),
              h(
                'dd',
                {},
                t('categories.productCounts', { direct: current.product_count, total: current.total_product_count }),
                ' ',
                h('a', { href: '#', class: 'btn-link', onclick: (e) => (e.preventDefault(), navigate(`products?category=${current.id}`)) }, t('categories.viewProducts'))
              ),
              h('dt', {}, t('common.created')),
              h('dd', {}, formatDateTime(current.created_at)),
              h('dt', {}, t('common.updated')),
              h('dd', {}, formatDateTime(current.updated_at))
            )
          : null
      )
    );
    requestAnimationFrame(() => name.isConnected && name.focus());
  }

  async function remove(cat) {
    if (cat.child_count > 0) {
      toast(t('error.category.hasChildren', { count: cat.child_count }), 'error', 5000);
      return;
    }
    const ok = await confirmDialog({
      title: t('categories.deleteTitle'),
      message: cat.product_count
        ? t('categories.deleteWithProducts', { name: cat.name, count: cat.product_count })
        : t('categories.deleteMessage', { name: cat.name }),
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await call('categories:remove', { id: cat.id });
      toast(t('common.deleted'), 'success');
      state.selectedId = cat.parent_id || null;
      await load();
    } catch (err) {
      toast(errorMessage(err), 'error', 5000);
    }
  }

  load();
  return {};
}
