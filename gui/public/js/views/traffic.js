import { api, confirmDialog, debounce, download, fmtDateTime, fmtNum, fmtTime, html, icon, infoDialog, on, render, toast, toastError } from '../lib.js';
import { emptyRow, pageHead, statusBadge } from './shared.js';

const LIMIT = 500;

export default async function traffic(root, ctx) {
  render(
    root,
    html`<div class="page">
      ${pageHead(
        'Live traffic',
        'MT messages observed on RabbitMQ: submission, carrier response (submit_sm_resp) and delivery receipt.',
        html`<button class="btn" data-pause>${icon('pause')} Pause</button><button class="btn" data-csv>${icon('download')} Export CSV</button>
          ${ctx.can('gateway:write') ? html`<button class="btn danger" data-clear>${icon('trash')} Clear</button>` : ''}`
      )}
      <div data-banner></div>
      <div class="kpis" data-kpis></div>
      <section class="card">
        <div class="card-head">
          <div class="toolbar" style="flex:1">
            <div class="search">${icon('search')}<input class="input" data-q placeholder="Search ID, sender, recipient, connector, text…" aria-label="Search messages"></div>
            <div class="seg" data-status role="group" aria-label="Filter by status">
              <button class="on" data-v="">All</button><button data-v="SUBMITTED">Queued</button><button data-v="ESME_ROK">Accepted</button><button data-v="DELIVRD">Delivered</button>
            </div>
          </div>
          <span class="muted" data-count style="font-size:12px"></span>
        </div>
        <div class="table-wrap" style="max-height:calc(100vh - 360px)">
          <table class="table"><thead><tr><th>Time</th><th>Message ID</th><th>From</th><th>To</th><th>Content</th><th>Connector</th><th>Status</th><th class="num">Latency</th><th></th></tr></thead>
          <tbody data-rows></tbody></table>
        </div>
      </section>
    </div>`
  );
  const $ = (s) => root.querySelector(s);
  let messages = [];
  let status = '';
  let paused = false;

  const matches = (m) => {
    const q = $('[data-q]').value.trim().toLowerCase();
    if (status && m.status !== status) return false;
    if (!q) return true;
    return [m.msgid, m.sourceAddr, m.destAddr, m.routedCid, m.shortMessage].some((v) => String(v || '').toLowerCase().includes(q));
  };

  const row = (m) => html`<tr data-id="${m.msgid}">
      <td class="mono nowrap">${fmtTime(m.timestamp)}</td>
      <td class="mono ellipsis" style="max-width:200px" title="${m.msgid}">${m.msgid}</td>
      <td>${m.sourceAddr || html`<span class="muted">—</span>`}</td>
      <td class="mono">${m.destAddr || html`<span class="muted">—</span>`}</td>
      <td class="ellipsis" style="max-width:260px" title="${m.shortMessage}">${m.shortMessage || html`<span class="muted">—</span>`}</td>
      <td>${m.routedCid ? html`<span class="chip">${m.routedCid}</span>` : '—'}</td>
      <td>${statusBadge(m.status)}</td>
      <td class="num mono">${m.latencyMs !== undefined && m.latencyMs !== null ? `${m.latencyMs} ms` : '—'}</td>
      <td class="actions-cell"><button class="btn ghost sm" data-inspect="${m.msgid}">Details</button></td></tr>`;

  function draw() {
    const list = messages.filter(matches);
    $('[data-count]').textContent = `${fmtNum(list.length)} shown`;
    render(
      $('[data-rows]'),
      list.length
        ? list.map(row)
        : emptyRow(9, 'inbox', messages.length ? 'No messages match the filter' : 'No traffic yet', messages.length ? '' : 'Send a message (Tools → Send test SMS) to see it here in real time.')
    );
  }

  function drawStats(s) {
    if (!s) return;
    render(
      $('[data-kpis]'),
      [
        ['Total', s.total, 'activity'],
        ['Queued', s.submitted, 'clock'],
        ['Accepted by carrier', s.esmeRok, 'check'],
        ['Delivered', s.delivered, 'inbox'],
        ['Failed', s.errors, 'alert']
      ].map(([l, v, ic]) => html`<div class="kpi"><div class="kpi-label">${icon(ic)} ${l}</div><div class="kpi-value ${l === 'Failed' && v ? 'text-err' : ''}">${fmtNum(v)}</div></div>`)
    );
  }

  async function load() {
    try {
      const r = await api('/api/traffic', { query: { limit: LIMIT } });
      messages = r.messages;
      drawStats(r.stats);
      $('[data-banner]').innerHTML = '';
      if (!r.connected)
        render($('[data-banner]'), html`<div class="banner warn">${icon('alert')}<div>The traffic tap is not connected to RabbitMQ, so new messages will not appear. Check the AMQP settings of the console.</div></div>`);
      draw();
    } catch (err) {
      toastError(err);
    }
  }

  function upsert(m, isUpdate) {
    const i = messages.findIndex((x) => x.msgid === m.msgid);
    if (i >= 0) messages[i] = m;
    else if (!isUpdate || i < 0) messages.unshift(m);
    if (messages.length > LIMIT) messages.length = LIMIT;
    if (paused) return;
    draw();
    root.querySelector(`tr[data-id="${CSS.escape(m.msgid)}"]`)?.classList.add('flash');
  }

  $('[data-q]').addEventListener('input', debounce(draw, 150));
  $('[data-status]').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    status = b.dataset.v;
    $('[data-status]').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    draw();
  };
  $('[data-pause]').onclick = () => {
    paused = !paused;
    render($('[data-pause]'), html`${icon(paused ? 'play' : 'pause')} ${paused ? 'Resume' : 'Pause'}`);
    if (!paused) draw();
  };
  $('[data-csv]').onclick = () => {
    const list = messages.filter(matches);
    if (!list.length) return toast('Nothing to export', 'warn');
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['time', 'message_id', 'from', 'to', 'content', 'connector', 'status', 'latency_ms', 'smsc_id'].join(',')].concat(
      list.map((m) => [new Date(m.timestamp).toISOString(), m.msgid, m.sourceAddr, m.destAddr, m.shortMessage, m.routedCid, m.status, m.latencyMs ?? '', m.smscId ?? ''].map(q).join(','))
    );
    download(`jasmin-traffic-${Date.now()}.csv`, lines.join('\n'), 'text/csv');
  };
  const clear = $('[data-clear]');
  if (clear)
    clear.onclick = async () => {
      if (!(await confirmDialog({ title: 'Clear live buffer?', message: 'This empties the console’s in-memory message list. Jasmin is not affected.', confirmText: 'Clear', danger: true }))) return;
      await api('/api/traffic', { method: 'DELETE' }).catch(toastError);
      load();
    };
  $('[data-rows]').onclick = async (e) => {
    const id = e.target.closest('[data-inspect]')?.dataset.inspect;
    if (!id) return;
    try {
      const m = await api(`/api/traffic/${encodeURIComponent(id)}`);
      infoDialog(
        `Message ${m.msgid}`,
        html`<dl class="kv" style="margin-bottom:16px">
          <dt>Status</dt><dd>${statusBadge(m.status)}</dd><dt>First seen</dt><dd>${fmtDateTime(m.timestamp)}</dd>
          <dt>From</dt><dd>${m.sourceAddr || '—'}</dd><dt>To</dt><dd>${m.destAddr || '—'}</dd>
          <dt>Connector</dt><dd>${m.routedCid || '—'}</dd><dt>Carrier message ID</dt><dd>${m.smscId || '—'}</dd>
          <dt>Latency</dt><dd>${m.latencyMs !== undefined ? `${m.latencyMs} ms` : '—'}</dd><dt>Routing key</dt><dd>${m.routingKey}</dd>
          <dt>Content</dt><dd style="white-space:pre-wrap">${m.shortMessage || '—'}</dd></dl>
          <div class="label" style="margin-bottom:6px">Decoded PDU</div><pre class="code-block">${JSON.stringify(m.rawPdu ?? {}, null, 2)}</pre>`
      );
    } catch (err) {
      toastError(err);
    }
  };

  const offs = [on('traffic:new', (m) => upsert(m, false)), on('traffic:update', (m) => upsert(m, true)), on('stats', (s) => drawStats(s.traffic))];
  await load();
  return () => offs.forEach((f) => f());
}
