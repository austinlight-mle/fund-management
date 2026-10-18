import { call, setAuthRequiredHandler } from './api.js';
import { loadI18n, t, getLang, errorMessage } from './i18n.js';
import { setCurrency } from './format.js';
import { h, clear, toast } from './dom.js';
import { icon } from './icons.js';
import { mountLogin } from './pages/login.js';
import { mountPurchases } from './pages/purchases.js';
import { mountFunds } from './pages/funds.js';
import { mountProducts } from './pages/products.js';
import { mountCategories } from './pages/categories.js';
import { mountSettings } from './pages/settings.js';
import { mountReport } from './pages/report.js';

// Navigation order. The app still opens on Purchases (DEFAULT_ROUTE).
const ROUTES = [
  { id: 'categories', icon: 'folder', label: 'nav.categories', mount: mountCategories },
  { id: 'products', icon: 'box', label: 'nav.products', mount: mountProducts },
  { id: 'funds', icon: 'wallet', label: 'nav.funds', mount: mountFunds },
  { id: 'purchases', icon: 'receipt', label: 'nav.purchases', mount: mountPurchases },
  { id: 'report', icon: 'chart', label: 'nav.report', mount: mountReport },
  { id: 'settings', icon: 'settings', label: 'nav.settings', mount: mountSettings },
];
const DEFAULT_ROUTE = ROUTES.find((r) => r.id === 'purchases');

const root = document.getElementById('app');
const app = {
  auth: null,
  settings: null,
  page: null, // { route, instance }
  ignoreHash: false,
};

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const route = ROUTES.find((r) => r.id === path) || DEFAULT_ROUTE;
  return { route, params: Object.fromEntries(new URLSearchParams(query)) };
}

export function navigate(path) {
  location.hash = `#/${path}`;
}

async function applySettings(settings) {
  app.settings = settings;
  setCurrency(settings.currency, settings.currencyDecimals);
  document.documentElement.dataset.theme = settings.theme;
}

function paintThemeToggle(btn) {
  const dark = app.settings.theme === 'dark';
  btn.replaceChildren(icon(dark ? 'sun' : 'moon', { size: 15 }));
  btn.title = dark ? t('theme.switchToLight') : t('theme.switchToDark');
  btn.setAttribute('aria-label', btn.title);
}

/** Small sun/moon button that flips between the dark and light theme. */
function themeToggle() {
  const btn = h('button', {
    type: 'button',
    class: 'icon-btn theme-toggle',
    onclick: () => ctx.setTheme(app.settings.theme === 'dark' ? 'light' : 'dark').catch((e) => toast(errorMessage(e), 'error')),
  });
  paintThemeToggle(btn);
  return btn;
}

async function reloadLanguage() {
  await loadI18n();
  document.title = t('app.title');
}

const ctx = {
  call,
  t,
  navigate,
  get settings() {
    return app.settings;
  },
  get user() {
    return app.auth && app.auth.user;
  },
  /** Re-applies settings / language and redraws the whole shell on the same page. */
  async refreshApp() {
    await applySettings(await call('settings:get'));
    await reloadLanguage();
    app.auth = await call('auth:status');
    render();
  },
  async setLanguage(language) {
    if (!(await leaveCurrentPage())) return; // the page is redrawn
    await call('settings:setLanguage', { language });
    await ctx.refreshApp();
  },
  /** Switches the theme in place (no redraw, so unsaved edits are kept). */
  async setTheme(theme) {
    await applySettings(await call('settings:setTheme', { theme }));
    document.querySelectorAll('.theme-toggle').forEach(paintThemeToggle);
  },
  themeToggle,
  async logout() {
    if (!(await leaveCurrentPage())) return;
    app.auth = await call('auth:logout');
    render();
  },
};

async function leaveCurrentPage() {
  const inst = app.page && app.page.instance;
  if (inst && inst.beforeLeave) return inst.beforeLeave();
  return true;
}

function unmountPage() {
  if (app.page && app.page.instance && app.page.instance.unmount) app.page.instance.unmount();
  app.page = null;
}

function renderLogin() {
  unmountPage();
  clear(root);
  mountLogin(root, {
    ...ctx,
    status: app.auth,
    onAuthenticated: async (status) => {
      app.auth = status;
      render();
    },
  });
}

function renderShell() {
  unmountPage();
  clear(root);
  const { route, params } = parseHash();
  const content = h('main', { class: 'content', id: 'content' });
  const nav = h(
    'nav',
    { class: 'sidebar' },
    h('div', { class: 'brand' }, icon('coins', { size: 22 }), h('span', {}, t('app.title'))),
    h(
      'ul',
      { class: 'nav-list' },
      ROUTES.map((r) =>
        h(
          'li',
          {},
          h(
            'a',
            { href: `#/${r.id}`, class: `nav-link${r.id === route.id ? ' active' : ''}`, dataset: { route: r.id } },
            icon(r.icon),
            h('span', {}, t(r.label))
          )
        )
      )
    ),
    h(
      'div',
      { class: 'sidebar-footer' },
      h(
        'div',
        { class: 'sidebar-prefs' },
        h(
          'div',
          { class: 'lang-switch', role: 'group', 'aria-label': t('settings.general.language') },
          ['en', 'ko'].map((lang) =>
            h(
              'button',
              {
                class: `lang-btn${getLang() === lang ? ' active' : ''}`,
                dataset: { lang },
                onclick: () => ctx.setLanguage(lang).catch((e) => toast(errorMessage(e), 'error')),
              },
              t(`lang.${lang}`)
            )
          )
        ),
        themeToggle()
      ),
      h('div', { class: 'user-chip', title: t('nav.signedInAs') }, icon('shield', { size: 14 }), h('span', { class: 'user-name' }, ctx.user ? ctx.user.username : '')),
      h('button', { class: 'btn btn-ghost btn-block', id: 'logout-btn', onclick: () => ctx.logout() }, icon('logout', { size: 16 }), t('nav.logout'))
    )
  );
  root.append(h('div', { class: 'shell' }, nav, content));
  app.page = { route, instance: route.mount(content, { ...ctx, params }) || {} };
}

function render() {
  if (!app.auth || app.auth.stage !== 'authenticated') renderLogin();
  else renderShell();
}

let lastHash = location.hash;
window.addEventListener('hashchange', async () => {
  if (app.ignoreHash) {
    app.ignoreHash = false;
    return;
  }
  if (!app.auth || app.auth.stage !== 'authenticated') return;
  const ok = await leaveCurrentPage();
  if (!ok) {
    app.ignoreHash = true;
    location.hash = lastHash;
    return;
  }
  lastHash = location.hash;
  renderShell();
});

setAuthRequiredHandler(async () => {
  app.auth = await call('auth:status');
  if (app.auth.stage !== 'authenticated') render();
});

window.addEventListener('error', (e) => console.error(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
  toast(errorMessage(e.reason), 'error');
});

async function boot() {
  try {
    await applySettings(await call('settings:get'));
    await reloadLanguage();
    app.auth = await call('auth:status');
    if (!location.hash) {
      app.ignoreHash = false;
      history.replaceState(null, '', '#/purchases');
    }
    lastHash = location.hash;
    render();
  } catch (err) {
    console.error(err);
    root.textContent = `Failed to start: ${err.message}`;
  }
}

boot();
