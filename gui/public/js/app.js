import { api, emit, formDialog, html, icon, on, render, toast, toastError } from './lib.js';

const NAV = [
  { group: 'Monitor' },
  { id: 'overview', title: 'Overview', icon: 'gauge', perm: 'gateway:read' },
  { id: 'traffic', title: 'Live traffic', icon: 'activity', perm: 'traffic:read' },
  { group: 'Configure' },
  { id: 'flow', title: 'Flow editor', icon: 'flow', perm: 'gateway:read' },
  { id: 'routing', title: 'Routing & filters', icon: 'route', perm: 'gateway:read' },
  { id: 'users', title: 'Users & groups', icon: 'users', perm: 'gateway:read' },
  { id: 'connectors', title: 'Connectors', icon: 'plug', perm: 'gateway:read' },
  { group: 'Tools' },
  { id: 'simulator', title: 'Route simulator', icon: 'flask', perm: 'gateway:read' },
  { id: 'sms', title: 'Send test SMS', icon: 'send', perm: 'sms:send' },
  { id: 'terminal', title: 'jCLI console', icon: 'terminal', perm: 'terminal:use' },
  { group: 'System' },
  { id: 'system', title: 'Configuration', icon: 'sliders', perm: 'gateway:read' },
  { id: 'admin', title: 'Access & audit', icon: 'shield', perm: 'console:admin' }
];

const ctx = {
  me: null,
  perms: new Set(),
  status: null,
  can(p) {
    return this.perms.has(p);
  },
  _state: null,
  /** Cached gateway state (shared by views); `fresh` bypasses the server cache. */
  state({ fresh = false } = {}) {
    if (!this._state || fresh) {
      this._state = api('/api/state', { query: fresh ? { fresh: 1 } : undefined }).then((s) => {
        emit('state', s);
        return s;
      });
      this._state.catch(() => (this._state = null));
    }
    return this._state;
  },
  invalidate() {
    this._state = null;
    return this.state({ fresh: true });
  }
};

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------
function renderNav(active) {
  const pending = ctx.pendingCount || 0;
  render(
    document.getElementById('nav'),
    html`${NAV.filter((n) => n.group || ctx.can(n.perm)).map((n, i, list) => {
      if (n.group) return list[i + 1] && !list[i + 1].group ? html`<div class="nav-group">${n.group}</div>` : '';
      return html`<a href="#/${n.id}" class="${n.id === active ? 'active' : ''}" data-id="${n.id}">${icon(n.icon)}<span>${n.title}</span>
        ${n.id === 'admin' && pending ? html`<span class="count" title="Accounts waiting for approval">${pending}</span>` : ''}</a>`;
    })}`
  );
}

function renderStatus() {
  const s = ctx.status;
  const jcli = s?.jcli;
  const amqp = s?.amqp;
  render(
    document.getElementById('side-foot'),
    html`<div class="row"><span class="dot ${jcli?.connected ? 'ok' : s ? 'err' : ''}"></span><span>jCLI</span><span>${jcli ? `${jcli.host}:${jcli.port}` : '…'}</span></div>
      <div class="row"><span class="dot ${amqp?.connected ? 'ok' : s ? 'warn' : ''}"></span><span>Traffic tap</span><span>${amqp?.connected ? 'RabbitMQ' : s ? 'offline' : '…'}</span></div>
      <div class="row"><span class="dot ${s?.jasminVersion ? 'ok' : ''}"></span><span>Jasmin</span><span>${s?.jasminVersion ? `v${s.jasminVersion}` : '—'}</span></div>`
  );
}

function renderUser() {
  const u = ctx.me.user;
  const initials = (u.displayName || u.username).split(/[\s.@_-]+/).filter(Boolean).slice(0, 2).map((x) => x[0]).join('');
  render(
    document.getElementById('user-chip'),
    html`<span class="avatar">${initials}</span><span class="who">${u.displayName || u.username}<small>${u.role}</small></span>${icon('chevronDown')}`
  );
}

function userMenu(anchor) {
  document.querySelector('.user-menu')?.remove();
  const u = ctx.me.user;
  const menu = document.createElement('div');
  menu.className = 'user-menu card';
  menu.setAttribute('role', 'menu');
  Object.assign(menu.style, { position: 'fixed', zIndex: 60, minWidth: '230px', padding: '6px', boxShadow: 'var(--shadow-lg)' });
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.right = `${window.innerWidth - r.right}px`;
  render(
    menu,
    html`<div style="padding:8px 10px 10px;border-bottom:1px solid var(--border);margin-bottom:4px">
        <div style="font-weight:600">${u.displayName || u.username}</div>
        <div class="muted" style="font-size:12px">${u.email || u.username} · ${u.provider === 'oidc' ? 'single sign-on' : 'local account'}</div>
      </div>
      ${u.provider === 'local' ? html`<button class="btn ghost" style="width:100%;justify-content:flex-start" data-act="password" role="menuitem">${icon('key')} Change password</button>` : ''}
      <button class="btn ghost" style="width:100%;justify-content:flex-start" data-act="logout" role="menuitem">${icon('logout')} Sign out</button>`
  );
  document.body.appendChild(menu);
  const close = (e) => {
    if (!menu.contains(e.target) && !anchor.contains(e.target)) {
      menu.remove();
      document.removeEventListener('mousedown', close);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', close));
  menu.querySelector('[data-act="logout"]').onclick = logout;
  const pw = menu.querySelector('[data-act="password"]');
  if (pw)
    pw.onclick = () => {
      menu.remove();
      changePassword();
    };
}

export function changePassword(forced = false) {
  formDialog({
    title: forced ? 'Choose a new password' : 'Change password',
    description: forced ? 'This account uses an initial or reset password. Choose a personal password to continue.' : undefined,
    submitText: 'Update password',
    fields: [
      { name: 'current', label: 'Current password', type: 'password', required: true, autocomplete: 'current-password' },
      { name: 'next', label: 'New password', type: 'password', required: true, hint: 'At least 12 characters.', autocomplete: 'new-password' },
      { name: 'confirm', label: 'Repeat new password', type: 'password', required: true, autocomplete: 'new-password' }
    ],
    onSubmit: async (v) => {
      if (v.next !== v.confirm) throw new Error('The new passwords do not match');
      await api('/api/auth/password', { method: 'POST', body: { current: v.current, next: v.next } });
      ctx.me.user.mustChangePassword = false;
      toast('Password updated', 'ok');
    }
  });
}

async function logout() {
  try {
    const r = await api('/auth/logout', { method: 'POST' });
    location.href = r.logoutUrl || '/login';
  } catch {
    location.href = '/login';
  }
}

function applyTheme() {
  const dark = document.documentElement.dataset.theme !== 'light';
  render(document.getElementById('theme-btn'), icon(dark ? 'sun' : 'moon'));
  emit('theme', dark ? 'dark' : 'light');
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
let cleanup = null;
let current = null;

async function route() {
  const id = (location.hash.replace(/^#\/?/, '').split('?')[0] || 'overview').split('/')[0];
  const item = NAV.find((n) => n.id === id && !n.group);
  if (!item || !ctx.can(item.perm)) {
    location.hash = '#/overview';
    return;
  }
  if (current === id) return;
  current = id;
  // Dialogs live on <body>: never let one page's modal float over the next page.
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  document.querySelector('.user-menu')?.remove();
  document.getElementById('app').classList.remove('nav-open');
  renderNav(id);
  render(document.getElementById('crumbs'), html`<span>${NAV.slice(0, NAV.indexOf(item)).reverse().find((n) => n.group)?.group}</span>${icon('chevronRight')}<strong>${item.title}</strong>`);
  document.title = `${item.title} · Jasmin Console`;

  if (cleanup) {
    try {
      cleanup();
    } catch {}
    cleanup = null;
  }
  const main = document.getElementById('main');
  main.scrollTop = 0;
  main.innerHTML = '<div class="page"><div class="skeleton" style="width:220px;height:22px"></div></div>';
  try {
    const mod = await import(`./views/${id}.js`);
    if (current !== id) return;
    main.innerHTML = '';
    cleanup = (await mod.default(main, ctx)) || null;
  } catch (err) {
    console.error(err);
    render(main, html`<div class="page"><div class="banner err">${icon('alert')}<div><strong>This page failed to load.</strong><br>${err.message}</div></div></div>`);
  }
}

// ---------------------------------------------------------------------------
// Live telemetry
// ---------------------------------------------------------------------------
function connectTelemetry(delay = 1000) {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/telemetry`);
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === 'status') {
      ctx.status = { ...(ctx.status || {}), jcli: { ...(ctx.status?.jcli || {}), connected: msg.data.jcli }, amqp: { ...(ctx.status?.amqp || {}), connected: msg.data.amqp }, jasminVersion: msg.data.version || ctx.status?.jasminVersion };
      renderStatus();
    }
    emit(msg.type, msg.type === 'stats' ? { ...msg.data, at: msg.at } : msg.data);
  };
  ws.onopen = () => (delay = 1000);
  ws.onclose = () => setTimeout(() => connectTelemetry(Math.min(delay * 2, 15000)), delay);
}

async function refreshStatus() {
  try {
    ctx.status = await api('/api/status');
    renderStatus();
    emit('status', ctx.status);
  } catch {}
}

async function refreshPending() {
  if (!ctx.can('console:admin')) return;
  try {
    const { users } = await api('/api/admin/users');
    ctx.pendingCount = users.filter((u) => u.status === 'pending').length;
    renderNav(current);
  } catch {}
}
ctx.refreshPending = refreshPending;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function boot() {
  try {
    ctx.me = await api('/api/auth/me');
  } catch {
    return;
  }
  if (ctx.me.user.status === 'pending') {
    location.href = '/login?pending=1';
    return;
  }
  ctx.perms = new Set(ctx.me.permissions);
  renderUser();
  renderStatus();
  render(document.getElementById('menu-btn'), icon('menu'));
  document.getElementById('menu-btn').onclick = () => document.getElementById('app').classList.toggle('nav-open');
  document.getElementById('theme-btn').onclick = () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('jc-theme', next);
    } catch {}
    applyTheme();
  };
  const chip = document.getElementById('user-chip');
  chip.onclick = () => userMenu(chip);
  chip.onkeydown = (e) => (e.key === 'Enter' || e.key === ' ') && userMenu(chip);
  applyTheme();

  window.addEventListener('hashchange', route);
  await route();
  refreshStatus();
  refreshPending();
  setInterval(refreshStatus, 15000);
  setInterval(refreshPending, 30000);
  connectTelemetry();
  if (ctx.me.user.mustChangePassword) changePassword(true);
  on('gateway-changed', () => ctx.invalidate());
})();

