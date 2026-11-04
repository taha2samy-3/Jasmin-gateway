import { api, confirmDialog, fmtAgo, fmtDateTime, formDialog, html, icon, render, toast, toastError } from '../lib.js';
import { emptyRow, pageHead } from './shared.js';

const ROLE_INFO = {
  admin: 'Everything, including console accounts and the audit log',
  operator: 'Change gateway configuration, deploy flows, jCLI console, send test SMS',
  viewer: 'Read-only monitoring; message content is masked'
};

export default async function admin(root, ctx) {
  render(
    root,
    html`<div class="page">
      ${pageHead('Access & audit', 'Console accounts, roles and the audit trail. New single sign-on users wait here for approval.', html`<button class="btn primary" data-add>${icon('plus')} Local account</button>`)}
      <div class="tabs" data-tabs><button class="on" data-tab="accounts">Accounts</button><button data-tab="audit">Audit log</button><button data-tab="roles">Roles</button></div>
      <div data-panel="accounts">
        <section class="card" style="margin-bottom:16px" data-pending-card hidden>
          <div class="card-head"><div><h2>Waiting for approval</h2><p>Signed in through single sign-on for the first time. Approve with a role, or reject.</p></div></div>
          <div class="table-wrap"><table class="table"><thead><tr><th>Account</th><th>Requested</th><th style="width:200px">Role</th><th></th></tr></thead><tbody data-pending></tbody></table></div>
        </section>
        <section class="card">
          <div class="card-head"><div><h2>Accounts</h2></div></div>
          <div class="table-wrap"><table class="table"><thead><tr><th>Account</th><th>Sign-in</th><th>Role</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead><tbody data-users></tbody></table></div>
        </section>
      </div>
      <section class="card" data-panel="audit" hidden>
        <div class="card-head"><div><h2>Audit log</h2><p>Sign-ins, account changes, gateway changes and jCLI console commands (newest first).</p></div>
          <div class="toolbar"><div class="search" style="max-width:260px">${icon('search')}<input class="input" data-aq placeholder="Filter" aria-label="Filter audit log"></div><button class="btn" data-reload>${icon('refresh')}</button></div></div>
        <div class="table-wrap" style="max-height:calc(100vh - 300px)"><table class="table"><thead><tr><th>Time</th><th>Who</th><th>Action</th><th>Target</th><th>Details</th><th>IP</th></tr></thead><tbody data-audit></tbody></table></div>
      </section>
      <section class="card" data-panel="roles" hidden>
        <div class="card-head"><div><h2>Roles</h2><p>Fixed role-based access control. With single sign-on, roles can also come from the identity provider (OIDC_ROLE_MAP).</p></div></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Role</th><th>Can</th></tr></thead><tbody>${Object.entries(ROLE_INFO).map(([r, d]) => html`<tr><td><span class="badge brand">${r}</span></td><td>${d}</td></tr>`)}</tbody></table></div>
      </section>
    </div>`
  );
  const $ = (s) => root.querySelector(s);
  let users = [];
  let audit = [];
  const me = ctx.me.user;
  const roleSelect = (u, attr) => html`<select class="select" ${attr} style="height:28px;width:auto">${['admin', 'operator', 'viewer'].map((r) => html`<option value="${r}" ${u.role === r ? 'selected' : ''}>${r}</option>`)}</select>`;
  const who = (u) => html`<div class="strong">${u.displayName || u.username}${u.id === me.id ? html` <span class="badge">you</span>` : ''}</div><div class="sub mono">${u.email || u.username}</div>`;

  function drawUsers() {
    const pending = users.filter((u) => u.status === 'pending');
    const rest = users.filter((u) => u.status !== 'pending');
    $('[data-pending-card]').hidden = !pending.length;
    render(
      $('[data-pending]'),
      pending.map(
        (u) => html`<tr data-id="${u.id}"><td>${who(u)}</td><td class="sub">${fmtAgo(u.createdAt)}</td>
          <td><select class="select" data-approve-role style="height:28px"><option value="viewer">viewer</option><option value="operator">operator</option><option value="admin">admin</option></select></td>
          <td class="actions-cell"><button class="btn primary sm" data-approve>${icon('userCheck')} Approve</button><button class="btn danger sm" data-reject>Reject</button></td></tr>`
      )
    );
    render(
      $('[data-users]'),
      rest.length
        ? rest.map(
            (u) => html`<tr data-id="${u.id}"><td>${who(u)}</td>
            <td>${u.provider === 'oidc' ? html`<span class="badge info">${icon('shield')} SSO</span>` : html`<span class="badge">${icon('key')} Local</span>`}${u.mustChangePassword ? html` <span class="badge warn">must change password</span>` : ''}</td>
            <td>${u.id === me.id ? html`<span class="badge brand">${u.role}</span>` : roleSelect(u, 'data-role')}</td>
            <td>${u.status === 'active' ? html`<span class="badge ok">active</span>` : html`<span class="badge err">disabled</span>`}</td>
            <td class="sub" title="${fmtDateTime(u.lastLoginAt)}">${fmtAgo(u.lastLoginAt)}</td>
            <td class="actions-cell">${u.id === me.id
              ? ''
              : html`${u.provider === 'local' ? html`<button class="btn ghost sm" data-reset>Reset password</button>` : ''}
                <button class="btn ghost sm" data-toggle>${u.status === 'active' ? 'Disable' : 'Enable'}</button>
                <button class="btn ghost sm icon-only" data-delete aria-label="Delete account" title="Delete">${icon('trash')}</button>`}</td></tr>`
          )
        : emptyRow(6, 'users', 'No accounts')
    );
  }

  function drawAudit() {
    const q = $('[data-aq]').value.trim().toLowerCase();
    const list = audit.filter((e) => !q || JSON.stringify(e).toLowerCase().includes(q));
    const tone = (a) => (/failed|rejected|deleted|disabled/.test(a) ? 'err' : /approved|created|login$/.test(a) ? 'ok' : /terminal/.test(a) ? 'violet' : '');
    render(
      $('[data-audit]'),
      list.length
        ? list.map(
            (e) => html`<tr><td class="mono nowrap sub">${fmtDateTime(e.at)}</td><td class="strong">${e.actor}</td><td><span class="badge ${tone(e.action)}">${e.action}</span></td>
            <td class="mono ellipsis" style="max-width:280px" title="${e.target || ''}">${e.target || ''}</td>
            <td class="mono ellipsis sub" style="max-width:320px" title="${e.detail ? JSON.stringify(e.detail) : ''}">${e.detail ? JSON.stringify(e.detail) : ''}</td><td class="mono sub">${e.ip || ''}</td></tr>`
          )
        : emptyRow(6, 'list', 'No entries')
    );
  }

  async function load() {
    try {
      users = (await api('/api/admin/users')).users.sort((a, b) => a.username.localeCompare(b.username));
      drawUsers();
      ctx.refreshPending?.();
    } catch (err) {
      toastError(err);
    }
  }
  async function loadAudit() {
    try {
      audit = (await api('/api/admin/audit', { query: { limit: 1000 } })).entries;
      drawAudit();
    } catch (err) {
      toastError(err);
    }
  }
  const patch = async (id, body, msg) => {
    try {
      await api(`/api/admin/users/${id}`, { method: 'PATCH', body });
      toast(msg, 'ok');
    } catch (err) {
      toastError(err);
    }
    load();
  };

  $('[data-tabs]').onclick = (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    root.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
    root.querySelectorAll('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== b.dataset.tab));
    if (b.dataset.tab === 'audit') loadAudit();
  };
  $('[data-aq]').addEventListener('input', drawAudit);
  $('[data-reload]').onclick = loadAudit;

  $('[data-add]').onclick = () =>
    formDialog({
      title: 'New local account',
      description: 'For break-glass access or service users. People should normally sign in with single sign-on.',
      submitText: 'Create account',
      fields: [
        { name: 'username', label: 'Username', required: true, mono: true },
        { name: 'displayName', label: 'Display name' },
        { name: 'role', label: 'Role', type: 'select', options: Object.keys(ROLE_INFO).map((r) => [r, `${r}: ${ROLE_INFO[r]}`]), value: 'viewer' },
        { name: 'password', label: 'Initial password', type: 'password', required: true, autocomplete: 'new-password', hint: 'At least 12 characters. The user must change it at first sign-in.' }
      ],
      onSubmit: async (v) => {
        await api('/api/admin/users', { method: 'POST', body: v });
        toast(`Account ${v.username} created`, 'ok');
        load();
      }
    });

  root.addEventListener('change', (e) => {
    if (!e.target.matches('[data-role]')) return;
    const id = e.target.closest('tr').dataset.id;
    patch(id, { role: e.target.value }, 'Role updated');
  });
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    const id = b?.closest('tr')?.dataset.id;
    if (!b || !id) return;
    const u = users.find((x) => x.id === id);
    if (b.matches('[data-approve]')) {
      const role = b.closest('tr').querySelector('[data-approve-role]').value;
      patch(id, { role, status: 'active' }, `${u.username} approved as ${role}`);
    } else if (b.matches('[data-reject]')) {
      if (!(await confirmDialog({ title: `Reject ${u.username}?`, message: 'The access request is removed. The person can sign in again later to create a new request.', confirmText: 'Reject', danger: true }))) return;
      await api(`/api/admin/users/${id}`, { method: 'DELETE' }).then(() => toast('Request rejected', 'ok'), toastError);
      load();
    } else if (b.matches('[data-toggle]')) {
      const disable = u.status === 'active';
      if (disable && !(await confirmDialog({ title: `Disable ${u.username}?`, message: 'Active sessions are ended immediately.', confirmText: 'Disable', danger: true }))) return;
      patch(id, { status: disable ? 'disabled' : 'active' }, disable ? 'Account disabled' : 'Account enabled');
    } else if (b.matches('[data-delete]')) {
      if (!(await confirmDialog({ title: `Delete ${u.username}?`, message: 'The account is removed. Audit entries are kept.', confirmText: 'Delete', danger: true }))) return;
      await api(`/api/admin/users/${id}`, { method: 'DELETE' }).then(() => toast('Account deleted', 'ok'), toastError);
      load();
    } else if (b.matches('[data-reset]')) {
      formDialog({
        title: `Reset password for ${u.username}`,
        submitText: 'Reset password',
        fields: [{ name: 'password', label: 'Temporary password', type: 'password', required: true, autocomplete: 'new-password', hint: 'At least 12 characters; must be changed at next sign-in.' }],
        onSubmit: async (v) => {
          await api(`/api/admin/users/${id}`, { method: 'PATCH', body: { resetPassword: v.password } });
          toast('Password reset; existing sessions were ended', 'ok');
          load();
        }
      });
    }
  });

  await load();
}
