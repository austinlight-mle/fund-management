import { h, clear, field, formError, showFormError, toast } from '../dom.js';
import { t, getLang, errorMessage } from '../i18n.js';
import { icon } from '../icons.js';

/** Login flow: password -> (authenticator code) -> (forced credential change). */
export function mountLogin(container, ctx) {
  const wrap = h('div', { class: 'login-screen' });
  container.append(wrap);

  const card = (title, subtitle, ...body) =>
    h(
      'div',
      { class: 'login-card' },
      h(
        'div',
        { class: 'login-top' },
        h('div', { class: 'brand brand-lg' }, icon('coins', { size: 26 }), h('span', {}, t('app.title'))),
        h(
          'div',
          { class: 'login-prefs' },
          h(
            'div',
            { class: 'lang-switch' },
            ['en', 'ko'].map((lang) =>
              h(
                'button',
                {
                  type: 'button',
                  class: `lang-btn${getLang() === lang ? ' active' : ''}`,
                  dataset: { lang },
                  onclick: () => ctx.setLanguage(lang),
                },
                t(`lang.${lang}`)
              )
            )
          ),
          ctx.themeToggle()
        )
      ),
      h('h1', { class: 'login-title' }, title),
      subtitle ? h('p', { class: 'login-subtitle' }, subtitle) : null,
      ...body
    );

  const show = (node) => {
    clear(wrap);
    wrap.append(node);
    const first = node.querySelector('input');
    if (first) first.focus();
  };

  function passwordStep() {
    const username = h('input', { name: 'username', id: 'login-username', autocomplete: 'username', required: true });
    const password = h('input', { name: 'password', id: 'login-password', type: 'password', autocomplete: 'current-password', required: true });
    const error = formError();
    const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block', id: 'login-submit' }, t('login.submit'));
    const form = h(
      'form',
      {
        class: 'login-form',
        onsubmit: async (e) => {
          e.preventDefault();
          submit.disabled = true;
          showFormError(error, '');
          try {
            const status = await ctx.call('auth:login', { username: username.value, password: password.value });
            next(status);
          } catch (err) {
            showFormError(error, errorMessage(err));
            password.select();
          } finally {
            submit.disabled = false;
          }
        },
      },
      field(t('login.username'), username),
      field(t('login.password'), password),
      error,
      submit
    );
    show(
      card(
        t('login.title'),
        null,
        form,
        ctx.status && ctx.status.defaultCredentials
          ? h('p', { class: 'login-hint' }, icon('info', { size: 14 }), t('login.defaultHint'))
          : null
      )
    );
  }

  function secondFactorStep() {
    let recovery = false;
    const code = h('input', { name: 'code', id: 'login-code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 11, required: true });
    const label = h('span', { class: 'field-label' }, t('login.code'));
    const error = formError();
    const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block', id: 'login-verify' }, t('login.verify'));
    const toggle = h(
      'button',
      {
        type: 'button',
        class: 'btn-link',
        onclick: () => {
          recovery = !recovery;
          label.textContent = recovery ? t('login.recoveryCode') : t('login.code');
          toggle.textContent = recovery ? t('login.useAuthenticator') : t('login.useRecovery');
          code.setAttribute('inputmode', recovery ? 'text' : 'numeric');
          code.value = '';
          code.focus();
        },
      },
      t('login.useRecovery')
    );
    const form = h(
      'form',
      {
        class: 'login-form',
        onsubmit: async (e) => {
          e.preventDefault();
          submit.disabled = true;
          showFormError(error, '');
          try {
            next(await ctx.call('auth:verifySecondFactor', { code: code.value }));
          } catch (err) {
            if (err.code === 'error.auth.secondFactorExpired') {
              toast(errorMessage(err), 'error');
              return passwordStep();
            }
            showFormError(error, errorMessage(err));
            code.select();
          } finally {
            submit.disabled = false;
          }
        },
      },
      h('label', { class: 'field' }, label, code),
      error,
      submit,
      h('div', { class: 'login-links' }, toggle, h('button', { type: 'button', class: 'btn-link', onclick: async () => passwordStep(await ctx.call('auth:logout')) }, t('login.back')))
    );
    show(card(t('login.twoFactorTitle'), t('login.twoFactorHelp'), form));
  }

  function mustChangeStep(status) {
    const current = h('input', { type: 'password', id: 'change-current', autocomplete: 'current-password', required: true });
    const username = h('input', { id: 'change-username', value: status.user ? status.user.username : '', autocomplete: 'username' });
    const pw = h('input', { type: 'password', id: 'change-new', autocomplete: 'new-password', required: true });
    const pw2 = h('input', { type: 'password', id: 'change-confirm', autocomplete: 'new-password', required: true });
    const error = formError();
    const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block', id: 'change-submit' }, t('login.changeSubmit'));
    const form = h(
      'form',
      {
        class: 'login-form',
        onsubmit: async (e) => {
          e.preventDefault();
          showFormError(error, '');
          if (pw.value !== pw2.value) return showFormError(error, t('account.passwordMismatch'));
          submit.disabled = true;
          try {
            const result = await ctx.call('auth:changeCredentials', {
              currentPassword: current.value,
              newUsername: username.value,
              newPassword: pw.value,
            });
            toast(t('account.changed'), 'success');
            next(result);
          } catch (err) {
            showFormError(error, errorMessage(err));
          } finally {
            submit.disabled = false;
          }
        },
      },
      field(t('account.currentPassword'), current),
      field(t('account.newUsername'), username, t('account.usernameHint')),
      field(t('account.newPassword'), pw, t('account.passwordHint')),
      field(t('account.confirmPassword'), pw2),
      error,
      submit,
      h('div', { class: 'login-links' }, h('button', { type: 'button', class: 'btn-link', onclick: async () => passwordStep(await ctx.call('auth:logout')) }, t('nav.logout')))
    );
    show(card(t('login.mustChangeTitle'), t('login.mustChangeHelp'), form));
  }

  function next(status) {
    if (status.stage === 'second_factor') return secondFactorStep();
    if (status.stage === 'must_change') return mustChangeStep(status);
    if (status.stage === 'authenticated') return ctx.onAuthenticated(status);
    return passwordStep();
  }

  next(ctx.status || { stage: 'anonymous' });
  return {};
}
