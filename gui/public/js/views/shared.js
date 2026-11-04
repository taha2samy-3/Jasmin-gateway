import { html, icon } from '../lib.js';

const loaded = new Map();
/** Load a classic script once (vendor libraries served from /vendor). */
export function loadScript(src) {
  if (!loaded.has(src)) {
    loaded.set(
      src,
      new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => {
          loaded.delete(src);
          reject(new Error(`Failed to load ${src}`));
        };
        document.head.appendChild(s);
      })
    );
  }
  return loaded.get(src);
}

export function loadStyle(href) {
  if (!document.querySelector(`link[href="${href}"]`)) {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    document.head.appendChild(l);
  }
}

/** Badge for a message status (submit_sm_resp / DLR). */
export function statusBadge(status) {
  const s = String(status || '');
  if (s === 'SUBMITTED') return html`<span class="badge info">${icon('clock')} Queued</span>`;
  if (s === 'ESME_ROK') return html`<span class="badge brand">Accepted</span>`;
  if (s === 'DELIVRD') return html`<span class="badge ok">${icon('check')} Delivered</span>`;
  if (s === 'ENROUTE' || s === 'ACCEPTD') return html`<span class="badge brand">${s}</span>`;
  return html`<span class="badge err">${s || 'Unknown'}</span>`;
}

/** Standard page header. */
export const pageHead = (title, description, actions = '') =>
  html`<div class="page-head"><div><h1>${title}</h1>${description ? html`<p>${description}</p>` : ''}</div><div class="actions">${actions}</div></div>`;

export const emptyRow = (cols, iconName, title, text) =>
  html`<tr><td colspan="${cols}"><div class="empty">${icon(iconName)}<h3>${title}</h3>${text ? html`<p>${text}</p>` : ''}</div></td></tr>`;

export const offlineBanner = (err) =>
  html`<div class="banner err">${icon('alert')}<div><strong>Jasmin is not reachable.</strong> ${err?.message || ''}</div></div>`;

/** Readable route type names. */
export const ROUTE_LABEL = {
  DefaultRoute: 'Default',
  StaticMTRoute: 'Static',
  RandomRoundrobinMTRoute: 'Round-robin',
  FailoverMTRoute: 'Failover',
  StaticMORoute: 'Static',
  RandomRoundrobinMORoute: 'Round-robin',
  FailoverMORoute: 'Failover'
};
