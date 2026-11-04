import { api, confirmDialog, html, icon, render, toast, toastError } from '../lib.js';
import { pageHead } from './shared.js';

export default async function system(root, ctx) {
  const canWrite = ctx.can('gateway:write');
  render(
    root,
    html`<div class="page">
      ${pageHead(
        'Configuration',
        'Daemon settings read from jasmin.cfg (secrets hidden), and snapshot / persistence of the routing configuration.',
        html`<a class="btn" href="/api/system/export">${icon('download')} Export snapshot</a>${canWrite ? html`<button class="btn primary" data-persist>${icon('save')} Persist now</button>` : ''}`
      )}
      <div class="banner info">${icon('info')}<div>Every change made from this console is persisted automatically. jCLI keeps filters and HTTP connectors per session until they are persisted, so unpersisted changes made in another jCLI session are not visible here until that session runs <code>persist</code>.</div></div>
      <div class="grid grid-3" style="margin-bottom:16px" data-status></div>
      <section class="card"><div class="card-head"><div><h2>jasmin.cfg</h2><p data-path></p></div></div><div class="card-body" data-cfg><div class="skeleton"></div></div></section>
    </div>`
  );
  const $ = (s) => root.querySelector(s);
  const s = ctx.status || (await api('/api/status').catch(() => null));
  render(
    $('[data-status]'),
    html`<div class="kpi"><div class="kpi-label">${icon('terminal')} jCLI</div><div class="kpi-value" style="font-size:18px">${s?.jcli ? `${s.jcli.host}:${s.jcli.port}` : '—'}</div><div class="kpi-foot">${s?.jcli?.connected ? html`<span class="text-ok">Connected</span>` : html`<span class="text-err">${s?.jcli?.error || 'Disconnected'}</span>`}</div></div>
      <div class="kpi"><div class="kpi-label">${icon('globe')} HTTP API</div><div class="kpi-value" style="font-size:18px">${s?.httpApi || '—'}</div><div class="kpi-foot">Used by “Send test SMS”</div></div>
      <div class="kpi"><div class="kpi-label">${icon('database')} Jasmin version</div><div class="kpi-value" style="font-size:18px">${s?.jasminVersion || '—'}</div><div class="kpi-foot">${s?.amqp?.connected ? 'Traffic tap connected' : 'Traffic tap offline'}</div></div>`
  );
  try {
    const cfg = await api('/api/config');
    $('[data-path]').textContent = cfg.exists ? cfg.filePath : `Not found at ${cfg.filePath}. Mount jasmin.cfg into the console container to show it here.`;
    const sections = Object.entries(cfg.sections);
    render(
      $('[data-cfg]'),
      sections.length
        ? html`<div class="grid grid-2">${sections.map(
            ([name, values]) => html`<div style="border:1px solid var(--border);border-radius:var(--r);padding:12px 14px"><div class="mono strong" style="margin-bottom:8px;color:var(--brand-hi)">[${name}]</div>
              ${Object.keys(values).length ? html`<dl class="kv">${Object.entries(values).map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>` : html`<span class="muted">Defaults only</span>`}</div>`
          )}</div>`
        : html`<div class="empty">${icon('sliders')}<h3>No configuration file</h3></div>`
    );
  } catch (err) {
    toastError(err);
  }
  const persist = $('[data-persist]');
  if (persist)
    persist.onclick = async () => {
      if (!(await confirmDialog({ title: 'Persist configuration?', message: 'Writes the current users, connectors, filters and routes to Jasmin’s store on disk so they survive a restart.', confirmText: 'Persist' }))) return;
      try {
        await api('/api/system/persist', { method: 'POST' });
        toast('Configuration persisted to disk', 'ok');
      } catch (err) {
        toastError(err);
      }
    };
}
