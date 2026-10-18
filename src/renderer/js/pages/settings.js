import { h, clear, toast, confirmDialog, openDialog, field, formError, showFormError, debounce } from '../dom.js';
import { t, errorMessage } from '../i18n.js';
import { icon } from '../icons.js';
import { formatDateTime } from '../format.js';

const TABS = ['general', 'account', 'security', 'users', 'dictionary', 'data'];
let rememberedTab = 'general';

export function mountSettings(container, ctx) {
  const { call } = ctx;
  let tab = TABS.includes(ctx.params.tab) ? ctx.params.tab : rememberedTab;

  const tabBar = h('div', { class: 'tabs', role: 'tablist' });
  const panel = h('div', { class: 'tab-panel card', id: 'settings-panel' });
  container.append(h('div', { class: 'page settings-page' }, h('div', { class: 'page-header' }, h('h2', {}, t('settings.title'))), tabBar, panel));

  function renderTabs() {
    clear(tabBar);
    for (const id of TABS) {
      tabBar.append(
        h(
          'button',
          {
            class: `tab${id === tab ? ' active' : ''}`,
            role: 'tab',
            id: `tab-${id}`,
            'aria-selected': String(id === tab),
            onclick: () => {
              tab = id;
              rememberedTab = id;
              renderTabs();
              renderPanel();
            },
          },
          t(`settings.tab.${id}`)
        )
      );
    }
  }

  function renderPanel() {
    clear(panel);
    const renderers = { general, account, security, users, dictionary, data };
    renderers[tab]().catch((err) => toast(errorMessage(err), 'error'));
  }

  // ---- general -----------------------------------------------------------
  async function general() {
    const settings = ctx.settings;
    const language = h(
      'select',
      { id: 'setting-language' },
      settings.languages.map((l) => h('option', { value: l, selected: l === settings.language }, t(`lang.${l}`)))
    );
    const theme = h(
      'select',
      { id: 'setting-theme' },
      settings.themes.map((th) => h('option', { value: th, selected: th === settings.theme }, t(`theme.${th}`)))
    );
    const currency = h(
      'select',
      { id: 'setting-currency' },
      settings.currencies.map((c) => h('option', { value: c, selected: c === settings.currency }, t(`currency.${c}`)))
    );
    language.addEventListener('change', async () => {
      rememberedTab = 'general';
      await ctx.setLanguage(language.value);
    });
    theme.addEventListener('change', async () => {
      try {
        await ctx.setTheme(theme.value);
        toast(t('common.saved'), 'success');
      } catch (err) {
        toast(errorMessage(err), 'error');
      }
    });
    currency.addEventListener('change', async () => {
      try {
        await call('settings:set', { key: 'currency', value: currency.value });
        toast(t('common.saved'), 'success');
        rememberedTab = 'general';
        await ctx.refreshApp();
      } catch (err) {
        toast(errorMessage(err), 'error');
      }
    });
    panel.append(
      h('h3', {}, t('settings.tab.general')),
      field(t('settings.general.language'), language, t('settings.general.languageHint')),
      field(t('settings.general.theme'), theme),
      field(t('settings.general.currency'), currency, t('settings.general.currencyHint'))
    );
  }

  // ---- account -----------------------------------------------------------
  async function account() {
    const current = h('input', { type: 'password', id: 'account-current', autocomplete: 'current-password', required: true });
    const username = h('input', { id: 'account-username', value: ctx.user.username, autocomplete: 'username' });
    const pw = h('input', { type: 'password', id: 'account-new', autocomplete: 'new-password', required: true });
    const pw2 = h('input', { type: 'password', id: 'account-confirm', autocomplete: 'new-password', required: true });
    const error = formError();
    panel.append(
      h('h3', {}, t('account.title')),
      h(
        'form',
        {
          class: 'narrow-form',
          onsubmit: async (e) => {
            e.preventDefault();
            showFormError(error, '');
            if (pw.value !== pw2.value) return showFormError(error, t('account.passwordMismatch'));
            try {
              await call('auth:changeCredentials', { currentPassword: current.value, newUsername: username.value, newPassword: pw.value });
              toast(t('account.changed'), 'success');
              rememberedTab = 'account';
              await ctx.refreshApp();
            } catch (err) {
              showFormError(error, errorMessage(err));
            }
          },
        },
        field(t('account.currentPassword'), current),
        field(t('account.newUsername'), username, t('account.usernameHint')),
        field(t('account.newPassword'), pw, t('account.passwordHint')),
        field(t('account.confirmPassword'), pw2),
        error,
        h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'btn btn-primary', id: 'account-save' }, t('account.save')))
      )
    );
  }

  // ---- security / 2FA ----------------------------------------------------
  function showRecoveryCodes(codes) {
    openDialog({
      title: t('security.recoveryTitle'),
      body: [
        h('p', {}, t('security.recoveryHelp')),
        h('ul', { class: 'recovery-codes', id: 'recovery-codes' }, codes.map((c) => h('li', {}, h('code', {}, c)))),
      ],
      actions: [
        {
          id: 'copy',
          label: t('security.copy'),
          onClick: async () => {
            await navigator.clipboard.writeText(codes.join('\n')).catch(() => {});
            toast(t('security.copied'), 'success');
            return false;
          },
        },
        { id: 'done', label: t('security.savedCodes'), kind: 'primary', submit: true },
      ],
    });
  }

  function passwordPrompt(title, message) {
    return new Promise((resolve) => {
      const pw = h('input', { type: 'password', id: 'prompt-password', autocomplete: 'current-password', required: true, autofocus: true });
      let value = null;
      openDialog({
        title,
        body: [h('p', {}, message), field(t('account.currentPassword'), pw)],
        actions: [
          { id: 'cancel', label: t('common.cancel') },
          { id: 'ok', label: t('common.confirm'), kind: 'primary', submit: true, onClick: () => (value = pw.value) || false },
        ],
        onClose: () => resolve(value),
      });
    });
  }

  async function security() {
    const status = await call('auth:status');
    const enabled = status.user && status.user.totp_enabled;
    panel.append(
      h('h3', {}, t('security.title')),
      h('p', { class: 'muted' }, t('security.intro')),
      h(
        'div',
        { class: `status-line ${enabled ? 'on' : 'off'}`, id: 'totp-status' },
        icon('shield', { size: 18 }),
        enabled ? t('security.enabled') : t('security.disabled')
      )
    );
    if (!enabled) {
      const setupHost = h('div', { class: 'totp-setup', id: 'totp-setup' });
      panel.append(
        h('button', { class: 'btn btn-primary', id: 'totp-begin', onclick: () => beginSetup(setupHost) }, t('security.enable')),
        setupHost
      );
      return;
    }
    const left = await call('auth:recoveryLeft');
    panel.append(
      h('p', { class: 'muted', id: 'recovery-left' }, t('security.recoveryLeft', { count: left })),
      h(
        'div',
        { class: 'form-actions' },
        h(
          'button',
          {
            class: 'btn',
            id: 'recovery-regenerate',
            onclick: async () => {
              const password = await passwordPrompt(t('security.regenerate'), t('security.regenerateHelp'));
              if (!password) return;
              try {
                const res = await call('auth:recoveryRegenerate', { password });
                showRecoveryCodes(res.recoveryCodes);
                renderPanel();
              } catch (err) {
                toast(errorMessage(err), 'error');
              }
            },
          },
          t('security.regenerate')
        ),
        h(
          'button',
          {
            class: 'btn btn-danger',
            id: 'totp-disable',
            onclick: async () => {
              const password = await passwordPrompt(t('security.disable'), t('security.disableHelp'));
              if (!password) return;
              try {
                await call('auth:totpDisable', { password });
                toast(t('security.disabledToast'), 'success');
                renderPanel();
              } catch (err) {
                toast(errorMessage(err), 'error');
              }
            },
          },
          t('security.disable')
        )
      )
    );
  }

  async function beginSetup(host) {
    clear(host);
    let setup;
    try {
      setup = await call('auth:totpBegin');
    } catch (err) {
      return toast(errorMessage(err), 'error');
    }
    const code = h('input', { id: 'totp-code', inputmode: 'numeric', maxlength: 6, autocomplete: 'one-time-code', placeholder: '123456' });
    const error = formError();
    host.append(
      h('ol', { class: 'steps' }, h('li', {}, t('security.step1')), h('li', {}, t('security.step2')), h('li', {}, t('security.step3'))),
      h(
        'div',
        { class: 'totp-grid' },
        h('img', { src: setup.qr, alt: 'QR', class: 'qr', id: 'totp-qr', width: 220, height: 220 }),
        h(
          'div',
          {},
          h('p', { class: 'small muted' }, t('security.manualEntry')),
          h('code', { class: 'secret', id: 'totp-secret' }, setup.secret.replace(/(.{4})/g, '$1 ').trim()),
          h(
            'form',
            {
              class: 'totp-confirm',
              onsubmit: async (e) => {
                e.preventDefault();
                showFormError(error, '');
                try {
                  const res = await call('auth:totpConfirm', { code: code.value });
                  toast(t('security.enabledToast'), 'success');
                  showRecoveryCodes(res.recoveryCodes);
                  renderPanel();
                } catch (err) {
                  showFormError(error, errorMessage(err));
                }
              },
            },
            field(t('security.codeLabel'), code),
            error,
            h('button', { type: 'submit', class: 'btn btn-primary', id: 'totp-confirm' }, t('security.verifyEnable'))
          )
        )
      )
    );
    code.focus();
  }

  // ---- users -------------------------------------------------------------
  async function users() {
    const list = await call('users:list');
    const addBtn = h('button', { class: 'btn btn-primary', id: 'user-add', onclick: () => openUserDialog() }, icon('plus', { size: 16 }), t('users.add'));
    panel.append(
      h('div', { class: 'panel-header' }, h('h3', {}, t('users.title')), h('div', { class: 'spacer' }), addBtn),
      h('p', { class: 'muted' }, t('users.intro')),
      h(
        'table',
        { class: 'grid', id: 'users-table' },
        h(
          'thead',
          {},
          h('tr', {}, h('th', {}, t('login.username')), h('th', {}, t('users.twoFactor')), h('th', {}, t('users.status')), h('th', {}, t('users.lastLogin')), h('th', {}, t('common.created')), h('th', { class: 'col-actions' }))
        ),
        h(
          'tbody',
          {},
          list.map((u) =>
            h(
              'tr',
              { dataset: { id: u.id } },
              h('td', {}, u.username, u.id === ctx.user.id ? h('span', { class: 'tag tag-fund' }, t('users.you')) : null),
              h('td', {}, u.totp_enabled ? t('common.on') : t('common.off')),
              h('td', {}, u.must_change_password ? t('users.mustChange') : t('users.active')),
              h('td', {}, u.last_login_at ? formatDateTime(u.last_login_at) : '—'),
              h('td', {}, formatDateTime(u.created_at)),
              h(
                'td',
                { class: 'col-actions nowrap' },
                u.id !== ctx.user.id
                  ? [
                      h('button', { class: 'btn btn-small', onclick: () => openUserDialog(u) }, t('users.resetPassword')),
                      h(
                        'button',
                        {
                          class: 'icon-btn row-delete',
                          title: t('common.delete'),
                          onclick: async () => {
                            if (!(await confirmDialog({ title: t('users.deleteTitle'), message: t('users.deleteMessage', { name: u.username }), confirmLabel: t('common.delete'), danger: true }))) return;
                            try {
                              await call('users:remove', { id: u.id });
                              toast(t('common.deleted'), 'success');
                              renderPanel();
                            } catch (err) {
                              toast(errorMessage(err), 'error');
                            }
                          },
                        },
                        icon('trash', { size: 15 })
                      ),
                    ]
                  : null
              )
            )
          )
        )
      )
    );
  }

  function openUserDialog(existing = null) {
    const username = h('input', { id: 'new-user-name', value: existing ? existing.username : '', disabled: Boolean(existing), autofocus: !existing });
    const password = h('input', { id: 'new-user-password', type: 'password', autocomplete: 'new-password', autofocus: Boolean(existing) });
    const error = formError();
    openDialog({
      title: existing ? t('users.resetTitle', { name: existing.username }) : t('users.addTitle'),
      body: [
        field(t('login.username'), username, existing ? null : t('account.usernameHint')),
        field(t('users.tempPassword'), password, t('users.tempPasswordHint')),
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
            try {
              if (existing) await call('users:resetPassword', { id: existing.id, password: password.value });
              else await call('users:create', { username: username.value, password: password.value });
              toast(t('common.saved'), 'success');
              renderPanel();
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

  // ---- dictionary editor -------------------------------------------------
  async function dictionary() {
    const entries = await call('i18n:entries');
    const search = h('input', { type: 'search', id: 'dict-search', class: 'input-search', placeholder: t('dictionary.search') });
    const onlyChanged = h('input', { type: 'checkbox', id: 'dict-changed' });
    const tbody = h('tbody', { id: 'dict-body' });
    const countLabel = h('span', { class: 'muted small' });

    const cell = (entry, lang) => {
      const info = entry[lang];
      const current = info.override ?? info.default;
      const input = h('textarea', { class: `dict-input${info.override !== null ? ' overridden' : ''}`, rows: 1, dataset: { key: entry.key, lang } }, current);
      const reset = h(
        'button',
        {
          class: 'icon-btn',
          title: t('dictionary.reset'),
          hidden: info.override === null,
          onclick: async () => {
            await call('i18n:resetOverride', { lang, key: entry.key });
            info.override = null;
            input.value = info.default;
            input.classList.remove('overridden');
            reset.hidden = true;
            toast(t('dictionary.resetDone'), 'success', 1800);
          },
        },
        icon('x', { size: 13 })
      );
      const commit = async () => {
        const value = input.value;
        if (value === (info.override ?? info.default)) return;
        if (!value.trim() || value === info.default) {
          if (info.override !== null) await call('i18n:resetOverride', { lang, key: entry.key });
          info.override = null;
          input.value = info.default;
          input.classList.remove('overridden');
          reset.hidden = true;
          return;
        }
        try {
          await call('i18n:setOverride', { lang, key: entry.key, value });
          info.override = value;
          input.classList.add('overridden');
          reset.hidden = false;
          toast(t('dictionary.savedOne'), 'success', 1500);
        } catch (err) {
          toast(errorMessage(err), 'error');
        }
      };
      input.addEventListener('change', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          input.blur();
        }
      });
      return h('td', { class: 'dict-cell' }, input, reset);
    };

    const render = () => {
      clear(tbody);
      const q = search.value.trim().toLowerCase();
      const rows = entries.filter((e) => {
        if (onlyChanged.checked && e.en.override === null && e.ko.override === null) return false;
        if (!q) return true;
        return e.key.toLowerCase().includes(q) || [e.en, e.ko].some((x) => (x.override ?? x.default).toLowerCase().includes(q));
      });
      countLabel.textContent = t('dictionary.count', { count: rows.length, total: entries.length });
      for (const e of rows.slice(0, 400)) {
        tbody.append(h('tr', {}, h('td', { class: 'dict-key' }, h('code', {}, e.key)), cell(e, 'en'), cell(e, 'ko')));
      }
    };
    search.addEventListener('input', debounce(render, 150));
    onlyChanged.addEventListener('change', render);

    panel.append(
      h('div', { class: 'panel-header' }, h('h3', {}, t('dictionary.title')), h('div', { class: 'spacer' }), h('button', { class: 'btn', id: 'dict-apply', onclick: () => ((rememberedTab = 'dictionary'), ctx.refreshApp()) }, t('dictionary.apply'))),
      h('p', { class: 'muted' }, t('dictionary.intro')),
      h('div', { class: 'toolbar' }, search, h('label', { class: 'checkbox' }, onlyChanged, t('dictionary.onlyChanged')), h('div', { class: 'spacer' }), countLabel),
      h(
        'div',
        { class: 'table-scroll dict-scroll' },
        h('table', { class: 'grid dict-table' }, h('thead', {}, h('tr', {}, h('th', {}, t('dictionary.key')), h('th', {}, t('lang.en')), h('th', {}, t('lang.ko')))), tbody)
      )
    );
    render();
  }

  // ---- data --------------------------------------------------------------
  async function data() {
    const info = await call('app:info');
    panel.append(
      h('h3', {}, t('settings.tab.data')),
      h(
        'dl',
        { class: 'meta-list' },
        h('dt', {}, t('settings.data.dbFile')),
        h('dd', {}, h('code', { id: 'db-path' }, info.dbFile)),
        h('dt', {}, t('settings.data.version')),
        h('dd', {}, `${info.version} (Electron ${info.electron}, ${info.platform})`)
      ),
      h(
        'div',
        { class: 'form-actions' },
        h(
          'button',
          {
            class: 'btn',
            id: 'data-backup',
            onclick: async () => {
              try {
                const res = await call('data:backup');
                if (!res.canceled) toast(t('settings.data.backupDone', { file: res.file }), 'success', 6000);
              } catch (err) {
                toast(errorMessage(err), 'error');
              }
            },
          },
          t('settings.data.backup')
        ),
        h('button', { class: 'btn', id: 'data-open', onclick: () => call('data:openFolder').catch((err) => toast(errorMessage(err), 'error')) }, t('settings.data.openFolder'))
      ),
      h('p', { class: 'muted small' }, t('settings.data.hint'))
    );
  }

  renderTabs();
  renderPanel();
  return {};
}
