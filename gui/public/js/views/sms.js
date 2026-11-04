import { api, html, icon, on, render, toastError } from '../lib.js';
import { pageHead, statusBadge } from './shared.js';

export default async function sms(root, ctx) {
  let users = [];
  try {
    users = (await ctx.state()).users;
  } catch {}
  render(
    root,
    html`<div class="page">
      ${pageHead('Send test SMS', 'Submits a message through Jasmin’s HTTP API exactly like a client application would, using a gateway user’s credentials.')}
      <div class="grid grid-2" style="align-items:start">
        <section class="card">
          <div class="card-head"><h2>Message</h2></div>
          <form class="card-body" data-form autocomplete="off">
            <div class="form-row">
              <div class="field"><label for="m-user">Gateway username <span class="text-err">*</span></label>
                <input class="input mono" id="m-user" name="username" required list="m-users" placeholder="username">
                <datalist id="m-users">${users.map((u) => html`<option value="${u.username}">${u.uid}</option>`)}</datalist></div>
              <div class="field"><label for="m-pass">Password <span class="text-err">*</span></label><input class="input" id="m-pass" type="password" name="password" required autocomplete="new-password"></div>
            </div>
            <div class="form-row">
              <div class="field"><label for="m-from">Sender ID</label><input class="input mono" id="m-from" name="from" placeholder="Optional"></div>
              <div class="field"><label for="m-to">Recipient <span class="text-err">*</span></label><input class="input mono" id="m-to" name="to" required placeholder="201012345678"></div>
            </div>
            <div class="field"><label for="m-text">Content <span class="text-err">*</span></label><textarea class="textarea" id="m-text" name="content" rows="4" required maxlength="1600"></textarea>
              <span class="hint" data-len>0 characters</span></div>
            <label class="checkbox" style="margin-bottom:14px"><input type="checkbox" name="dlr"> Request a delivery receipt</label>
            <button class="btn primary" type="submit" style="width:100%">${icon('send')} Send message</button>
          </form>
        </section>
        <section class="card"><div class="card-head"><div><h2>Result</h2><p>Response from Jasmin and live status from the traffic tap</p></div></div><div class="card-body" data-result>
          <div class="empty">${icon('send')}<h3>Nothing sent yet</h3></div></div></section>
      </div>
    </div>`
  );
  const form = root.querySelector('[data-form]');
  const out = root.querySelector('[data-result]');
  let tracking = null;
  form.content.addEventListener('input', () => {
    const t = form.content.value;
    // GSM-7 messages split at 153 chars per part; anything outside basic Latin is sent as UCS-2 (67 per part).
    const ucs = /[^\x00-\x7f]/.test(t);
    const per = ucs ? (t.length > 70 ? 67 : 70) : t.length > 160 ? 153 : 160;
    root.querySelector('[data-len]').textContent = `${t.length} characters · ${Math.max(1, Math.ceil(t.length / per))} part(s) · ${ucs ? 'UCS-2' : 'GSM-7'}`;
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const body = Object.fromEntries(new FormData(form));
    body.dlr = form.dlr.checked;
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const r = await api('/api/sms/send', { method: 'POST', body });
      tracking = r.messageId;
      render(
        out,
        html`<div class="banner ${r.success ? 'info' : 'err'}">${icon(r.success ? 'check' : 'alert')}<div><strong>${r.success ? 'Accepted by Jasmin' : `Rejected (HTTP ${r.status})`}</strong></div></div>
          <dl class="kv"><dt>Response</dt><dd>${r.response}</dd>${r.messageId ? html`<dt>Message ID</dt><dd>${r.messageId}</dd><dt>Status</dt><dd data-live>${statusBadge('SUBMITTED')}</dd>` : ''}</dl>`
      );
    } catch (err) {
      toastError(err);
    } finally {
      btn.disabled = false;
    }
  };
  const update = (m) => {
    if (m.msgid === tracking) {
      const el = out.querySelector('[data-live]');
      if (el) render(el, html`${statusBadge(m.status)}${m.routedCid ? html` <span class="chip">${m.routedCid}</span>` : ''}${m.latencyMs ? html` <span class="muted">${m.latencyMs} ms</span>` : ''}`);
    }
  };
  const offs = [on('traffic:new', update), on('traffic:update', update)];
  return () => offs.forEach((f) => f());
}
