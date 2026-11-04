import { api, html, icon, render } from './lib.js';

const card = document.getElementById('card');
const params = new URLSearchParams(location.search);
const next = params.get('next') && params.get('next').startsWith('/') && !params.get('next').startsWith('//') ? params.get('next') : '/';

const brand = html`<div class="login-brand"><img src="/assets/icon.svg" alt=""><div><h1>Jasmin Console</h1><div class="muted" style="font-size:13px">SMS gateway management</div></div></div>`;

async function showPending() {
  let who = '';
  try {
    const me = await api('/api/auth/me', { redirect401: false });
    if (me.user.status === 'active') return (location.href = '/');
    who = me.user.displayName || me.user.username;
  } catch {}
  render(card, html`${brand}<div class="pending">${icon('clock')}<h2 style="font-size:16px;margin-bottom:6px">Waiting for approval</h2>
    <p class="muted">${who ? html`Signed in as <strong>${who}</strong>. ` : ''}An administrator must approve your account and assign a role before you can use the console.</p>
    <div style="display:flex;gap:8px;justify-content:center;margin-top:18px"><button class="btn" id="check">${icon('refresh')} Check again</button><button class="btn ghost" id="out">${icon('logout')} Sign out</button></div></div>`);
  document.getElementById('check').onclick = showPending;
  document.getElementById('out').onclick = async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch {}
    location.href = '/login';
  };
}

async function showLogin() {
  let providers = { oidc: null };
  try { providers = await api('/auth/providers'); } catch {}
  const error = params.get('error');
  render(card, html`${brand}
    ${error ? html`<div class="banner err">${icon('alert')}<div>${error}</div></div>` : ''}
    ${providers.oidc ? html`<a class="btn primary block" href="/auth/oidc/login">${icon('shield')} Sign in with ${providers.oidc.name}</a><div class="or">or use a local account</div>` : ''}
    <form id="form" novalidate>
      <div class="banner err" id="err" hidden>${icon('alert')}<div></div></div>
      <div class="field"><label for="u">Username</label><input class="input" id="u" name="username" autocomplete="username" required autofocus></div>
      <div class="field"><label for="p">Password</label><input class="input" id="p" name="password" type="password" autocomplete="current-password" required></div>
      <button class="btn ${providers.oidc ? '' : 'primary'} block" type="submit" id="submit">Sign in</button>
    </form>`);
  const form = document.getElementById('form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = document.getElementById('err');
    const btn = document.getElementById('submit');
    err.hidden = true;
    btn.disabled = true;
    try {
      await api('/auth/login', { method: 'POST', body: { username: form.username.value.trim(), password: form.password.value } });
      location.href = next;
    } catch (ex) {
      err.querySelector('div').textContent = ex.message;
      err.hidden = false;
      form.password.value = '';
      form.password.focus();
    } finally {
      btn.disabled = false;
    }
  };
}

if (params.get('pending')) showPending();
else {
  // Already signed in? Go straight to the console.
  api('/api/auth/me', { redirect401: false }).then((me) => (me.user.status === 'pending' ? showPending() : (location.href = next))).catch(showLogin);
}
