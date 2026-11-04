import { api, confirmDialog, formDialog, html, icon, render, toast, toastError } from '../lib.js';
import { FILTER_TYPES } from '../flow-rules.js';
import { emptyRow, offlineBanner, pageHead, ROUTE_LABEL } from './shared.js';

const MT_TYPES = [
  ['StaticMTRoute', 'Static: one connector'],
  ['FailoverMTRoute', 'Failover: try connectors in order'],
  ['RandomRoundrobinMTRoute', 'Round-robin: spread across connectors'],
  ['DefaultRoute', 'Default: catch-all (order 0, no filters)']
];
const MO_TYPES = [
  ['StaticMORoute', 'Static: one connector'],
  ['FailoverMORoute', 'Failover: try connectors in order'],
  ['RandomRoundrobinMORoute', 'Round-robin'],
  ['DefaultRoute', 'Default: catch-all']
];

export default async function routing(root, ctx) {
  const canWrite = ctx.can('gateway:write');
  render(
    root,
    html`<div class="page">
      ${pageHead(
        'Routing & filters',
        'Jasmin evaluates MT routes from the highest order down; the first route whose filters all match wins. The default route (order 0) catches the rest.',
        html`<a class="btn" href="#/simulator">${icon('flask')} Test a message</a><a class="btn" href="#/flow">${icon('flow')} Flow editor</a>`
      )}
      <div data-banner></div>
      <div class="tabs" role="tablist" data-tabs>
        <button class="on" data-tab="mt" role="tab">MT routes <span class="badge" data-n="mt"></span></button>
        <button data-tab="mo" role="tab">MO routes <span class="badge" data-n="mo"></span></button>
        <button data-tab="filters" role="tab">Filters <span class="badge" data-n="filters"></span></button>
      </div>
      <section class="card" data-panel="mt">
        <div class="card-head"><div><h2>MT routes</h2><p>Outbound: from users to carrier connectors.</p></div>${canWrite ? html`<button class="btn primary" data-add-mt>${icon('plus')} New MT route</button>` : ''}</div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Order</th><th>Type</th><th>Filters (all must match)</th><th>Connectors</th><th class="num">Rate</th><th></th></tr></thead><tbody data-mt></tbody></table></div>
      </section>
      <section class="card" data-panel="mo" hidden>
        <div class="card-head"><div><h2>MO routes</h2><p>Inbound: from carriers to HTTP applications or SMPP users.</p></div>${canWrite ? html`<button class="btn primary" data-add-mo>${icon('plus')} New MO route</button>` : ''}</div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Order</th><th>Type</th><th>Filters</th><th>Connectors</th><th></th></tr></thead><tbody data-mo></tbody></table></div>
      </section>
      <section class="card" data-panel="filters" hidden>
        <div class="card-head"><div><h2>Filters</h2><p>Reusable match rules. Routes keep a copy of a filter, so changing a filter means re-saving the routes that use it (the flow editor does this for you).</p></div>${canWrite ? html`<button class="btn primary" data-add-filter>${icon('plus')} New filter</button>` : ''}</div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Filter ID</th><th>Type</th><th>Applies to</th><th>Rule</th><th>Used by</th><th></th></tr></thead><tbody data-filters></tbody></table></div>
      </section>
    </div>`
  );
  const $ = (s) => root.querySelector(s);
  let state;

  const filterChips = (refs) =>
    refs.length
      ? html`<div class="chips">${refs.map((f) => (f.fid ? html`<span class="chip" title="${f.description}">${f.fid}</span>` : html`<span class="chip text-warn" title="This filter no longer exists by name">${f.description}</span>`))}</div>`
      : html`<span class="muted">— none —</span>`;
  const connChips = (list) => html`<div class="chips">${list.map((c, i) => html`<span class="chip">${list.length > 1 ? `${i + 1}. ` : ''}${c}</span>`)}</div>`;

  function draw() {
    const mt = [...state.mtRoutes].sort((a, b) => b.order - a.order);
    const mo = [...state.moRoutes].sort((a, b) => b.order - a.order);
    $('[data-n="mt"]').textContent = mt.length;
    $('[data-n="mo"]').textContent = mo.length;
    $('[data-n="filters"]').textContent = state.filters.length;
    const missingConn = (typed) => !state.smppConnectors.some((c) => `smppc(${c.cid})` === typed);
    render(
      $('[data-mt]'),
      mt.length
        ? mt.map(
            (r) => html`<tr>
            <td class="mono strong">#${r.order}</td>
            <td><span class="badge ${r.type === 'DefaultRoute' ? '' : 'brand'}">${ROUTE_LABEL[r.type] || r.type}</span></td>
            <td>${r.type === 'DefaultRoute' ? html`<span class="muted">Everything not matched above</span>` : filterChips(r.filterRefs || [])}</td>
            <td>${connChips(r.connectors)}${r.connectors.some(missingConn) ? html`<div class="text-warn" style="font-size:12px;margin-top:4px">${icon('alert')} uses a connector that no longer exists</div>` : ''}</td>
            <td class="num mono">${r.rate ? r.rate.toFixed(4) : html`<span class="muted" title="No billing">0</span>`}</td>
            <td class="actions-cell">${canWrite ? html`<button class="btn ghost sm icon-only" data-del-mt="${r.order}" aria-label="Delete route ${r.order}" title="Delete">${icon('trash')}</button>` : ''}</td></tr>`
          )
        : emptyRow(6, 'route', 'No MT routes', 'Without routes, submitted messages are rejected with "no route found".')
    );
    render(
      $('[data-mo]'),
      mo.length
        ? mo.map(
            (r) => html`<tr><td class="mono strong">#${r.order}</td><td><span class="badge">${ROUTE_LABEL[r.type] || r.type}</span></td>
            <td>${r.type === 'DefaultRoute' ? html`<span class="muted">Everything</span>` : html`<div class="chips">${r.filters.map((f) => html`<span class="chip">${f}</span>`)}</div>`}</td>
            <td>${connChips(r.connectors)}</td>
            <td class="actions-cell">${canWrite ? html`<button class="btn ghost sm icon-only" data-del-mo="${r.order}" aria-label="Delete MO route ${r.order}" title="Delete">${icon('trash')}</button>` : ''}</td></tr>`
          )
        : emptyRow(5, 'inbox', 'No MO routes', 'Inbound messages are dropped until a route exists.')
    );
    render(
      $('[data-filters]'),
      state.filters.length
        ? state.filters.map((f) => {
            const used = state.mtRoutes.filter((r) => (r.filterRefs || []).some((x) => x.fid === f.fid)).map((r) => `#${r.order}`);
            return html`<tr><td class="mono strong">${f.fid}</td><td>${f.type.replace('Filter', '')}</td><td>${f.routes.split(' ').map((x) => html`<span class="badge" style="margin-right:4px">${x}</span>`)}</td>
              <td class="mono">${f.value ? html`<code>${f.value}</code>` : html`<span class="muted">${f.description}</span>`}</td>
              <td>${used.length ? html`<div class="chips">${used.map((u) => html`<span class="chip">${u}</span>`)}</div>` : html`<span class="muted">unused</span>`}</td>
              <td class="actions-cell">${canWrite ? html`<button class="btn ghost sm icon-only" data-del-filter="${f.fid}" aria-label="Delete filter ${f.fid}" title="Delete">${icon('trash')}</button>` : ''}</td></tr>`;
          })
        : emptyRow(6, 'filter', 'No filters', 'Create filters to route by recipient prefix, sender, user, content…')
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

  $('[data-tabs]').onclick = (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    root.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
    root.querySelectorAll('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== b.dataset.tab));
  };

  function routeDialog(kind) {
    const isMt = kind === 'mt';
    const conns = isMt ? state.smppConnectors.map((c) => `smppc(${c.cid})`) : [...state.httpConnectors.map((c) => `http(${c.cid})`), ...state.users.map((u) => `smpps(${u.uid})`)];
    const filters = state.filters.filter((f) => f.routes.includes(isMt ? 'MT' : 'MO')).map((f) => [f.fid, `${f.fid} · ${f.type.replace('Filter', '')}`]);
    const used = new Set((isMt ? state.mtRoutes : state.moRoutes).map((r) => r.order));
    let next = 10;
    while (used.has(next)) next += 10;
    formDialog({
      title: isMt ? 'New MT route' : 'New MO route',
      description: 'Higher order is evaluated first. Saving with an order that already exists replaces that route.',
      submitText: 'Save route',
      wide: true,
      fields: [
        { name: 'type', label: 'Type', type: 'select', options: isMt ? MT_TYPES : MO_TYPES, row: 'a' },
        { name: 'order', label: 'Order', type: 'number', min: 1, value: next, row: 'a', hint: 'Ignored for the default route (always 0).' },
        ...(isMt ? [{ name: 'rate', label: 'Rate per message', type: 'number', step: 'any', min: 0, value: 0, row: 'a', hint: 'Charged to the user when billing is on.' }] : []),
        { name: 'connectors', label: 'Connectors', type: 'multiselect', required: true, options: conns, emptyText: isMt ? 'Create an SMPP connector first' : 'Create an HTTP connector first', hint: 'Static/Default use the first one; Failover tries them in the listed order.' },
        { name: 'filters', label: 'Filters (all must match)', type: 'multiselect', options: filters, emptyText: 'Create a filter first (use TransparentFilter to match everything)' }
      ],
      onSubmit: async (v) => {
        if (v.type !== 'DefaultRoute' && !v.filters.length) throw new Error(`${v.type} needs at least one filter`);
        if (/Static|Default/.test(v.type) && v.connectors.length > 1) throw new Error(`${v.type} uses exactly one connector`);
        const body = { ...v, order: v.type === 'DefaultRoute' ? 0 : Number(v.order) };
        const exists = (isMt ? state.mtRoutes : state.moRoutes).some((r) => r.order === body.order);
        if (exists && !(await confirmDialog({ title: `Replace route #${body.order}?`, message: 'A route with this order exists and will be replaced.', confirmText: 'Replace' }))) throw new Error('Cancelled');
        await changed((await api(`/api/routes/${kind}`, { method: 'POST', body, query: exists ? { replace: 1 } : undefined })).message);
      }
    });
  }

  function filterDialog() {
    const types = Object.entries(FILTER_TYPES).map(([t, s]) => [t, `${t.replace('Filter', '')}: ${s.hint}`]);
    const dlg = formDialog({
      title: 'New filter',
      submitText: 'Create filter',
      fields: [
        { name: 'fid', label: 'Filter ID', required: true, mono: true, placeholder: 'e.g. eg_vodafone' },
        { name: 'type', label: 'Type', type: 'select', options: types, value: 'DestinationAddrFilter' },
        { name: 'value', label: 'Value', mono: true, placeholder: '^2010\\d+', hint: 'Regex filters use Python re.match: anchored at the start of the value.' },
        { name: 'sample', label: 'Try a sample', mono: true, placeholder: 'e.g. 201012345678' }
      ],
      onSubmit: async (v) => {
        if (FILTER_TYPES[v.type].key && !v.value) throw new Error('This filter type needs a value');
        await changed((await api('/api/filters', { method: 'POST', body: { fid: v.fid, type: v.type, value: v.value } })).message);
      }
    });
    const form = dlg.querySelector('form');
    const hint = document.createElement('div');
    hint.className = 'hint';
    form.querySelector('[data-field="sample"]').appendChild(hint);
    const test = () => {
      const spec = FILTER_TYPES[form.type.value];
      form.querySelector('[data-field="value"]').hidden = !spec.key;
      form.querySelector('[data-field="sample"]').hidden = !spec.regex;
      form.value.placeholder = spec.hint;
      if (!spec.regex || !form.value.value) return (hint.textContent = '');
      try {
        const ok = new RegExp(`^(?:${form.value.value})`).test(form.sample.value);
        hint.innerHTML = form.sample.value ? (ok ? '<span class="text-ok">✓ matches</span>' : '<span class="text-err">✗ does not match</span>') : '';
        form.value.removeAttribute('aria-invalid');
      } catch (e) {
        hint.innerHTML = `<span class="text-err">Invalid pattern</span>`;
        form.value.setAttribute('aria-invalid', 'true');
      }
    };
    form.addEventListener('input', test);
    form.addEventListener('change', test);
    test();
  }

  if (canWrite) {
    $('[data-add-mt]').onclick = () => routeDialog('mt');
    $('[data-add-mo]').onclick = () => routeDialog('mo');
    $('[data-add-filter]').onclick = filterDialog;
    root.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const { delMt, delMo, delFilter } = b.dataset;
      try {
        if (delMt !== undefined) {
          if (!(await confirmDialog({ title: `Delete MT route #${delMt}?`, message: 'Messages that matched this route will fall through to lower routes.', confirmText: 'Delete', danger: true }))) return;
          await changed((await api(`/api/routes/mt/${delMt}`, { method: 'DELETE' })).message);
        } else if (delMo !== undefined) {
          if (!(await confirmDialog({ title: `Delete MO route #${delMo}?`, message: 'Inbound messages that matched it will fall through.', confirmText: 'Delete', danger: true }))) return;
          await changed((await api(`/api/routes/mo/${delMo}`, { method: 'DELETE' })).message);
        } else if (delFilter) {
          if (!(await confirmDialog({ title: `Delete filter ${delFilter}?`, message: 'Routes keep their own copy of the filter and keep working, but it can no longer be selected for new routes.', confirmText: 'Delete', danger: true }))) return;
          await changed((await api(`/api/filters/${encodeURIComponent(delFilter)}`, { method: 'DELETE' })).message);
        }
      } catch (err) {
        toastError(err);
      }
    });
  }

  await load();
}
