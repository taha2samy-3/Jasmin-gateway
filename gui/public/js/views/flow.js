import { api, confirmDialog, download, esc, fmtTime, formDialog, html, icon, infoDialog, on, render, toHtml, toast, toastError } from '../lib.js';
import { FILTER_TYPES, MT_ROUTE_TYPES, NODE_TYPES, isValidId, lintGraph, nodeLabel, normalizeFlow, routeConnectors, routeFilters, validateConnection } from '../flow-rules.js';
import { loadStyle, ROUTE_LABEL } from './shared.js';

const W = 180;
const H = 40;
const POS_KEY = 'jc-flow-positions';
const DRAFT_KEY = 'jc-flow-draft';
const SVGNS = 'http://www.w3.org/2000/svg';
const TYPE_ICON = { ingress: 'globe', user: 'users', interceptor: 'code', filter: 'filter', route: 'route', connector: 'plug' };
const TYPE_COLOR = { ingress: '--st-ingress', user: '--st-user', interceptor: '--st-interceptor', filter: '--st-filter', route: '--st-route', connector: '--st-connector' };

const PALETTE = [
  ['Match', [['filter', 'DestinationAddrFilter', 'Recipient prefix'], ['filter', 'SourceAddrFilter', 'Sender ID'], ['filter', 'ShortMessageFilter', 'Message content'], ['filter', 'UserFilter', 'User'], ['filter', 'GroupFilter', 'Group'], ['filter', 'TagFilter', 'Tag'], ['filter', 'TimeIntervalFilter', 'Time window'], ['filter', 'TransparentFilter', 'Match all']]],
  ['Route', [['route', 'StaticMTRoute', 'Static route'], ['route', 'FailoverMTRoute', 'Failover route'], ['route', 'RandomRoundrobinMTRoute', 'Round-robin route'], ['route', 'DefaultRoute', 'Default route']]],
  ['Deliver', [['connector', 'smpp', 'SMPP connector']]],
  ['Identity', [['user', 'user', 'User']]]
];

const svgIcon = (name, x, y, size = 16) => toHtml(icon(name)).replace('<svg class="icon "', `<svg class="icon ico" x="${x}" y="${y}" width="${size}" height="${size}"`);
const truncate = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
const clone = (g) => JSON.parse(JSON.stringify(g));

function readJson(storage, key, fallback) {
  try {
    return JSON.parse(storage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function writeJson(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {}
}

export default async function flow(root, ctx) {
  loadStyle('/css/flow.css');
  const editable = ctx.can('gateway:write');
  render(
    root,
    html`<div class="fe">
      <div class="fe-bar">
        <span class="title">MT routing flow</span>
        <div class="grp"><button class="btn sm" data-act="undo" title="Undo (Ctrl+Z)" aria-label="Undo">${icon('undo')}</button><button class="btn sm" data-act="redo" title="Redo (Ctrl+Y)" aria-label="Redo">${icon('redo')}</button></div>
        <div class="grp"><button class="btn sm" data-act="zoom-out" aria-label="Zoom out">${icon('minus')}</button><span class="zoom" data-zoom>100%</span><button class="btn sm" data-act="zoom-in" aria-label="Zoom in">${icon('plus')}</button><button class="btn sm" data-act="fit" title="Fit to screen">Fit</button></div>
        <button class="btn sm" data-act="arrange" title="Arrange in columns">${icon('grid')} Arrange</button>
        <button class="btn sm" data-act="focus" title="Hide navigation to give the canvas the whole screen" aria-pressed="false">${icon('maximize')} Focus</button>
        <div class="grp"><button class="btn sm" data-act="import" title="Import flow JSON">${icon('upload')} Import</button><button class="btn sm" data-act="export" title="Export flow JSON">${icon('download')} Export</button></div>
        <div style="flex:1"></div>
        <span data-lint></span>
        <button class="btn sm" data-act="sync" title="Reload the flow from the gateway">${icon('refresh')} Reload</button>
        ${editable ? html`<button class="btn deploy" data-act="deploy" disabled>${icon('rocket')} Deploy <span class="n" data-changes hidden></span></button>` : html`<span class="badge">${icon('eye')} Read-only</span>`}
      </div>
      <aside class="fe-pal" data-pal>
        <div class="search" style="max-width:none">${icon('search')}<input class="input" data-pal-q placeholder="Filter nodes" aria-label="Filter nodes"></div>
        <div data-pal-list></div>
        <p class="pal-note">${editable ? 'Drag a node onto the canvas, then wire output ● to input ●. Double-click to edit.' : 'Your role can view the flow but not change it.'}</p>
      </aside>
      <div class="fe-canvas-wrap" data-wrap>
        <svg class="fe-canvas" data-svg tabindex="0" aria-label="Flow canvas">
          <defs><pattern id="fe-grid" width="20" height="20" patternUnits="userSpaceOnUse"><circle class="fe-grid-dot" cx="1" cy="1" r="1"></circle></pattern></defs>
          <rect data-bg width="100%" height="100%" fill="url(#fe-grid)"></rect>
          <g data-world><g data-wires></g><g data-nodes></g><path class="fe-drag-wire" data-drag-wire d=""></path><rect class="fe-lasso" data-lasso width="0" height="0"></rect></g>
        </svg>
        <div class="fe-banner" data-banner></div>
        <div class="fe-empty" data-empty hidden><div>${icon('flow', 'icon-lg')}<h3 style="color:var(--text);margin:8px 0 4px">Loading flow…</h3></div></div>
        <div class="fe-hint">Drag empty space to pan · Shift+drag to select · Wheel to zoom · Del removes</div>
      </div>
      <aside class="fe-side">
        <div class="tabs" data-side-tabs><button class="on" data-tab="info">Info</button><button data-tab="problems">Problems <span class="badge" data-nprob>0</span></button><button data-tab="debug">Debug</button></div>
        <div class="fe-side-body" data-side></div>
      </aside>
    </div>`
  );

  const $ = (s) => root.querySelector(s);
  const svg = $('[data-svg]');
  const world = $('[data-world]');
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  // ---------------------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------------------
  let graph = { nodes: [], connections: [] };
  let baseline = { nodes: new Map(), wires: new Set() };
  let undoStack = [];
  let redoStack = [];
  let selected = new Set();
  let selectedWire = null;
  let view = { x: 40, y: 30, k: 1 };
  let sideTab = 'info';
  let issues = [];
  const debug = [];
  const counters = new Map();
  let live = null; // last snapshot used for statuses
  let alive = true; // false once the view is unmounted (deferred callbacks must stop)

  const byId = (id) => graph.nodes.find((n) => n.id === id);
  const wireKey = (w) => `${w.from}>${w.to}`;

  function snapshot() {
    undoStack.push(clone(graph));
    if (undoStack.length > 100) undoStack.shift();
    redoStack = [];
  }
  function changed() {
    issues = lintGraph(graph);
    writeJson(sessionStorage, DRAFT_KEY, { graph, baselineAt: baseline.at, liveFingerprint: baseline.fingerprint, dirty: changeCount() > 0 });
    draw();
  }
  function changeCount() {
    let n = 0;
    const ids = new Set();
    for (const node of graph.nodes) {
      ids.add(node.id);
      const b = baseline.nodes.get(node.id);
      if (b === undefined || b !== JSON.stringify(node.data)) n++;
    }
    for (const id of baseline.nodes.keys()) if (!ids.has(id)) n++;
    const wires = new Set(graph.connections.map(wireKey));
    for (const k of wires) if (!baseline.wires.has(k)) n++;
    for (const k of baseline.wires) if (!wires.has(k)) n++;
    return n;
  }
  const isChanged = (node) => baseline.nodes.get(node.id) !== JSON.stringify(node.data);

  // ---------------------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------------------
  function statusOf(node) {
    const d = node.data;
    switch (node.type) {
      case 'ingress':
        return { level: ctx.status?.jcli?.connected ? 'ok' : '', text: `listening :${d.port}` };
      case 'user':
        return { level: d.existing ? 'ok' : 'info', text: d.existing ? `group ${d.gid}` : 'new · will be created' };
      case 'interceptor':
        return { level: 'ok', text: d.type || 'interceptor' };
      case 'filter':
        if (d.inline) return { level: 'warn', text: 'unnamed copy in route' };
        return { level: '', text: `${String(d.type || '').replace('Filter', '')}${d.value ? ` ${truncate(d.value, 18)}` : ''}` };
      case 'route':
        return { level: '', text: `${d.rate ? `rate ${d.rate}` : 'no billing'}${counters.get(node.id) ? ` · ${counters.get(node.id)} msg` : ''}` };
      case 'connector': {
        if (d.missing) return { level: 'err', text: 'missing in gateway' };
        if (!d.existing) return { level: 'info', text: 'new · will be created' };
        const c = live?.find((x) => x.cid === d.cid) || d;
        const sent = counters.get(node.id) ? ` · ${counters.get(node.id)} msg` : '';
        if (c.service !== 'started') return { level: '', text: `stopped${sent}` };
        return /^BOUND/.test(c.session) ? { level: 'ok', text: `${c.session.replace('BOUND_', 'bound ').toLowerCase()}${sent}` } : { level: 'warn', text: `${(c.session || 'connecting').toLowerCase()}${sent}` };
      }
    }
    return { level: '', text: '' };
  }

  function wirePath(a, b) {
    const x1 = a.x + W;
    const y1 = a.y + H / 2;
    const x2 = b.x;
    const y2 = b.y + H / 2;
    const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
  }

  function drawWires() {
    const out = [];
    const routeOrder = new Map();
    for (const w of graph.connections) {
      const a = byId(w.from);
      const b = byId(w.to);
      if (!a || !b) continue;
      const contextual = a.type === 'ingress' || a.type === 'user';
      let label = '';
      if (a.type === 'route' && /Failover|Roundrobin/.test(a.data.type)) {
        const n = (routeOrder.get(a.id) || 0) + 1;
        routeOrder.set(a.id, n);
        const mx = (a.x + W + b.x) / 2;
        const my = (a.y + b.y + H) / 2;
        label = `<text class="fe-wire-order" x="${mx}" y="${my - 4}" text-anchor="middle">${a.data.type === 'FailoverMTRoute' ? n : '⇄'}</text>`;
      }
      const k = esc(wireKey(w));
      out.push(`<g data-wire="${k}"><path class="fe-wire-hit" d="${wirePath(a, b)}"></path><path class="fe-wire${contextual ? ' ctx' : ''}${selectedWire === wireKey(w) ? ' selected' : ''}" d="${wirePath(a, b)}"></path>${label}</g>`);
    }
    $('[data-wires]').innerHTML = out.join('');
  }

  function nodeSvg(node) {
    const spec = NODE_TYPES[node.type];
    const color = css(TYPE_COLOR[node.type]);
    const label = truncate(nodeLabel(node), 19);
    const errs = issues.filter((i) => i.nodeId === node.id && i.level === 'error').length;
    const cls = ['fe-node', selected.has(node.id) ? 'selected' : '', node.data.missing || node.data.inline ? 'ghost' : ''].join(' ');
    return `<g class="${cls}" data-node="${esc(node.id)}" transform="translate(${node.x},${node.y})" style="--c:${color}">
      <rect class="body" width="${W}" height="${H}" rx="6"></rect>
      <path class="band" d="M6,0 H32 V${H} H6 A6,6 0 0 1 0,${H - 6} V6 A6,6 0 0 1 6,0 Z"></path>
      ${svgIcon(TYPE_ICON[node.type], 8, H / 2 - 8)}
      <text class="lbl" x="42" y="${H / 2 + 4.5}">${esc(label)}</text>
      ${spec.inputs ? `<rect class="fe-port" data-port="in" x="-5" y="${H / 2 - 5}" width="10" height="10" rx="2"></rect>` : ''}
      ${spec.outputs ? `<rect class="fe-port" data-port="out" x="${W - 5}" y="${H / 2 - 5}" width="10" height="10" rx="2"></rect>` : ''}
      ${isChanged(node) ? `<circle class="fe-changed" cx="${W - 8}" cy="-1" r="4"><title>Changed, not deployed</title></circle>` : ''}
      ${errs ? `<g transform="translate(${W - 24},-7)"><path class="fe-error" d="M6,0 L12,11 L0,11 Z"></path><title>${errs} problem(s)</title></g>` : ''}
      <g data-status>${statusSvg(node)}</g>
    </g>`;
  }

  function statusSvg(node) {
    const st = statusOf(node);
    if (!st.text) return '';
    const dotColor = { ok: css('--ok'), warn: css('--warn'), err: css('--err'), info: css('--info') }[st.level] || css('--muted');
    return `<circle cx="5" cy="${H + 11}" r="3.5" fill="${dotColor}"></circle><text class="fe-status" x="13" y="${H + 15}">${esc(truncate(st.text, 34))}</text>`;
  }

  /** Refresh only the status lines (live data) without replacing node elements under the pointer. */
  function updateStatuses() {
    for (const node of graph.nodes) {
      const g = root.querySelector(`[data-node="${CSS.escape(node.id)}"] [data-status]`);
      if (g) g.innerHTML = statusSvg(node);
    }
  }

  function drawNodes() {
    $('[data-nodes]').innerHTML = graph.nodes.map(nodeSvg).join('');
  }

  function applyView() {
    if (!alive) return;
    world.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
    const p = $('#fe-grid');
    p.setAttribute('patternTransform', `translate(${view.x},${view.y}) scale(${view.k})`);
    $('[data-zoom]').textContent = `${Math.round(view.k * 100)}%`;
  }

  function drawToolbar() {
    const n = changeCount();
    const btn = $('[data-act="deploy"]');
    if (btn) {
      btn.disabled = n === 0;
      const c = $('[data-changes]');
      c.hidden = n === 0;
      c.textContent = n;
    }
    const errors = issues.filter((i) => i.level === 'error').length;
    const warns = issues.length - errors;
    render(
      $('[data-lint]'),
      errors ? html`<span class="badge err" style="cursor:pointer" data-show-problems>${icon('alert')} ${errors} problem${errors > 1 ? 's' : ''}</span>` : warns ? html`<span class="badge warn" style="cursor:pointer" data-show-problems>${warns} warning${warns > 1 ? 's' : ''}</span>` : html`<span class="badge ok">${icon('check')} Valid</span>`
    );
    $('[data-nprob]').textContent = issues.length;
    $('[data-act="undo"]').disabled = !undoStack.length;
    $('[data-act="redo"]').disabled = !redoStack.length;
  }

  function drawSide() {
    const body = $('[data-side]');
    if (sideTab === 'problems') {
      render(
        body,
        issues.length
          ? issues.map((i) => html`<div class="issue ${i.level}" data-goto="${i.nodeId || ''}">${icon('alert')}<div><div>${i.message}</div>${i.nodeId && byId(i.nodeId) ? html`<div class="muted mono" style="font-size:11px">${nodeLabel(byId(i.nodeId))}</div>` : ''}</div></div>`)
          : html`<div class="empty">${icon('check')}<h3>No problems</h3><p>The flow follows Jasmin's routing rules.</p></div>`
      );
      return;
    }
    if (sideTab === 'debug') {
      render(
        body,
        html`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><span class="muted" style="font-size:12px">Live MT messages (latest 200)</span><button class="btn ghost sm" data-clear-debug>Clear</button></div>
        ${debug.length
          ? debug.map((m) => html`<div class="dbg"><div class="meta"><span>${fmtTime(m.timestamp)}</span><span>${m.status}</span>${m.routedCid ? html`<span>→ ${m.routedCid}</span>` : ''}</div><div class="body">${m.sourceAddr || '?'} → ${m.destAddr || '?'}${m.shortMessage ? html`: ${truncate(m.shortMessage, 80)}` : ''}</div></div>`)
          : html`<div class="empty">${icon('activity')}<h3>Waiting for messages</h3><p>Messages routed to a connector light up its node on the canvas.</p></div>`}`
      );
      return;
    }
    // Info tab
    const ids = [...selected];
    if (ids.length !== 1) {
      const n = graph.nodes;
      render(
        body,
        html`<h3>Flow</h3><p class="muted" style="margin-top:4px">${ids.length > 1 ? `${ids.length} nodes selected.` : 'Select a node to see its details.'}</p>
        <div class="fe-section"><span class="label">Contents</span><dl class="kv">
          ${['user', 'filter', 'route', 'connector'].map((t) => html`<dt>${NODE_TYPES[t].title}s</dt><dd>${n.filter((x) => x.type === t).length}</dd>`)}
          <dt>Undeployed changes</dt><dd>${changeCount()}</dd></dl></div>
        <div class="fe-section"><span class="label">How it works</span><p class="muted" style="font-size:12.5px">Each <b>route</b> is tried from the highest order down. A route matches when <b>all</b> filters wired into it match. The message then goes to the route's connector(s). The default route (order 0) catches everything else. Users and ingress nodes are shown for context; to route by user, wire a <i>User</i> filter.</p></div>`
      );
      return;
    }
    const node = byId(ids[0]);
    if (!node) return;
    const d = node.data;
    const own = issues.filter((i) => i.nodeId === node.id);
    let details;
    if (node.type === 'route') {
      const conns = routeConnectors(graph, node.id);
      const fids = routeFilters(graph, node.id);
      details = html`<dl class="kv"><dt>Type</dt><dd>${d.type}</dd><dt>Order</dt><dd>${d.order}</dd><dt>Rate</dt><dd>${d.rate || 0}</dd></dl>
        <div class="fe-section"><span class="label">Filters (all must match)</span>${fids.length ? html`<div class="chips">${fids.map((f) => html`<span class="chip">${f}</span>`)}</div>` : html`<span class="muted">none</span>`}</div>
        <div class="fe-section"><span class="label">${d.type === 'FailoverMTRoute' ? 'Connectors, in failover order' : 'Connectors'}</span>
          ${conns.length ? html`<div class="fe-order-list">${conns.map((c, i) => html`<div><span class="muted mono">${i + 1}</span><code>smppc(${c})</code>${editable && conns.length > 1 ? html`<button class="btn ghost sm icon-only" data-move="${i}:-1" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button><button class="btn ghost sm icon-only" data-move="${i}:1" aria-label="Move down" ${i === conns.length - 1 ? 'disabled' : ''}>↓</button>` : ''}</div>`)}</div>` : html`<span class="muted">none</span>`}</div>`;
    } else if (node.type === 'filter') {
      details = d.inline
        ? html`<p>This route still uses a filter <code>${d.description}</code> that was deleted or renamed in Jasmin. Edit this node to give it an ID, type and value, then deploy to restore it.</p>`
        : html`<dl class="kv"><dt>Filter ID</dt><dd>${d.fid}</dd><dt>Type</dt><dd>${d.type}</dd><dt>Value</dt><dd>${d.value || '—'}</dd></dl><p class="muted" style="margin-top:10px;font-size:12px">${FILTER_TYPES[d.type]?.hint || ''}</p>`;
    } else if (node.type === 'connector') {
      const c = live?.find((x) => x.cid === d.cid) || d;
      details = html`<dl class="kv"><dt>Connector</dt><dd>smppc(${d.cid})</dd>${d.existing ? html`<dt>Service</dt><dd>${c.service}</dd><dt>Session</dt><dd>${c.session}</dd><dt>Submits</dt><dd>${c.submits}</dd><dt>Delivers</dt><dd>${c.delivers}</dd>` : d.missing ? html`<dt>State</dt><dd class="text-err">not found in gateway</dd>` : html`<dt>Host</dt><dd>${d.host}:${d.port}</dd><dt>System ID</dt><dd>${d.username}</dd>`}</dl>
        ${d.existing ? html`<p class="muted" style="margin-top:10px;font-size:12px">Start, stop or delete the connector on the <a href="#/connectors">Connectors</a> page.</p>` : ''}`;
    } else if (node.type === 'user') {
      details = html`<dl class="kv"><dt>UID</dt><dd>${d.uid}</dd><dt>Group</dt><dd>${d.gid}</dd><dt>Username</dt><dd>${d.username}</dd>${d.existing ? html`<dt>Balance</dt><dd>${d.balance}</dd><dt>Throughput</dt><dd>${d.throughput}</dd>` : ''}</dl>
        <p class="muted" style="margin-top:10px;font-size:12px">${d.existing ? html`Manage quotas on the <a href="#/users">Users</a> page.` : 'This user will be created on deploy.'}</p>`;
    } else if (node.type === 'ingress') {
      details = html`<dl class="kv"><dt>Protocol</dt><dd>${d.protocol === 'smpp' ? 'SMPP v3.4 server' : 'HTTP API'}</dd><dt>Port</dt><dd>${d.port}</dd></dl>`;
    } else {
      details = html`<dl class="kv">${Object.entries(d).filter(([k]) => k !== 'existing').map(([k, v]) => html`<dt>${k}</dt><dd>${typeof v === 'object' ? JSON.stringify(v) : v}</dd>`)}</dl>`;
    }
    render(
      body,
      html`<div style="display:flex;align-items:center;gap:8px"><span class="badge" style="background:color-mix(in srgb,var(${TYPE_COLOR[node.type]}) 20%,transparent);color:var(--text)">${NODE_TYPES[node.type].title}</span>
        ${isChanged(node) ? html`<span class="badge info">changed</span>` : ''}</div>
      <h3 style="margin-top:8px" class="mono">${nodeLabel(node)}</h3>
      <div class="fe-section">${details}</div>
      ${own.length ? html`<div class="fe-section"><span class="label">Problems</span>${own.map((i) => html`<div class="issue ${i.level}">${icon('alert')}<div>${i.message}</div></div>`)}</div>` : ''}
      ${editable && isEditable(node) ? html`<div class="fe-section" style="display:flex;gap:8px"><button class="btn sm" data-edit>${icon('edit')} Edit</button><button class="btn danger sm" data-remove>${icon('trash')} Remove</button></div>` : ''}`
    );
  }

  function draw() {
    drawWires();
    drawNodes();
    drawToolbar();
    drawSide();
    $('[data-empty]').hidden = graph.nodes.length > 0;
  }

  // ---------------------------------------------------------------------------------------
  // Loading & layout
  // ---------------------------------------------------------------------------------------
  function applySavedPositions() {
    const pos = readJson(localStorage, POS_KEY, {});
    for (const n of graph.nodes) if (pos[n.id]) Object.assign(n, pos[n.id]);
  }
  function savePositions() {
    const pos = readJson(localStorage, POS_KEY, {});
    for (const n of graph.nodes) pos[n.id] = { x: Math.round(n.x), y: Math.round(n.y) };
    writeJson(localStorage, POS_KEY, pos);
  }

  /** Content of the live flow (ignoring positions), to tell a changed gateway from a refetch. */
  function liveFingerprint(g) {
    const nodes = g.nodes.map((n) => `${n.id}:${JSON.stringify(n.data)}`).sort();
    return JSON.stringify([nodes, g.connections.map(wireKey).sort()]);
  }

  async function sync({ keepDraft = false } = {}) {
    try {
      const topo = await api('/api/topology');
      const fresh = normalizeFlow(topo);
      baseline = {
        at: topo.fetchedAt,
        fingerprint: liveFingerprint(fresh),
        nodes: new Map(fresh.nodes.map((n) => [n.id, JSON.stringify(n.data)])),
        wires: new Set(fresh.connections.map(wireKey))
      };
      const draft = readJson(sessionStorage, DRAFT_KEY, null);
      if (keepDraft && draft?.dirty && draft.graph) {
        graph = normalizeFlow(draft.graph);
        // The draft was edited against an older gateway state: say so (deploy re-checks anyway).
        const stale = draft.baselineAt && draft.baselineAt !== topo.fetchedAt && draft.liveFingerprint !== liveFingerprint(fresh);
        render(
          $('[data-banner]'),
          stale
            ? html`<div class="banner warn">${icon('alert')}<div>Restored undeployed changes, but the gateway has changed since they were made. Review the deployment carefully: routes added by others may be removed. <button class="btn sm" data-discard style="margin-left:8px">Discard them</button></div></div>`
            : html`<div class="banner info">${icon('info')}<div>Restored undeployed changes from earlier. <button class="btn sm" data-discard style="margin-left:8px">Discard them</button></div></div>`
        );
      } else {
        graph = fresh;
        $('[data-banner]').innerHTML = '';
        sessionStorage.removeItem(DRAFT_KEY);
      }
      applySavedPositions();
      live = null;
      undoStack = [];
      redoStack = [];
      selected.clear();
      issues = lintGraph(graph);
      for (const w of topo.warnings || []) toast(w, 'warn');
      draw();
    } catch (err) {
      render($('[data-banner]'), html`<div class="banner err">${icon('alert')}<div><strong>Could not load the flow.</strong> ${err.message}</div></div>`);
      $('[data-empty]').hidden = true;
    }
  }

  function arrange() {
    snapshot();
    const cols = { ingress: 0, user: 1, interceptor: 2, filter: 2, route: 3, connector: 4 };
    const rows = {};
    // Order routes by evaluation order and place filters/connectors next to their routes.
    const routes = graph.nodes.filter((n) => n.type === 'route').sort((a, b) => b.data.order - a.data.order);
    const rank = new Map(routes.map((r, i) => [r.id, i]));
    const neighbourRank = (n) => {
      const ws = graph.connections.filter((w) => w.from === n.id || w.to === n.id).map((w) => rank.get(w.from === n.id ? w.to : w.from)).filter((x) => x !== undefined);
      return ws.length ? Math.min(...ws) : 999;
    };
    const sorted = [...graph.nodes].sort((a, b) => (a.type === 'route' && b.type === 'route' ? rank.get(a.id) - rank.get(b.id) : neighbourRank(a) - neighbourRank(b)));
    for (const n of sorted) {
      const c = cols[n.type];
      rows[c] = (rows[c] ?? 0) + 1;
      n.x = 20 + c * 220;
      n.y = 30 + (rows[c] - 1) * 76;
    }
    savePositions();
    changed();
    fit();
  }

  function fit() {
    if (!alive || !graph.nodes.length) return;
    const r = svg.getBoundingClientRect();
    const xs = graph.nodes.map((n) => n.x);
    const ys = graph.nodes.map((n) => n.y);
    const minX = Math.min(...xs) - 30;
    const minY = Math.min(...ys) - 30;
    const maxX = Math.max(...xs) + W + 30;
    const maxY = Math.max(...ys) + H + 40;
    const k = Math.min(1.25, Math.max(0.3, Math.min(r.width / (maxX - minX), r.height / (maxY - minY))));
    view = { k, x: (r.width - (maxX - minX) * k) / 2 - minX * k, y: (r.height - (maxY - minY) * k) / 2 - minY * k };
    applyView();
  }

  function zoomAt(factor, cx, cy) {
    const k = Math.min(2.5, Math.max(0.25, view.k * factor));
    view.x = cx - ((cx - view.x) * k) / view.k;
    view.y = cy - ((cy - view.y) * k) / view.k;
    view.k = k;
    applyView();
  }

  // ---------------------------------------------------------------------------------------
  // Node creation & editing
  // ---------------------------------------------------------------------------------------
  const isEditable = (n) => n.type === 'filter' || n.type === 'route' || ((n.type === 'connector' || n.type === 'user') && !n.data.existing && !n.data.missing);

  function nextOrder() {
    const used = new Set(graph.nodes.filter((n) => n.type === 'route').map((n) => Number(n.data.order)));
    let o = 10;
    while (used.has(o)) o += 10;
    return o;
  }

  function editNode(node, { isNew = false } = {}) {
    const d = node.data;
    let fields;
    if (node.type === 'filter') {
      fields = [
        { name: 'fid', label: 'Filter ID', required: true, mono: true, value: d.fid, hint: d.existing ? 'Renaming creates a new filter; the old one stays in Jasmin.' : 'Letters, digits, _ and - (max 25).' },
        { name: 'type', label: 'Type', type: 'select', options: Object.keys(FILTER_TYPES), value: d.type || 'DestinationAddrFilter' },
        { name: 'value', label: 'Value', mono: true, value: d.value ?? '', hint: 'Depends on the type: regex for addresses/content, UID, GID, tag or interval.' }
      ];
    } else if (node.type === 'route') {
      fields = [
        { name: 'type', label: 'Route type', type: 'select', options: MT_ROUTE_TYPES.map((t) => [t, `${ROUTE_LABEL[t]} (${t})`]), value: d.type },
        { name: 'order', label: 'Order', type: 'number', min: 0, value: d.order, row: 'a', hint: 'Higher is evaluated first. Default route is always 0.' },
        { name: 'rate', label: 'Rate per message', type: 'number', step: 'any', min: 0, value: d.rate ?? 0, row: 'a' }
      ];
    } else if (node.type === 'connector') {
      fields = [
        { name: 'cid', label: 'Connector ID', required: true, mono: true, value: d.cid },
        { name: 'host', label: 'SMSC host', required: true, mono: true, value: d.host ?? '', row: 'h' },
        { name: 'port', label: 'Port', type: 'number', required: true, value: d.port ?? 2775, row: 'h' },
        { name: 'username', label: 'System ID', required: true, mono: true, value: d.username ?? '', row: 'c' },
        { name: 'password', label: 'Password', type: 'password', required: true, value: d.password ?? '', row: 'c', autocomplete: 'new-password' }
      ];
    } else if (node.type === 'user') {
      fields = [
        { name: 'uid', label: 'User ID', required: true, mono: true, value: d.uid, row: 'a' },
        { name: 'gid', label: 'Group', required: true, mono: true, value: d.gid ?? '', row: 'a', hint: 'Created if it does not exist.' },
        { name: 'username', label: 'Username', required: true, mono: true, value: d.username ?? '', row: 'b' },
        { name: 'password', label: 'Password', type: 'password', required: true, value: d.password ?? '', row: 'b', autocomplete: 'new-password' },
        { name: 'balance', label: 'Balance', type: 'number', step: 'any', min: 0, value: d.balance ?? '', row: 'c', placeholder: 'Unlimited' },
        { name: 'throughput', label: 'Throughput (msg/s)', type: 'number', step: 'any', min: 0, value: d.throughput ?? '', row: 'c', placeholder: 'Unlimited' }
      ];
    } else return;

    const dlg = formDialog({
      title: `${isNew ? 'Add' : 'Edit'} ${NODE_TYPES[node.type].title.toLowerCase()}`,
      submitText: 'Done',
      fields,
      footLeft: isNew ? '' : html`<button type="button" class="btn danger" data-del-node>${icon('trash')} Delete</button>`,
      onSubmit: async (v) => {
        if ('fid' in v && !isValidId(v.fid)) throw new Error('Filter ID: 1-25 characters, letters, digits, _ or -');
        if ('cid' in v && !isValidId(v.cid)) throw new Error('Connector ID: 1-25 characters, letters, digits, _ or -');
        if ('uid' in v && (!isValidId(v.uid) || !isValidId(v.gid) || !isValidId(v.username))) throw new Error('UID, group and username: 1-25 characters, letters, digits, _ or -');
        if (node.type === 'filter') {
          const spec = FILTER_TYPES[v.type];
          if (spec.key && !v.value) throw new Error(`${v.type} needs a value: ${spec.hint}`);
          if (spec.regex) {
            try {
              new RegExp(v.value);
            } catch (e) {
              throw new Error(`Invalid regex: ${e.message}`);
            }
          }
          if (graph.nodes.some((n) => n !== node && n.type === 'filter' && n.data.fid === v.fid)) throw new Error(`Filter ${v.fid} already exists in the flow`);
        }
        if (node.type === 'route') {
          v.order = v.type === 'DefaultRoute' ? 0 : Number(v.order);
          v.rate = Number(v.rate) || 0;
          if (v.type !== 'DefaultRoute' && !(v.order > 0)) throw new Error('Order must be ≥ 1 (0 is reserved for the default route)');
          if (graph.nodes.some((n) => n !== node && n.type === 'route' && Number(n.data.order) === v.order)) throw new Error(`Order ${v.order} is already used`);
        }
        if (node.type === 'connector' && graph.nodes.some((n) => n !== node && n.type === 'connector' && n.data.cid === v.cid)) throw new Error(`Connector ${v.cid} already exists`);
        if (node.type === 'user' && graph.nodes.some((n) => n !== node && n.type === 'user' && n.data.uid === v.uid)) throw new Error(`User ${v.uid} already exists`);
        snapshot();
        if (isNew) graph.nodes.push(node);
        if (node.type === 'filter' && d.existing && v.fid !== d.fid) delete d.existing;
        Object.assign(node.data, v);
        if (node.type === 'filter') delete node.data.inline;
        if (node.type === 'route') {
          // Static/Default routes keep only the first connector.
          if (/Static|Default/.test(v.type)) {
            const outs = graph.connections.filter((w) => w.from === node.id);
            graph.connections = graph.connections.filter((w) => w.from !== node.id || w === outs[0]);
          }
          if (v.type === 'DefaultRoute') graph.connections = graph.connections.filter((w) => w.to !== node.id || byId(w.from)?.type !== 'filter');
        }
        selected = new Set([node.id]);
        savePositions();
        changed();
      }
    });
    const del = dlg.querySelector('[data-del-node]');
    if (del)
      del.onclick = () => {
        dlg.close();
        removeNodes([node.id]);
      };
  }

  function addNode(type, sub, x, y) {
    if (!editable) return;
    const id = `${type}_new_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const node = { id, type, x: Math.round(x), y: Math.round(y), data: {} };
    if (type === 'filter') node.data = { fid: '', type: sub, value: '' };
    if (type === 'route') node.data = { type: sub, order: sub === 'DefaultRoute' ? 0 : nextOrder(), rate: 0 };
    if (type === 'connector') node.data = { kind: 'smpp', cid: '', port: 2775 };
    if (type === 'user') node.data = { uid: '', gid: '', username: '' };
    if (type === 'filter' && sub === 'TransparentFilter') node.data.fid = 'match_all';
    editNode(node, { isNew: true });
  }

  function removeNodes(ids) {
    const removable = ids.filter((id) => {
      const n = byId(id);
      return n && n.type !== 'ingress';
    });
    if (!removable.length) return;
    snapshot();
    graph.nodes = graph.nodes.filter((n) => !removable.includes(n.id));
    graph.connections = graph.connections.filter((w) => !removable.includes(w.from) && !removable.includes(w.to));
    selected.clear();
    changed();
    const existing = removable.filter((id) => baseline.nodes.has(id));
    if (existing.length) toast(`Removed ${removable.length} node(s). Routes removed here are deleted from Jasmin on deploy.`, 'info');
  }

  function moveConnector(routeId, index, delta) {
    const outs = graph.connections.filter((w) => w.from === routeId);
    const j = index + delta;
    if (j < 0 || j >= outs.length) return;
    snapshot();
    const others = graph.connections.filter((w) => w.from !== routeId);
    [outs[index], outs[j]] = [outs[j], outs[index]];
    outs.forEach((w) => delete w.role);
    graph.connections = [...others, ...outs];
    changed();
  }

  // ---------------------------------------------------------------------------------------
  // Pointer interaction
  // ---------------------------------------------------------------------------------------
  const toWorld = (e) => {
    const r = svg.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.x) / view.k, y: (e.clientY - r.top - view.y) / view.k };
  };
  let drag = null;
  let lastClick = { id: '', t: 0 };

  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    svg.focus();
    const nodeEl = e.target.closest('[data-node]');
    const port = e.target.closest('[data-port]');
    const wireEl = e.target.closest('[data-wire]');
    const p = toWorld(e);

    if (port && port.dataset.port === 'out' && editable) {
      drag = { mode: 'wire', from: nodeEl.dataset.node };
    } else if (nodeEl && e.button === 0) {
      const id = nodeEl.dataset.node;
      // Manual double-click detection: selecting re-renders the node, so the native dblclick
      // event would be lost between the two clicks.
      const now = Date.now();
      if (lastClick.id === id && now - lastClick.t < 400 && !e.shiftKey) {
        lastClick = { id: '', t: 0 };
        const n = byId(id);
        if (n && editable && isEditable(n)) editNode(n);
        return;
      }
      lastClick = { id, t: now };
      if (e.shiftKey || e.ctrlKey || e.metaKey) selected.has(id) ? selected.delete(id) : selected.add(id);
      else if (!selected.has(id)) selected = new Set([id]);
      selectedWire = null;
      drag = { mode: 'move', start: p, moved: false, origin: new Map([...selected].map((sid) => [sid, { x: byId(sid).x, y: byId(sid).y }])) };
      draw();
    } else if (wireEl && e.button === 0) {
      selectedWire = wireEl.dataset.wire;
      selected.clear();
      draw();
      return;
    } else if (e.shiftKey && e.button === 0) {
      drag = { mode: 'lasso', start: p };
    } else {
      drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
      svg.classList.add('panning');
    }
    svg.setPointerCapture(e.pointerId);
  });

  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = toWorld(e);
    if (drag.mode === 'pan') {
      view.x = drag.vx + e.clientX - drag.sx;
      view.y = drag.vy + e.clientY - drag.sy;
      drag.moved = drag.moved || Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 3;
      applyView();
    } else if (drag.mode === 'move' && editable) {
      const dx = p.x - drag.start.x;
      const dy = p.y - drag.start.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      if (!drag.moved) snapshot();
      drag.moved = true;
      for (const [id, o] of drag.origin) {
        const n = byId(id);
        // Snap to the 20px grid like the background.
        n.x = Math.round((o.x + dx) / 10) * 10;
        n.y = Math.round((o.y + dy) / 10) * 10;
        root.querySelector(`[data-node="${CSS.escape(id)}"]`)?.setAttribute('transform', `translate(${n.x},${n.y})`);
      }
      drawWires();
    } else if (drag.mode === 'wire') {
      const a = byId(drag.from);
      const x1 = a.x + W;
      const y1 = a.y + H / 2;
      const dx = Math.max(40, Math.abs(p.x - x1) * 0.5);
      $('[data-drag-wire]').setAttribute('d', `M${x1},${y1} C${x1 + dx},${y1} ${p.x - dx},${p.y} ${p.x},${p.y}`);
      root.querySelectorAll('.fe-port.target,.fe-port.bad').forEach((x) => x.classList.remove('target', 'bad'));
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-node]');
      if (over && over.dataset.node !== drag.from) {
        const ok = validateConnection(graph, drag.from, over.dataset.node).valid;
        over.querySelector('[data-port="in"]')?.classList.add(ok ? 'target' : 'bad');
      }
    } else if (drag.mode === 'lasso') {
      const x = Math.min(p.x, drag.start.x);
      const y = Math.min(p.y, drag.start.y);
      const l = $('[data-lasso]');
      l.setAttribute('x', x);
      l.setAttribute('y', y);
      l.setAttribute('width', Math.abs(p.x - drag.start.x));
      l.setAttribute('height', Math.abs(p.y - drag.start.y));
      drag.box = { x, y, w: Math.abs(p.x - drag.start.x), h: Math.abs(p.y - drag.start.y) };
    }
  });

  svg.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    svg.classList.remove('panning');
    if (d.mode === 'pan' && !d.moved) {
      selected.clear();
      selectedWire = null;
      draw();
    } else if (d.mode === 'move' && d.moved) {
      savePositions();
      changed();
    } else if (d.mode === 'wire') {
      $('[data-drag-wire]').setAttribute('d', '');
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-node]');
      if (over && over.dataset.node !== d.from) {
        const check = validateConnection(graph, d.from, over.dataset.node);
        if (!check.valid) toast(check.reason, 'warn');
        else {
          snapshot();
          graph.connections.push({ from: d.from, to: over.dataset.node });
          changed();
        }
      }
      draw();
    } else if (d.mode === 'lasso') {
      const l = $('[data-lasso]');
      l.setAttribute('width', 0);
      l.setAttribute('height', 0);
      if (d.box) {
        selected = new Set(graph.nodes.filter((n) => n.x + W > d.box.x && n.x < d.box.x + d.box.w && n.y + H > d.box.y && n.y < d.box.y + d.box.h).map((n) => n.id));
        draw();
      }
    }
  });

  svg.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top);
    },
    { passive: false }
  );

  // Palette drag & drop
  const drawPalette = () => {
    const q = $('[data-pal-q]').value.trim().toLowerCase();
    render(
      $('[data-pal-list]'),
      PALETTE.map(([group, items]) => {
        const list = items.filter(([, sub, label]) => !q || label.toLowerCase().includes(q) || sub.toLowerCase().includes(q));
        return list.length
          ? html`<h4>${group}</h4>${list.map(([type, sub, label]) => html`<div class="pal-node" draggable="${editable ? 'true' : 'false'}" data-type="${type}" data-sub="${sub}" style="--c:var(${TYPE_COLOR[type]})" title="${type === 'filter' ? FILTER_TYPES[sub]?.hint : sub}"><span class="ic">${icon(TYPE_ICON[type])}</span><span>${label}</span></div>`)}`
          : '';
      })
    );
  };
  drawPalette();
  $('[data-pal-q]').addEventListener('input', drawPalette);
  $('[data-pal]').addEventListener('dragstart', (e) => {
    const el = e.target.closest('.pal-node');
    if (!el || !editable) return e.preventDefault();
    e.dataTransfer.setData('application/x-jasmin-node', JSON.stringify({ type: el.dataset.type, sub: el.dataset.sub }));
    e.dataTransfer.effectAllowed = 'copy';
  });
  $('[data-pal]').addEventListener('dblclick', (e) => {
    const el = e.target.closest('.pal-node');
    if (!el) return;
    const r = svg.getBoundingClientRect();
    addNode(el.dataset.type, el.dataset.sub, (r.width / 2 - view.x) / view.k - W / 2, (r.height / 2 - view.y) / view.k);
  });
  const wrap = $('[data-wrap]');
  wrap.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('application/x-jasmin-node')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });
  wrap.addEventListener('drop', (e) => {
    const raw = e.dataTransfer.getData('application/x-jasmin-node');
    if (!raw) return;
    e.preventDefault();
    const { type, sub } = JSON.parse(raw);
    const p = toWorld(e);
    addNode(type, sub, Math.round((p.x - W / 2) / 10) * 10, Math.round((p.y - H / 2) / 10) * 10);
  });

  // Keyboard
  const onKey = (e) => {
    if (!alive || e.target.closest('input,textarea,select,dialog')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
      e.preventDefault();
      redo();
    } else if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      selected = new Set(graph.nodes.map((n) => n.id));
      draw();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && editable) {
      if (selectedWire) {
        snapshot();
        graph.connections = graph.connections.filter((w) => wireKey(w) !== selectedWire);
        selectedWire = null;
        changed();
      } else if (selected.size) removeNodes([...selected]);
    } else if (e.key === 'Escape') {
      selected.clear();
      selectedWire = null;
      draw();
    } else if (e.key === 'Enter' && selected.size === 1 && editable) {
      const n = byId([...selected][0]);
      if (n && isEditable(n)) editNode(n);
    }
  };
  document.addEventListener('keydown', onKey);

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(clone(graph));
    graph = undoStack.pop();
    selected = new Set([...selected].filter((id) => byId(id)));
    changed();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(clone(graph));
    graph = redoStack.pop();
    changed();
  }

  // ---------------------------------------------------------------------------------------
  // Deploy
  // ---------------------------------------------------------------------------------------
  async function deploy() {
    const errors = issues.filter((i) => i.level === 'error');
    if (errors.length) {
      sideTab = 'problems';
      syncTabs();
      drawSide();
      return toast(`Fix ${errors.length} problem(s) before deploying`, 'err');
    }
    const body = { nodes: graph.nodes, connections: graph.connections, prune: true };
    let plan;
    try {
      plan = await api('/api/topology/plan', { method: 'POST', body });
    } catch (err) {
      return toastError(err);
    }
    showPlan(body, plan);
  }

  function showPlan(body, plan, notice) {
    const tone = { add: 'ok', replace: 'info', remove: 'err' };
    const dlg = infoDialog(
      'Review deployment',
      html`${notice ? html`<div class="banner warn">${icon('alert')}<div>${notice}</div></div>` : ''}
        ${plan.errors.length ? html`<div class="banner err">${icon('alert')}<div>${plan.errors.map((x) => html`<div>${x}</div>`)}</div></div>` : ''}
        ${plan.warnings?.length ? html`<div class="banner warn">${icon('alert')}<div>${plan.warnings.map((x) => html`<div>${x}</div>`)}</div></div>` : ''}
        ${plan.steps.length
          ? html`<p class="muted" style="margin-bottom:10px">These jCLI changes run in order in one session, then the configuration is persisted. ${plan.unchanged} item(s) are already up to date.</p>
            ${plan.steps.map((s) => html`<div class="plan-step"><span class="badge ${tone[s.action]}" style="min-width:66px;justify-content:center">${s.action}</span><span class="muted" style="min-width:70px">${s.kind}</span><code>${s.summary}</code></div>`)}`
          : html`<div class="empty">${icon('check')}<h3>Nothing to deploy</h3><p>The gateway already matches this flow.</p></div>`}`
    );
    const foot = dlg.querySelector('.modal-foot');
    if (plan.steps.length && !plan.errors.length) {
      const btn = document.createElement('button');
      btn.className = 'btn deploy';
      render(btn, html`${icon('rocket')} Deploy ${plan.steps.length} change(s)`);
      foot.appendChild(btn);
      btn.onclick = async () => {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Deploying…';
        try {
          // The server re-plans and refuses if the result differs from what is shown here.
          const r = await api('/api/topology/deploy', { method: 'POST', body: { ...body, fingerprint: plan.fingerprint } });
          dlg.close();
          toast(r.message, 'ok');
          sessionStorage.removeItem(DRAFT_KEY);
          ctx.invalidate().catch(() => {});
          await sync();
        } catch (err) {
          dlg.close();
          if (err.status === 409 && err.body?.stale && err.body.plan) {
            return showPlan(body, err.body.plan, 'The gateway changed since you opened this review (another user, the jCLI terminal or another tab). This is the updated plan; nothing was deployed.');
          }
          toastError(err, 'Deploy stopped: ');
          if (err.body?.applied?.length) toast(`${err.body.applied.length} change(s) were applied before the failure and persisted.`, 'warn');
          // Keep the user's edits: reload the live state as the new baseline and restore the draft on top.
          await sync({ keepDraft: true });
        }
      };
    }
  }

  // ---------------------------------------------------------------------------------------
  // Toolbar, side panel, import/export
  // ---------------------------------------------------------------------------------------
  const syncTabs = () => root.querySelectorAll('[data-side-tabs] [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === sideTab));
  $('[data-side-tabs]').onclick = (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    sideTab = b.dataset.tab;
    syncTabs();
    drawSide();
  };

  root.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-act],[data-show-problems],[data-goto],[data-edit],[data-remove],[data-move],[data-clear-debug],[data-discard]');
    if (!t) return;
    if (t.dataset.showProblems !== undefined) {
      sideTab = 'problems';
      syncTabs();
      return drawSide();
    }
    if (t.dataset.goto !== undefined) {
      const n = byId(t.dataset.goto);
      if (!n) return;
      selected = new Set([n.id]);
      const r = svg.getBoundingClientRect();
      view.x = r.width / 2 - (n.x + W / 2) * view.k;
      view.y = r.height / 2 - (n.y + H / 2) * view.k;
      applyView();
      sideTab = 'info';
      syncTabs();
      return draw();
    }
    if (t.dataset.edit !== undefined) return editNode(byId([...selected][0]));
    if (t.dataset.remove !== undefined) return removeNodes([...selected]);
    if (t.dataset.move) {
      const [i, dlt] = t.dataset.move.split(':').map(Number);
      return moveConnector([...selected][0], i, dlt);
    }
    if (t.dataset.clearDebug !== undefined) {
      debug.length = 0;
      return drawSide();
    }
    if (t.dataset.discard !== undefined) {
      sessionStorage.removeItem(DRAFT_KEY);
      return sync();
    }
    const r = svg.getBoundingClientRect();
    switch (t.dataset.act) {
      case 'undo':
        return undo();
      case 'redo':
        return redo();
      case 'zoom-in':
        return zoomAt(1.2, r.width / 2, r.height / 2);
      case 'zoom-out':
        return zoomAt(1 / 1.2, r.width / 2, r.height / 2);
      case 'fit':
        return fit();
      case 'arrange':
        return arrange();
      case 'focus': {
        const on = document.getElementById('app').classList.toggle('focus');
        t.setAttribute('aria-pressed', String(on));
        render(t, html`${icon(on ? 'x' : 'maximize')} ${on ? 'Exit focus' : 'Focus'}`);
        return setTimeout(fit, 50);
      }
      case 'sync':
        if (changeCount() && !(await confirmDialog({ title: 'Discard undeployed changes?', message: 'Reloading replaces the canvas with the current gateway configuration.', confirmText: 'Reload', danger: true }))) return;
        sessionStorage.removeItem(DRAFT_KEY);
        await sync();
        return fit();
      case 'deploy':
        return deploy();
      case 'export': {
        // Secrets of new users/connectors are never exported.
        const nodes = graph.nodes.map((n) => ({ ...n, data: Object.fromEntries(Object.entries(n.data).filter(([k]) => k !== 'password')) }));
        return download(`jasmin-flow-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ format: 'jasmin-console-flow/1', exportedAt: new Date().toISOString(), nodes, connections: graph.connections }, null, 2));
      }
      case 'import': {
        if (!editable) return toast('Your role cannot change the flow', 'warn');
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        input.onchange = async () => {
          try {
            const parsed = normalizeFlow(JSON.parse(await input.files[0].text()));
            if (!parsed.nodes.length) throw new Error('The file contains no nodes');
            snapshot();
            graph = parsed;
            changed();
            fit();
            toast(`Imported ${parsed.nodes.length} nodes and ${parsed.connections.length} wires. Review and deploy.`, 'ok');
          } catch (err) {
            toast(`Import failed: ${err.message}`, 'err');
          }
        };
        input.click();
      }
    }
  });

  // ---------------------------------------------------------------------------------------
  // Live updates
  // ---------------------------------------------------------------------------------------
  function pulseInto(nodeId) {
    const el = root.querySelector(`[data-node="${CSS.escape(nodeId)}"]`);
    if (!el) return;
    el.classList.remove('flash');
    void el.getBBox();
    el.classList.add('flash');
    for (const w of graph.connections.filter((x) => x.to === nodeId)) {
      const a = byId(w.from);
      const b = byId(w.to);
      if (!a || !b) continue;
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('d', wirePath(a, b));
      const len = path.getTotalLength?.() || 0;
      const dot = document.createElementNS(SVGNS, 'circle');
      dot.setAttribute('r', 4);
      dot.setAttribute('class', 'fe-pulse');
      $('[data-world]').appendChild(dot);
      const t0 = performance.now();
      const step = (t) => {
        const f = Math.min(1, (t - t0) / 600);
        const pt = path.getPointAtLength(len * f);
        dot.setAttribute('cx', pt.x);
        dot.setAttribute('cy', pt.y);
        if (f < 1) requestAnimationFrame(step);
        else dot.remove();
      };
      requestAnimationFrame(step);
    }
  }

  const offs = [
    on('traffic:new', (m) => {
      debug.unshift(m);
      if (debug.length > 200) debug.length = 200;
      if (sideTab === 'debug') drawSide();
      if (!m.routedCid) return;
      const conn = graph.nodes.find((n) => n.type === 'connector' && n.data.cid === m.routedCid);
      if (!conn) return;
      counters.set(conn.id, (counters.get(conn.id) || 0) + 1);
      updateStatuses();
      pulseInto(conn.id);
    }),
    on('stats', (d) => {
      if (!d.smppConnectors) return;
      live = d.smppConnectors;
      updateStatuses();
      // Only the Info panel shows live connector counters; avoid re-rendering it under the cursor otherwise.
      if (sideTab === 'info' && [...selected].some((id) => byId(id)?.type === 'connector')) drawSide();
    }),
    on('theme', () => draw())
  ];

  applyView();
  await sync({ keepDraft: true });
  fit();
  return () => {
    alive = false;
    document.getElementById('app').classList.remove('focus');
    document.removeEventListener('keydown', onKey);
    offs.forEach((f) => f());
  };
}
