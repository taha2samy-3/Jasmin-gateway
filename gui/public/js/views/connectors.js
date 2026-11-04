import { api, confirmDialog, connectorHealth, formDialog, html, icon, on, render, toast, toastError } from '../lib.js';
import { emptyRow, offlineBanner, pageHead } from './shared.js';

export default async function connectors(root, ctx) {
  const canWrite = ctx.can('gateway:write');
  render(
    root,
    html`<div class="page">
      ${pageHead(
        'Connectors',
        'SMPP client connectors bind to carrier SMSCs to deliver MT messages. HTTP connectors push MO messages to your applications.',
        canWrite ? html`<button class="btn" data-add-http>${icon('plus')} HTTP connector</button><button class="btn primary" data-add-smpp>${icon('plus')} SMPP connector</button>` : ''
      )}
      <div data-banner></div>
      <section class="card" style="margin-bottom:16px">
        <div class="card-head"><div><h2>SMPP client connectors</h2><p>Live session state and counters (stats --smppcs). Updates every 2.5 s.</p></div></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Connector</th><th>Status</th><th>Bound since</th><th class="num">Submits</th><th class="num">Delivers</th><th class="num">Errors</th><th>Used by</th><th></th></tr></thead><tbody data-smpp></tbody></table></div>
      </section>
      <section class="card">
        <div class="card-head"><div><h2>HTTP client connectors</h2><p>Targets for MO routes: Jasmin calls the URL for each inbound message.</p></div></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Connector</th><th>Method</th><th>URL</th><th>Used by</th><th></th></tr></thead><tbody data-http></tbody></table></div>
      </section>
    </div>`
  );
  const $ = (s) => root.querySelector(s);
  let state;
  let live = null;

  function draw() {
    const smpp = live || state.smppConnectors;
    render(
      $('[data-smpp]'),
      smpp.length
        ? smpp.map((c) => {
            const h = connectorHealth(c);
            const routes = state.mtRoutes.filter((r) => r.connectors.includes(`smppc(${c.cid})`)).map((r) => `#${r.order}`);
            const errs = (c.qosErrors || 0) + (c.otherErrors || 0);
            return html`<tr>
              <td class="mono strong">${c.cid}</td>
              <td><span class="badge ${h.level || ''}"><span class="dot ${h.level}"></span>${h.text}</span></td>
              <td class="sub nowrap mono" title="Gateway local time">${c.boundAt || '—'}</td>
              <td class="num mono">${c.submits || '0'}</td><td class="num mono">${c.delivers || '0'}</td>
              <td class="num">${errs ? html`<span class="badge err">${errs}</span>` : html`<span class="muted">0</span>`}</td>
              <td>${routes.length ? html`<div class="chips">${routes.map((r) => html`<span class="chip">${r}</span>`)}</div>` : html`<span class="muted">—</span>`}</td>
              <td class="actions-cell">${canWrite
                ? html`${c.service === 'started'
                    ? html`<button class="btn sm" data-stop="${c.cid}">${icon('stop')} Stop</button>`
                    : html`<button class="btn sm" data-start="${c.cid}">${icon('play')} Start</button>`}
                  <button class="btn ghost sm icon-only" data-del-smpp="${c.cid}" aria-label="Delete ${c.cid}" title="Delete">${icon('trash')}</button>`
                : ''}</td></tr>`;
          })
        : emptyRow(8, 'plug', 'No SMPP connectors', 'Add the SMSC details from your carrier to create one.')
    );
    render(
      $('[data-http]'),
      state.httpConnectors.length
        ? state.httpConnectors.map((c) => {
            const routes = state.moRoutes.filter((r) => r.connectors.includes(`http(${c.cid})`)).map((r) => `MO #${r.order}`);
            return html`<tr><td class="mono strong">${c.cid}</td><td><span class="badge">${c.method}</span></td><td class="mono ellipsis" style="max-width:420px" title="${c.url}">${c.url}</td>
              <td>${routes.length ? html`<div class="chips">${routes.map((r) => html`<span class="chip">${r}</span>`)}</div>` : html`<span class="muted">—</span>`}</td>
              <td class="actions-cell">${canWrite ? html`<button class="btn ghost sm icon-only" data-del-http="${c.cid}" aria-label="Delete ${c.cid}" title="Delete">${icon('trash')}</button>` : ''}</td></tr>`;
          })
        : emptyRow(5, 'globe', 'No HTTP connectors')
    );
  }

  async function load(fresh = false) {
    try {
      state = await ctx.state({ fresh });
      live = null;
      $('[data-banner]').innerHTML = '';
      draw();
    } catch (err) {
      render($('[data-banner]'), offlineBanner(err));
    }
  }
  const changed = async (msg) => {
    toast(msg, 'ok');
    state = await ctx.invalidate();
    live = null;
    draw();
  };

  if (canWrite) {
    $('[data-add-smpp]').onclick = () =>
      formDialog({
        title: 'New SMPP connector',
        description: 'Connection details for the carrier SMSC. The connector is created stopped; start it when ready.',
        submitText: 'Create connector',
        fields: [
          { name: 'cid', label: 'Connector ID', required: true, mono: true, placeholder: 'e.g. carrier_eg_1' },
          { name: 'host', label: 'SMSC host', required: true, row: 'h', mono: true, placeholder: 'smsc.carrier.net' },
          { name: 'port', label: 'Port', type: 'number', required: true, row: 'h', value: 2775, min: 1, max: 65535 },
          { name: 'username', label: 'System ID', required: true, row: 'c', mono: true },
          { name: 'password', label: 'Password', type: 'password', required: true, row: 'c', autocomplete: 'new-password' },
          { name: 'systemType', label: 'System type', mono: true, placeholder: 'Optional' }
        ],
        onSubmit: async (v) => changed((await api('/api/connectors/smpp', { method: 'POST', body: v })).message)
      });
    $('[data-add-http]').onclick = () =>
      formDialog({
        title: 'New HTTP connector',
        submitText: 'Create connector',
        fields: [
          { name: 'cid', label: 'Connector ID', required: true, mono: true, placeholder: 'e.g. crm_inbound' },
          { name: 'url', label: 'URL', required: true, mono: true, placeholder: 'https://app.example.com/sms/inbound' },
          { name: 'method', label: 'Method', type: 'select', options: ['POST', 'GET'], value: 'POST' }
        ],
        onSubmit: async (v) => changed((await api('/api/connectors/http', { method: 'POST', body: v })).message)
      });

    root.addEventListener('click', async (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      try {
        if (t.dataset.start || t.dataset.stop) {
          const cid = t.dataset.start || t.dataset.stop;
          t.disabled = true;
          await changed((await api(`/api/connectors/smpp/${encodeURIComponent(cid)}/${t.dataset.start ? 'start' : 'stop'}`, { method: 'POST' })).message);
        } else if (t.dataset.delSmpp) {
          const cid = t.dataset.delSmpp;
          if (!(await confirmDialog({ title: `Delete connector ${cid}?`, message: 'The connector is stopped and removed. Routes that use it must be changed first.', confirmText: 'Delete', danger: true }))) return;
          await changed((await api(`/api/connectors/smpp/${encodeURIComponent(cid)}`, { method: 'DELETE' })).message);
        } else if (t.dataset.delHttp) {
          const cid = t.dataset.delHttp;
          if (!(await confirmDialog({ title: `Delete HTTP connector ${cid}?`, message: 'MO routes using it must be changed first.', confirmText: 'Delete', danger: true }))) return;
          await changed((await api(`/api/connectors/http/${encodeURIComponent(cid)}`, { method: 'DELETE' })).message);
        }
      } catch (err) {
        toastError(err);
        t.disabled = false;
      }
    });
  }

  const off = on('stats', (d) => {
    if (!state || !d.smppConnectors) return;
    live = d.smppConnectors;
    draw();
  });
  await load();
  return off;
}
