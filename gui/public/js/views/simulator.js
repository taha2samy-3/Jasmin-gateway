import { api, html, icon, render, toastError } from '../lib.js';
import { pageHead, ROUTE_LABEL } from './shared.js';

export default async function simulator(root, ctx) {
  let users = [];
  try {
    users = (await ctx.state()).users;
  } catch {}
  render(
    root,
    html`<div class="page">
      ${pageHead('Route simulator', 'See which MT route and connector Jasmin would pick for a message, and why, without sending anything.')}
      <div class="grid" style="grid-template-columns:minmax(280px,360px) minmax(0,1fr);align-items:start">
        <section class="card">
          <div class="card-head"><h2>Message</h2></div>
          <form class="card-body" data-form>
            <div class="field"><label for="s-uid">User</label><select class="select" id="s-uid" name="uid"><option value="">— any / unknown —</option>${users.map((u) => html`<option value="${u.uid}">${u.uid} (${u.gid})</option>`)}</select></div>
            <div class="field"><label for="s-to">Recipient <span class="text-err">*</span></label><input class="input mono" id="s-to" name="destination_addr" required placeholder="201012345678"></div>
            <div class="field"><label for="s-from">Sender</label><input class="input mono" id="s-from" name="source_addr" placeholder="BANK"></div>
            <div class="field"><label for="s-text">Content</label><textarea class="textarea" id="s-text" name="text" rows="3" placeholder="Your code is 1234"></textarea></div>
            <div class="field"><label for="s-tags">Tags</label><input class="input mono" id="s-tags" name="tags" placeholder="e.g. 5, 21401"><span class="hint">Comma-separated integers for TagFilter.</span></div>
            <button class="btn primary" type="submit" style="width:100%">${icon('flask')} Simulate routing</button>
          </form>
        </section>
        <section class="card"><div class="card-head"><div><h2>Result</h2><p>Routes are evaluated from the highest order down.</p></div></div><div class="card-body" data-result>
          <div class="empty">${icon('route')}<h3>Enter a message to simulate</h3><p>The trace shows every route tested and each filter's verdict.</p></div></div></section>
      </div>
    </div>`
  );
  const form = root.querySelector('[data-form]');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    const out = root.querySelector('[data-result]');
    out.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
    try {
      const r = await api('/api/routes/simulate', { method: 'POST', body });
      const verdictIcon = (m) => (m === true ? html`<span class="text-ok">${icon('check')}</span>` : m === false ? html`<span class="text-err">${icon('x')}</span>` : html`<span class="text-warn">${icon('alert')}</span>`);
      render(
        out,
        html`${r.matched
            ? html`<div class="banner info" style="border-color:color-mix(in srgb,var(--ok) 40%,transparent);background:var(--ok-soft)">${icon('check')}<div>
                <strong>Route #${r.route.order} (${ROUTE_LABEL[r.route.type] || r.route.type})</strong> → ${r.route.connectors.join(r.route.type === 'FailoverMTRoute' ? ' → then ' : ', ')}
                ${r.route.rate ? html`<span class="muted"> · rate ${r.route.rate}</span>` : ''}</div></div>`
            : r.undetermined
              ? html`<div class="banner warn">${icon('alert')}<div>The simulator cannot evaluate one of the filters (e.g. a Python filter), so the outcome is undetermined.</div></div>`
              : html`<div class="banner err">${icon('x')}<div><strong>No route matches.</strong> Jasmin would reject this message ("No route found"). Add a DefaultRoute to catch everything.</div></div>`}
          <div class="trace">${r.trace.length
            ? r.trace.map(
                (t) => html`<div class="trace-row ${t.matched === true ? 'win' : ''}">
              <div><div class="ord">#${t.order}</div><div class="muted" style="font-size:12px">${ROUTE_LABEL[t.type] || t.type}</div></div>
              <div class="verdicts">${t.filters.length ? t.filters.map((f) => html`<div>${verdictIcon(f.matched)}<code>${f.fid}</code><span class="muted">${f.reason}</span></div>`) : html`<div class="muted">No filters (default route)</div>`}</div>
              <div class="chips">${t.connectors.map((c) => html`<span class="chip">${c}</span>`)}</div></div>`
              )
            : html`<div class="empty">No MT routes are configured.</div>`}</div>`
      );
    } catch (err) {
      out.innerHTML = '';
      toastError(err);
    }
  };
}
