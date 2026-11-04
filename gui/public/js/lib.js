// Shared helpers for the Jasmin console (no framework, ES modules).

// ---------------------------------------------------------------------------
// Safe HTML templating: every interpolated value is escaped unless wrapped in raw().
// ---------------------------------------------------------------------------
const RAW = Symbol('raw');
export const raw = (s) => ({ [RAW]: String(s ?? '') });
export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function interp(v) {
  if (v === null || v === undefined || v === false) return '';
  if (Array.isArray(v)) return v.map(interp).join('');
  if (typeof v === 'object' && RAW in v) return v[RAW];
  return esc(v);
}

/** Tagged template returning a raw() HTML fragment with escaped interpolations. */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += interp(values[i]) + strings[i + 1];
  return raw(out);
}

export const toHtml = (fragment) => interp(fragment);

export function render(el, fragment) {
  el.innerHTML = toHtml(fragment);
  return el;
}

// ---------------------------------------------------------------------------
// Icons (24px stroke icons)
// ---------------------------------------------------------------------------
const P = (d) => d.split('|').map((x) => (x.startsWith('<') ? x : `<path d="${x}"/>`)).join('');
const ICONS = {
  gauge: P('M12 14l4-4|M3.34 19a10 10 0 1 1 17.32 0'),
  activity: P('M22 12h-4l-3 9L9 3l-3 9H2'),
  terminal: P('M4 17l6-6-6-6|M12 19h8'),
  users: P('M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2|<circle cx="9" cy="7" r="4"/>|M22 21v-2a4 4 0 0 0-3-3.87|M16 3.13a4 4 0 0 1 0 7.75'),
  plug: P('M12 22v-5|M9 8V2|M15 8V2|M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z'),
  route: P('<circle cx="6" cy="19" r="3"/>|M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15|<circle cx="18" cy="5" r="3"/>'),
  flow: P('<rect x="3" y="3" width="8" height="8" rx="2"/>|M7 11v4a2 2 0 0 0 2 2h4|<rect x="13" y="13" width="8" height="8" rx="2"/>'),
  filter: P('M22 3H2l8 9.46V19l4 2v-8.54L22 3z'),
  flask: P('M9 3h6|M10 3v6.5L4.5 19a1.5 1.5 0 0 0 1.3 2.2h12.4a1.5 1.5 0 0 0 1.3-2.2L14 9.5V3|M7 15h10'),
  send: P('M22 2 11 13|M22 2l-7 20-4-9-9-4 20-7z'),
  sliders: P('M4 21v-7|M4 10V3|M12 21v-9|M12 8V3|M20 21v-5|M20 12V3|M1 14h6|M9 8h6|M17 16h6'),
  shield: P('M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'),
  list: P('M8 6h13|M8 12h13|M8 18h13|M3 6h.01|M3 12h.01|M3 18h.01'),
  plus: P('M12 5v14|M5 12h14'),
  minus: P('M5 12h14'),
  trash: P('M3 6h18|M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6|M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'),
  edit: P('M12 20h9|M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z'),
  play: P('M6 3l14 9-14 9V3z'),
  stop: P('<rect x="5" y="5" width="14" height="14" rx="1.5"/>'),
  pause: P('M8 5v14|M16 5v14'),
  refresh: P('M21 12a9 9 0 1 1-3-6.7L21 8|M21 3v5h-5'),
  download: P('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4|M7 10l5 5 5-5|M12 15V3'),
  upload: P('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4|M17 8l-5-5-5 5|M12 3v12'),
  save: P('M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z|M17 21v-8H7v8|M7 3v5h8'),
  search: P('<circle cx="11" cy="11" r="8"/>|M21 21l-4.35-4.35'),
  x: P('M18 6 6 18|M6 6l12 12'),
  check: P('M20 6 9 17l-5-5'),
  alert: P('M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z|M12 9v4|M12 17h.01'),
  info: P('<circle cx="12" cy="12" r="10"/>|M12 16v-4|M12 8h.01'),
  logout: P('M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4|M16 17l5-5-5-5|M21 12H9'),
  moon: P('M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z'),
  sun: P('<circle cx="12" cy="12" r="4"/>|M12 2v2|M12 20v2|M4.93 4.93l1.41 1.41|M17.66 17.66l1.41 1.41|M2 12h2|M20 12h2|M6.34 17.66l-1.41 1.41|M19.07 4.93l-1.41 1.41'),
  menu: P('M3 12h18|M3 6h18|M3 18h18'),
  server: P('<rect x="2" y="2" width="20" height="8" rx="2"/>|<rect x="2" y="14" width="20" height="8" rx="2"/>|M6 6h.01|M6 18h.01'),
  message: P('M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'),
  globe: P('<circle cx="12" cy="12" r="10"/>|M2 12h20|M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z'),
  key: P('<circle cx="7.5" cy="15.5" r="5.5"/>|M21 2l-9.6 9.6|M15.5 7.5l3 3L22 7l-3-3'),
  copy: P('<rect x="9" y="9" width="13" height="13" rx="2"/>|M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'),
  maximize: P('M8 3H5a2 2 0 0 0-2 2v3|M21 8V5a2 2 0 0 0-2-2h-3|M3 16v3a2 2 0 0 0 2 2h3|M16 21h3a2 2 0 0 0 2-2v-3'),
  undo: P('M3 7v6h6|M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13'),
  redo: P('M21 7v6h-6|M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13'),
  grid: P('<rect x="3" y="3" width="7" height="7" rx="1"/>|<rect x="14" y="3" width="7" height="7" rx="1"/>|<rect x="14" y="14" width="7" height="7" rx="1"/>|<rect x="3" y="14" width="7" height="7" rx="1"/>'),
  rocket: P('M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z|M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z|M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0|M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5'),
  userCheck: P('M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2|<circle cx="8.5" cy="7" r="4"/>|M17 11l2 2 4-4'),
  arrowRight: P('M5 12h14|M12 5l7 7-7 7'),
  chevronRight: P('M9 18l6-6-6-6'),
  chevronDown: P('M6 9l6 6 6-6'),
  eye: P('M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z|<circle cx="12" cy="12" r="3"/>'),
  lock: P('<rect x="3" y="11" width="18" height="11" rx="2"/>|M7 11V7a5 5 0 0 1 10 0v4'),
  clock: P('<circle cx="12" cy="12" r="10"/>|M12 6v6l4 2'),
  layers: P('M12 2 2 7l10 5 10-5-10-5z|M2 17l10 5 10-5|M2 12l10 5 10-5'),
  inbox: P('M22 12h-6l-2 3h-4l-2-3H2|M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z'),
  code: P('M16 18l6-6-6-6|M8 6l-6 6 6 6'),
  database: P('<ellipse cx="12" cy="5" rx="9" ry="3"/>|M21 12c0 1.66-4 3-9 3s-9-1.34-9-3|M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5'),
  zap: P('M13 2 3 14h9l-1 8 10-12h-9l1-8z')
};
export const icon = (name, cls = '') =>
  raw(`<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.info}</svg>`);

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------
export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function api(path, { method = 'GET', body, query, redirect401 = true } = {}) {
  let url = path;
  if (query) {
    const q = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== '' && v !== null));
    if ([...q].length) url += `?${q}`;
  }
  const headers = { 'X-Requested-With': 'jasmin-console' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  } catch (e) {
    throw new ApiError('Cannot reach the console server', 0);
  }
  if (res.status === 401 && redirect401 && !path.startsWith('/auth/')) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.hash)}`;
    throw new ApiError('Session expired', 401);
  }
  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    const msg = (data && data.error) || (typeof data === 'string' && data) || `Request failed (${res.status})`;
    throw new ApiError(msg, res.status, data);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
let toastHost;
export function toast(message, type = 'info', detail = '') {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toasts';
    toastHost.setAttribute('role', 'status');
    toastHost.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastHost);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const ic = { ok: 'check', err: 'alert', warn: 'alert', info: 'info' }[type] || 'info';
  render(el, html`${icon(ic)}<div class="msg">${message}${detail ? html`<small>${detail}</small>` : ''}</div>
    <button class="btn ghost sm icon-only" aria-label="Dismiss">${icon('x')}</button>`);
  el.querySelector('button').onclick = () => el.remove();
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), type === 'err' ? 9000 : 4500);
}

export const toastError = (err, prefix = '') => {
  const detail = err?.body?.errors ? err.body.errors.join('\n') : '';
  toast(`${prefix}${err?.message || err}`, 'err', detail);
};

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------
function openDialog(content, { wide = false } = {}) {
  const dlg = document.createElement('dialog');
  dlg.className = `modal${wide ? ' wide' : ''}`;
  render(dlg, content);
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => setTimeout(() => dlg.remove(), 0));
  dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dlg.close()));
  dlg.showModal();
  return dlg;
}

/** Confirmation dialog; resolves true when confirmed. */
export function confirmDialog({ title, message, confirmText = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const dlg = openDialog(html`
      <div class="modal-head"><h3>${title}</h3><button class="btn ghost sm icon-only" data-close aria-label="Close">${icon('x')}</button></div>
      <div class="modal-body"><p>${message}</p></div>
      <div class="modal-foot">
        <button class="btn" data-close>Cancel</button>
        <button class="btn ${danger ? 'danger-solid' : 'primary'}" data-ok>${confirmText}</button>
      </div>`);
    let ok = false;
    dlg.querySelector('[data-ok]').onclick = () => {
      ok = true;
      dlg.close();
    };
    dlg.addEventListener('close', () => resolve(ok));
  });
}

/**
 * Generic form dialog.
 * fields: [{name, label, type: text|password|number|select|textarea|checkbox|multiselect, options, value, hint, required, placeholder, mono, row}]
 * onSubmit(values) may throw to keep the dialog open; errors are shown inline.
 */
export function formDialog({ title, description, fields, submitText = 'Save', onSubmit, wide = false, footLeft }) {
  const fieldHtml = (f) => {
    const id = `f_${f.name}`;
    const common = html`id="${id}" name="${f.name}" ${f.required ? raw('required') : ''} ${f.readonly ? raw('readonly') : ''}`;
    let control;
    if (f.type === 'select') {
      control = html`<select class="select" ${common}>${(f.options || []).map((o) => {
        const [v, l] = Array.isArray(o) ? o : [o, o];
        return html`<option value="${v}" ${String(v) === String(f.value ?? '') ? raw('selected') : ''}>${l}</option>`;
      })}</select>`;
    } else if (f.type === 'multiselect') {
      const selected = new Set((f.value || []).map(String));
      control = html`<div class="chips" style="gap:6px" data-multi="${f.name}">${(f.options || []).length
        ? f.options.map((o) => {
            const [v, l] = Array.isArray(o) ? o : [o, o];
            return html`<label class="checkbox chip" style="line-height:24px"><input type="checkbox" value="${v}" ${selected.has(String(v)) ? raw('checked') : ''}> ${l}</label>`;
          })
        : html`<span class="muted">${f.emptyText || 'Nothing available'}</span>`}</div>`;
    } else if (f.type === 'textarea') {
      control = html`<textarea class="textarea ${f.mono ? 'mono' : ''}" ${common} placeholder="${f.placeholder || ''}" rows="${f.rows || 4}">${f.value ?? ''}</textarea>`;
    } else if (f.type === 'checkbox') {
      return html`<div class="field"><label class="checkbox"><input type="checkbox" ${common} ${f.value ? raw('checked') : ''}> ${f.label}</label>${f.hint ? html`<span class="hint">${f.hint}</span>` : ''}</div>`;
    } else {
      control = html`<input class="input ${f.mono ? 'mono' : ''}" type="${f.type || 'text'}" ${common} value="${f.value ?? ''}" placeholder="${f.placeholder || ''}"
        ${f.step ? raw(`step="${esc(f.step)}"`) : ''} ${f.min !== undefined ? raw(`min="${esc(f.min)}"`) : ''} ${f.max !== undefined ? raw(`max="${esc(f.max)}"`) : ''}
        autocomplete="${f.autocomplete || 'off'}">`;
    }
    return html`<div class="field" data-field="${f.name}"><label for="${id}">${f.label}${f.required ? raw(' <span class="text-err">*</span>') : ''}</label>${control}
      ${f.hint ? html`<span class="hint">${f.hint}</span>` : ''}<span class="error-text" hidden></span></div>`;
  };

  // Group consecutive fields with the same `row` key side by side.
  const parts = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.row) {
      const group = [f];
      while (fields[i + 1]?.row === f.row) group.push(fields[++i]);
      parts.push(html`<div class="form-row">${group.map(fieldHtml)}</div>`);
    } else parts.push(fieldHtml(f));
  }

  const dlg = openDialog(
    html`<form method="dialog" novalidate>
      <div class="modal-head"><h3>${title}</h3><button type="button" class="btn ghost sm icon-only" data-close aria-label="Close">${icon('x')}</button></div>
      <div class="modal-body">
        ${description ? html`<p class="muted" style="margin-bottom:14px">${description}</p>` : ''}
        <div class="banner err" data-form-error hidden>${icon('alert')}<div></div></div>
        ${parts}
      </div>
      <div class="modal-foot">${footLeft ? html`<div class="left">${footLeft}</div>` : ''}
        <button type="button" class="btn" data-close>Cancel</button>
        <button type="submit" class="btn primary" data-submit>${submitText}</button>
      </div>
    </form>`,
    { wide }
  );
  const form = dlg.querySelector('form');
  const values = () => {
    const out = {};
    for (const f of fields) {
      if (f.type === 'multiselect') out[f.name] = [...form.querySelectorAll(`[data-multi="${f.name}"] input:checked`)].map((i) => i.value);
      else if (f.type === 'checkbox') out[f.name] = form.elements[f.name].checked;
      else out[f.name] = form.elements[f.name].value.trim();
    }
    return out;
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const box = form.querySelector('[data-form-error]');
    box.hidden = true;
    form.querySelectorAll('.error-text').forEach((x) => (x.hidden = true));
    const v = values();
    for (const f of fields) {
      const missing = f.required && (f.type === 'multiselect' ? v[f.name].length === 0 : v[f.name] === '');
      if (missing) {
        const err = form.querySelector(`[data-field="${f.name}"] .error-text`);
        if (err) {
          err.textContent = `${f.label} is required`;
          err.hidden = false;
        }
        return;
      }
    }
    const btn = form.querySelector('[data-submit]');
    btn.disabled = true;
    const label = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span>';
    try {
      await onSubmit(v, dlg);
      dlg.close();
    } catch (err) {
      box.querySelector('div').textContent = err.body?.errors ? `${err.message}: ${err.body.errors.join('; ')}` : err.message;
      box.hidden = false;
    } finally {
      btn.disabled = false;
      btn.innerHTML = label;
    }
  });
  setTimeout(() => form.querySelector('input:not([type=checkbox]):not([readonly]),select,textarea')?.focus(), 30);
  return dlg;
}

/** Read-only dialog showing arbitrary content. */
export function infoDialog(title, body, { wide = true } = {}) {
  return openDialog(
    html`<div class="modal-head"><h3>${title}</h3><button class="btn ghost sm icon-only" data-close aria-label="Close">${icon('x')}</button></div>
      <div class="modal-body">${body}</div>
      <div class="modal-foot"><button class="btn" data-close>Close</button></div>`,
    { wide }
  );
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
const nf = new Intl.NumberFormat();
export const fmtNum = (n) => (Number.isFinite(Number(n)) ? nf.format(Number(n)) : String(n ?? '—'));
export const fmtTime = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour12: false }) : '—');
export const fmtDateTime = (ts) => (ts ? new Date(ts).toLocaleString([], { hour12: false }) : '—');
export function fmtAgo(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
export const pct = (a, b) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '—');

export function debounce(fn, ms = 250) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function download(filename, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Simple event bus shared by views. */
export const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export const on = (type, fn) => {
  const h = (e) => fn(e.detail);
  bus.addEventListener(type, h);
  return () => bus.removeEventListener(type, h);
};

/** SMPP connector health from smppccm/stats fields. */
export function connectorHealth(c) {
  if (c.service !== 'started') return { level: '', text: 'Stopped' };
  if (/^BOUND/.test(c.session)) return { level: 'ok', text: c.session.replace('BOUND_', 'Bound ') };
  return { level: 'warn', text: c.session && c.session !== 'NONE' ? c.session : 'Connecting' };
}
