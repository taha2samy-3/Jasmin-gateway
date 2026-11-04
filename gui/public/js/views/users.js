import { api, confirmDialog, fmtNum, formDialog, html, icon, render, toast, toastError } from '../lib.js';
import { emptyRow, offlineBanner, pageHead } from './shared.js';

export default async function users(root, ctx) {
  const canWrite = ctx.can('gateway:write');
  render(
    root,
    html`<div class="page">
      ${pageHead(
        'Users & groups',
        'Accounts that submit messages through the HTTP API or bind to the SMPP server. Every user belongs to a group.',
        canWrite ? html`<button class="btn" data-add-group>${icon('plus')} New group</button><button class="btn primary" data-add-user>${icon('plus')} New user</button>` : ''
      )}
      <div data-banner></div>
      <div class="grid" style="grid-template-columns:minmax(0,1fr) 300px;align-items:start">
        <section class="card">
          <div class="card-head"><div><h2>Users</h2><p>Balance and quotas are enforced by Jasmin when billing is enabled.</p></div>
            <div class="search" style="max-width:260px">${icon('search')}<input class="input" data-q placeholder="Filter users" aria-label="Filter users"></div></div>
          <div class="table-wrap"><table class="table"><thead><tr><th>User</th><th>Group</th><th class="num">Balance</th><th class="num">SMS quota</th><th>Throughput (HTTP/SMPP)</th><th></th></tr></thead><tbody data-users></tbody></table></div>
        </section>
        <section class="card">
          <div class="card-head"><div><h2>Groups</h2></div></div>
          <div class="table-wrap"><table class="table"><thead><tr><th>Group</th><th class="num">Users</th><th></th></tr></thead><tbody data-groups></tbody></table></div>
        </section>
      </div>
    </div>`
  );
  const $ = (s) => root.querySelector(s);
  let state;

  function draw() {
    const q = $('[data-q]').value.trim().toLowerCase();
    const list = state.users.filter((u) => !q || `${u.uid} ${u.username} ${u.gid}`.toLowerCase().includes(q));
    render(
      $('[data-users]'),
      list.length
        ? list.map(
            (u) => html`<tr>
            <td><div class="strong mono">${u.uid}</div><div class="sub">${u.username}</div></td>
            <td><span class="chip">${u.gid}</span></td>
            <td class="num mono">${typeof u.balance === 'number' ? fmtNum(u.balance) : html`<span class="muted" title="Not defined: unlimited">∞</span>`}</td>
            <td class="num mono">${u.mtSmsQuota === 'ND' ? html`<span class="muted" title="Not defined: unlimited">∞</span>` : u.mtSmsQuota}</td>
            <td class="mono">${String(u.throughput).replace(/ND/g, '∞')}</td>
            <td class="actions-cell">${canWrite
              ? html`<button class="btn ghost sm" data-edit="${u.uid}">${icon('edit')} Edit</button><button class="btn ghost sm icon-only" data-del="${u.uid}" aria-label="Delete ${u.uid}" title="Delete">${icon('trash')}</button>`
              : ''}</td></tr>`
          )
        : emptyRow(6, 'users', state.users.length ? 'No users match' : 'No users yet', state.users.length ? '' : 'Create a group, then a user, to start sending messages.')
    );
    render(
      $('[data-groups]'),
      state.groups.length
        ? state.groups.map((g) => {
            const n = state.users.filter((u) => u.gid === g.gid).length;
            return html`<tr><td class="mono strong">${g.gid}</td><td class="num">${n}</td>
              <td class="actions-cell">${canWrite ? html`<button class="btn ghost sm icon-only" data-del-group="${g.gid}" aria-label="Delete group ${g.gid}" title="Delete">${icon('trash')}</button>` : ''}</td></tr>`;
          })
        : emptyRow(3, 'layers', 'No groups')
    );
  }

  async function load(fresh = false) {
    try {
      state = await ctx.state({ fresh });
      $('[data-banner]').innerHTML = '';
      draw();
    } catch (err) {
      render($('[data-banner]'), offlineBanner(err));
    }
  }
  const changed = async (msg) => {
    toast(msg, 'ok');
    state = await ctx.invalidate();
    draw();
  };

  $('[data-q]').addEventListener('input', draw);

  if (canWrite) {
    $('[data-add-group]').onclick = () =>
      formDialog({
        title: 'New group',
        submitText: 'Create group',
        fields: [{ name: 'gid', label: 'Group ID', required: true, mono: true, placeholder: 'e.g. wholesale', hint: 'Letters, digits, _ and - (max 25).' }],
        onSubmit: async (v) => changed((await api('/api/groups', { method: 'POST', body: v })).message)
      });

    $('[data-add-user]').onclick = () => {
      if (!state?.groups.length) return toast('Create a group first', 'warn');
      formDialog({
        title: 'New user',
        submitText: 'Create user',
        fields: [
          { name: 'uid', label: 'User ID', required: true, mono: true, row: 'a', placeholder: 'e.g. acme_otp' },
          { name: 'gid', label: 'Group', type: 'select', required: true, row: 'a', options: state.groups.map((g) => g.gid) },
          { name: 'username', label: 'Username', required: true, row: 'b', mono: true, hint: 'Used to authenticate (HTTP & SMPP).' },
          { name: 'password', label: 'Password', type: 'password', required: true, row: 'b', autocomplete: 'new-password', hint: 'SMPP limits passwords to 8 characters.' },
          { name: 'balance', label: 'Balance', type: 'number', step: 'any', min: 0, row: 'c', placeholder: 'Unlimited' },
          { name: 'mtSmsQuota', label: 'SMS quota', type: 'number', min: 0, row: 'c', placeholder: 'Unlimited' },
          { name: 'throughput', label: 'HTTP throughput (msg/s)', type: 'number', step: 'any', min: 0, row: 'c', placeholder: 'Unlimited' }
        ],
        onSubmit: async (v) => changed((await api('/api/users', { method: 'POST', body: v })).message)
      });
    };

    root.addEventListener('click', async (e) => {
      const edit = e.target.closest('[data-edit]')?.dataset.edit;
      const del = e.target.closest('[data-del]')?.dataset.del;
      const delGroup = e.target.closest('[data-del-group]')?.dataset.delGroup;
      if (edit) {
        const u = state.users.find((x) => x.uid === edit);
        formDialog({
          title: `Edit user ${u.uid}`,
          description: 'Leave a field empty to keep its current value.',
          submitText: 'Save changes',
          fields: [
            { name: 'balance', label: 'Balance', type: 'number', step: 'any', min: 0, row: 'a', placeholder: typeof u.balance === 'number' ? String(u.balance) : 'Unlimited' },
            { name: 'mtSmsQuota', label: 'SMS quota', type: 'number', min: 0, row: 'a', placeholder: u.mtSmsQuota === 'ND' ? 'Unlimited' : u.mtSmsQuota },
            { name: 'throughput', label: 'HTTP throughput (msg/s)', type: 'number', step: 'any', min: 0, placeholder: String(u.throughput).split('/')[0].replace('ND', 'Unlimited') },
            { name: 'password', label: 'New password', type: 'password', autocomplete: 'new-password', placeholder: 'Unchanged' }
          ],
          onSubmit: async (v) => {
            const body = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== ''));
            if (!Object.keys(body).length) throw new Error('Nothing changed');
            await changed((await api(`/api/users/${encodeURIComponent(u.uid)}`, { method: 'PATCH', body })).message);
          }
        });
      } else if (del) {
        if (!(await confirmDialog({ title: `Delete user ${del}?`, message: 'The user can no longer submit or receive messages. This is persisted immediately.', confirmText: 'Delete user', danger: true }))) return;
        try {
          await changed((await api(`/api/users/${encodeURIComponent(del)}`, { method: 'DELETE' })).message);
        } catch (err) {
          toastError(err);
        }
      } else if (delGroup) {
        const members = state.users.filter((u) => u.gid === delGroup).length;
        if (
          !(await confirmDialog({
            title: `Delete group ${delGroup}?`,
            message: members ? `Jasmin also deletes the ${members} user(s) in this group.` : 'The group is empty.',
            confirmText: members ? 'Delete group and users' : 'Delete group',
            danger: true
          }))
        )
          return;
        try {
          await changed((await api(`/api/groups/${encodeURIComponent(delGroup)}`, { method: 'DELETE', query: { force: members ? 1 : undefined } })).message);
        } catch (err) {
          toastError(err);
        }
      }
    });
  }

  await load();
}
