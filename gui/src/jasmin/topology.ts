import * as crypto from 'crypto';
import { JCliClient } from './jcli-client.js';
import type { GatewaySnapshot } from './gateway.js';
import type { JasminFilter, JasminMtRoute, JasminUser } from './types.js';

export type NodeType = 'ingress' | 'user' | 'interceptor' | 'filter' | 'route' | 'connector';

export interface FlowNode {
  id: string;
  type: NodeType;
  x: number;
  y: number;
  data: Record<string, any>;
}

export interface FlowWire {
  from: string;
  to: string;
  role?: 'pri' | 'bak';
}

export interface FlowGraph {
  nodes: FlowNode[];
  connections: FlowWire[];
}

/**
 * jCLI parameter used by `filter -a` for each filter class, the short tag Jasmin prints in
 * descriptions (Filter._repr) and the route kinds it can be used on (Filter.usedFor).
 */
export const FILTER_PARAM: Record<string, { key: string | null; tag: string; descKey?: string; usedFor: Array<'mt' | 'mo'> }> = {
  TransparentFilter: { key: null, tag: 'T', usedFor: ['mt', 'mo'] },
  DestinationAddrFilter: { key: 'destination_addr', tag: 'DA', descKey: 'dst_addr', usedFor: ['mt', 'mo'] },
  SourceAddrFilter: { key: 'source_addr', tag: 'SA', descKey: 'src_addr', usedFor: ['mt', 'mo'] },
  ShortMessageFilter: { key: 'short_message', tag: 'SM', descKey: 'msg', usedFor: ['mt', 'mo'] },
  UserFilter: { key: 'uid', tag: 'U', descKey: 'uid', usedFor: ['mt'] },
  GroupFilter: { key: 'gid', tag: 'G', descKey: 'gid', usedFor: ['mt'] },
  TagFilter: { key: 'tag', tag: 'TG', descKey: 'tag', usedFor: ['mt', 'mo'] },
  ConnectorFilter: { key: 'cid', tag: 'C', descKey: 'cid', usedFor: ['mo'] },
  DateIntervalFilter: { key: 'dateInterval', tag: 'DI', usedFor: ['mt', 'mo'] },
  TimeIntervalFilter: { key: 'timeInterval', tag: 'TI', usedFor: ['mt', 'mo'] },
  // Jasmin prints only the first 10 characters of the script: `<Ev (pyCode=<10 chars> ..)>`.
  EvalPyFilter: { key: 'pyCode', tag: 'Ev', descKey: 'pyCode', usedFor: ['mt', 'mo'] }
};

/** Identifier rules enforced by jCLI 0.11.1 (filtersm.py, smppccm.py). */
export const FID_RE = /^[A-Za-z0-9_-]{1,16}$/;
export const CID_RE = /^[A-Za-z0-9_-]{3,25}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}:\d{2}$/;

/** Problems jCLI would reject for a filter value (checked before anything is deployed). */
export function filterValueProblem(type: string, value: string): string | null {
  const spec = FILTER_PARAM[type];
  if (!spec) return `unsupported type "${type}"`;
  if (!spec.key) return null;
  if (!value) return 'a value is required';
  if (type === 'DateIntervalFilter' || type === 'TimeIntervalFilter') {
    const re = type === 'DateIntervalFilter' ? DATE_RE : TIME_RE;
    const parts = value.split(';');
    if (parts.length !== 2 || !parts.every((p) => re.test(p))) return `use ${type === 'DateIntervalFilter' ? 'YYYY-MM-DD;YYYY-MM-DD' : 'HH:MM:SS;HH:MM:SS'}`;
    if (parts[0] >= parts[1]) return 'the right border must be after the left border';
  }
  if (type === 'TagFilter' && !/^\d+$/.test(value)) return 'a tag is a non-negative integer';
  if (['DestinationAddrFilter', 'SourceAddrFilter', 'ShortMessageFilter'].includes(type)) {
    if (/\(\?P[<=]/.test(value)) return null; // Python named groups: valid for Jasmin, not for JavaScript.
    try {
      new RegExp(value);
    } catch {
      return 'not a valid regular expression';
    }
  }
  return null;
}

/** Jasmin lists rates with 5 decimals, so compare at that precision. */
const rate5 = (n: number) => Math.round(n * 1e5) / 1e5;

/** The description jCLI prints for a filter (used to map route filter lists back to FIDs). */
export function filterDescription(type: string, value: string): string {
  const p = FILTER_PARAM[type];
  if (!p) return '';
  if (!p.key) return `<${p.tag}>`;
  if (p.tag === 'DI' || p.tag === 'TI') return `<${p.tag} (${value.split(';').join(',')})>`;
  return `<${p.tag} (${p.descKey}=${value})>`;
}

export const cidOf = (typed: string) => typed.replace(/^(smppc|http|smpps)\((.*)\)$/i, '$2').trim();

/** Map each MT route's filter descriptions to FIDs. Unknown descriptions are returned as `inline`. */
export function resolveRouteFilters(route: JasminMtRoute, filters: JasminFilter[]): Array<{ fid?: string; description: string }> {
  return route.filters.map((description) => {
    const match = filters.find((f) => f.description === description);
    return match ? { fid: match.fid, description } : { description };
  });
}

const COLUMN_X: Record<NodeType, number> = { ingress: 20, user: 240, interceptor: 460, filter: 460, route: 680, connector: 900 };
const ROW_GAP = 76;

export interface TopologyOptions {
  httpPort?: number;
  smppPort?: number;
}

/** Build the editable flow graph from the live gateway state. */
export function buildTopology(s: GatewaySnapshot, opts: TopologyOptions = {}): FlowGraph & { warnings: string[] } {
  const nodes: FlowNode[] = [];
  const connections: FlowWire[] = [];
  const warnings: string[] = [];
  const col: Record<NodeType, number> = { ingress: 0, user: 0, interceptor: 0, filter: 0, route: 0, connector: 0 };
  const add = (type: NodeType, id: string, data: Record<string, any>) => {
    const node: FlowNode = { id, type, x: COLUMN_X[type], y: 30 + col[type]++ * ROW_GAP, data };
    nodes.push(node);
    return node;
  };

  add('ingress', 'ingress_http', { protocol: 'http', port: opts.httpPort ?? 1401 });
  add('ingress', 'ingress_smpp', { protocol: 'smpp', port: opts.smppPort ?? 2775 });

  for (const u of s.users) {
    add('user', `user_${u.uid}`, { ...u, existing: true });
    connections.push({ from: 'ingress_http', to: `user_${u.uid}` }, { from: 'ingress_smpp', to: `user_${u.uid}` });
  }

  for (const i of s.mtInterceptors) add('interceptor', `interceptor_${i.order}`, { ...i, existing: true });

  // Routes are listed highest order first by jCLI; keep that (it is evaluation order).
  const routes = [...s.mtRoutes].sort((a, b) => b.order - a.order);

  // Place filters next to the first route that uses them.
  const filterRank = new Map<string, number>();
  routes.forEach((r, ri) => {
    for (const rf of resolveRouteFilters(r, s.filters)) if (rf.fid && !filterRank.has(rf.fid)) filterRank.set(rf.fid, ri);
  });
  const filters = [...s.filters]
    .filter((f) => f.routes.includes('MT'))
    .sort((a, b) => (filterRank.get(a.fid) ?? 999) - (filterRank.get(b.fid) ?? 999));
  for (const f of filters) {
    add('filter', `filter_${f.fid}`, { fid: f.fid, type: f.type, value: f.value, description: f.description, existing: true });
    if (f.type === 'UserFilter' && s.users.some((u) => u.uid === f.value)) connections.push({ from: `user_${f.value}`, to: `filter_${f.fid}` });
    if (f.type === 'GroupFilter') {
      for (const u of s.users.filter((u) => u.gid === f.value)) connections.push({ from: `user_${u.uid}`, to: `filter_${f.fid}` });
    }
  }

  const connectorIds = new Set<string>();
  const ensureConnector = (cid: string) => {
    const id = `smppc_${cid}`;
    if (connectorIds.has(id)) return id;
    connectorIds.add(id);
    const live = s.smppConnectors.find((c) => c.cid === cid);
    if (live) add('connector', id, { ...live, kind: 'smpp', existing: true });
    else {
      add('connector', id, { cid, kind: 'smpp', missing: true, existing: true });
      warnings.push(`A route uses smppc(${cid}), which no longer exists in the gateway.`);
    }
    return id;
  };

  let inlineSeq = 0;
  // Two named filters with the same definition print the same description: Jasmin's route listing
  // cannot tell which FID a route was built with, so the first one is wired. Flag the ambiguity.
  const byDescription = new Map<string, string[]>();
  for (const f of s.filters.filter((f) => f.routes.includes('MT'))) byDescription.set(f.description, [...(byDescription.get(f.description) ?? []), f.fid]);
  for (const [description, fids] of byDescription) {
    if (fids.length > 1) warnings.push(`Filters ${fids.join(', ')} have the same definition ${description}; routes using it are shown wired to ${fids[0]}. Editing the others will not rebuild those routes.`);
  }

  for (const r of routes) {
    const rid = `route_${r.order}`;
    add('route', rid, { order: r.order, type: r.type, rate: r.rate, existing: true });
    for (const rf of resolveRouteFilters(r, s.filters)) {
      if (rf.fid) {
        if (!nodes.some((n) => n.id === `filter_${rf.fid}`)) continue;
        connections.push({ from: `filter_${rf.fid}`, to: rid });
      } else {
        // The route still holds a copy of a filter that was deleted or changed after the route was created.
        const id = `filter_inline_${++inlineSeq}`;
        add('filter', id, { fid: '', type: '', value: '', description: rf.description, inline: true });
        connections.push({ from: id, to: rid });
        warnings.push(`Route #${r.order} uses a filter ${rf.description} that no longer exists as a named filter.`);
      }
    }
    for (const typed of r.connectors) connections.push({ from: rid, to: ensureConnector(cidOf(typed)) });
  }
  for (const c of s.smppConnectors) ensureConnector(c.cid);

  return { nodes, connections, warnings };
}

// ---------------------------------------------------------------------------
// Deploy planning
// ---------------------------------------------------------------------------

export type PlanAction = 'add' | 'replace' | 'remove';

export interface PlanStep {
  action: PlanAction;
  kind: 'group' | 'user' | 'connector' | 'filter' | 'route';
  id: string;
  summary: string;
  /** Executes the step against a jCLI session. */
  run: (c: JCliClient) => Promise<void>;
}

export interface DeployPlan {
  steps: PlanStep[];
  errors: string[];
  /** Not blocking, but shown in the review (e.g. the DefaultRoute will be removed). */
  warnings: string[];
  unchanged: number;
}

function wiredFilters(graph: FlowGraph, routeId: string): FlowNode[] {
  return graph.connections
    .filter((w) => w.to === routeId)
    .map((w) => graph.nodes.find((n) => n.id === w.from))
    .filter((n): n is FlowNode => !!n && n.type === 'filter');
}

function wiredConnectors(graph: FlowGraph, routeId: string): FlowNode[] {
  const rank = (w: FlowWire) => (w.role === 'bak' ? 1 : 0);
  return graph.connections
    .map((w, i) => ({ w, i }))
    .filter(({ w }) => w.from === routeId)
    .sort((a, b) => rank(a.w) - rank(b.w) || a.i - b.i)
    .map(({ w }) => graph.nodes.find((n) => n.id === w.to))
    .filter((n): n is FlowNode => !!n && n.type === 'connector');
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const sameSet = (a: string[], b: string[]) => sameList([...a].sort(), [...b].sort());

/**
 * Compare the edited graph with the live gateway and produce the jCLI changes needed.
 * Only MT routing is driven by the graph. Users and connectors are created when missing but never
 * modified or removed. With `prune`, live MT routes that are absent from the graph are removed.
 */
export function planDeploy(graph: FlowGraph, s: GatewaySnapshot, opts: { prune?: boolean } = {}): DeployPlan {
  const steps: PlanStep[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  let unchanged = 0;

  // Groups and users ---------------------------------------------------------
  const groups = new Set(s.groups.map((g) => g.gid));
  for (const n of graph.nodes.filter((n) => n.type === 'user')) {
    const d = n.data;
    if (s.users.some((u: JasminUser) => u.uid === d.uid)) {
      unchanged++;
      continue;
    }
    if (!d.uid || !d.gid || !d.username || !d.password) {
      errors.push(`User "${d.uid || n.id}" is new: UID, group, username and password are required.`);
      continue;
    }
    if (!groups.has(d.gid)) {
      groups.add(d.gid);
      steps.push({ action: 'add', kind: 'group', id: d.gid, summary: `group ${d.gid}`, run: (c) => c.createGroup(d.gid) });
    }
    steps.push({
      action: 'add',
      kind: 'user',
      id: d.uid,
      summary: `user ${d.uid} (${d.username}) in ${d.gid}`,
      run: (c) =>
        c.createUser({
          uid: d.uid,
          gid: d.gid,
          username: d.username,
          password: d.password,
          balance: d.balance !== undefined && d.balance !== '' ? Number(d.balance) : undefined,
          httpThroughput: d.throughput !== undefined && d.throughput !== '' && !isNaN(Number(d.throughput)) ? Number(d.throughput) : undefined
        })
    });
  }

  // Connectors ---------------------------------------------------------------
  for (const n of graph.nodes.filter((n) => n.type === 'connector')) {
    const d = n.data;
    if (d.kind === 'http') {
      if (s.httpConnectors.some((h) => h.cid === d.cid)) unchanged++;
      else if (!d.url) errors.push(`HTTP connector "${d.cid}" is new: a URL is required.`);
      else steps.push({ action: 'add', kind: 'connector', id: d.cid, summary: `http(${d.cid}) → ${d.url}`, run: (c) => c.createHttpConnector(d.cid, d.url, d.method || 'POST') });
      continue;
    }
    if (s.smppConnectors.some((c) => c.cid === d.cid)) {
      unchanged++;
      continue;
    }
    // Placeholder for a connector a live route still references but that no longer exists:
    // nothing to create; only an error if a changed route wants to use it (checked below).
    if (d.missing) continue;
    if (!CID_RE.test(String(d.cid ?? ''))) {
      errors.push(`SMPP connector "${d.cid}": ID must be 3-25 characters (letters, digits, _ or -).`);
      continue;
    }
    if (!d.host || !d.port || !d.username || !d.password) {
      errors.push(`SMPP connector "${d.cid}" is new: host, port, system ID and password are required.`);
      continue;
    }
    steps.push({
      action: 'add',
      kind: 'connector',
      id: d.cid,
      summary: `smppc(${d.cid}) → ${d.host}:${d.port}`,
      run: (c) => c.createSmppConnector({ cid: d.cid, host: d.host, port: Number(d.port), username: d.username, password: d.password })
    });
  }

  // Filters ------------------------------------------------------------------
  const changedFilters = new Set<string>();
  const usedFilterNodes = new Set(graph.connections.filter((w) => graph.nodes.find((n) => n.id === w.to)?.type === 'route').map((w) => w.from));
  for (const n of graph.nodes.filter((n) => n.type === 'filter')) {
    const d = n.data;
    if (d.inline) continue; // Only an error when a changed route uses it (see MT routes).
    const spec = FILTER_PARAM[d.type];
    if (!spec) {
      errors.push(`Filter "${d.fid}": unsupported type "${d.type}".`);
      continue;
    }
    const value = String(d.value ?? '').trim();
    const live = s.filters.find((f) => f.fid === d.fid);
    if (!FID_RE.test(String(d.fid ?? ''))) {
      errors.push(`Filter "${d.fid}": ID must be 1-16 characters (letters, digits, _ or -).`);
      continue;
    }
    if (usedFilterNodes.has(n.id) && !spec.usedFor.includes('mt')) {
      errors.push(`Filter "${d.fid}": ${d.type} only works on MO routes and cannot be used on an MT route.`);
      continue;
    }
    if (!(live && live.type === d.type && live.value === value)) {
      const problem = filterValueProblem(d.type, value);
      if (problem) {
        errors.push(`Filter "${d.fid}" (${d.type}): ${problem}.`);
        continue;
      }
    }
    if (live && live.type === d.type && live.value === value) {
      unchanged++;
      continue;
    }
    const action: PlanAction = live ? 'replace' : 'add';
    if (live) changedFilters.add(d.fid);
    steps.push({
      action,
      kind: 'filter',
      id: d.fid,
      summary: `${d.fid}: ${d.type}${spec.key ? ` ${spec.key}=${value}` : ''}`,
      run: async (c) => {
        if (live) await c.deleteFilter(d.fid);
        await c.createFilter(d.fid, d.type, spec.key, value);
      }
    });
  }

  // MT routes ----------------------------------------------------------------
  const desiredOrders = new Set<number>();
  const MT_TYPES = ['DefaultRoute', 'StaticMTRoute', 'RandomRoundrobinMTRoute', 'FailoverMTRoute'];
  for (const n of graph.nodes.filter((n) => n.type === 'route')) {
    const d = n.data;
    const isDefault = d.type === 'DefaultRoute';
    const order = isDefault ? 0 : d.order === '' || d.order === null || d.order === undefined ? NaN : Number(d.order);
    const label = Number.isFinite(order) ? `#${order}` : `"${n.id}"`;
    if (!MT_TYPES.includes(d.type)) {
      errors.push(`Route ${label}: unsupported type "${d.type}".`);
      continue;
    }
    if (!isDefault && (!Number.isInteger(order) || order < 1)) {
      errors.push(`Route ${label}: order must be an integer ≥ 1 (0 is reserved for the DefaultRoute).`);
      continue;
    }
    const rate = Number(d.rate ?? 0);
    if (!Number.isFinite(rate) || rate < 0) {
      errors.push(`Route ${label}: rate must be a number ≥ 0.`);
      continue;
    }
    const filterNodes = wiredFilters(graph, n.id);
    const connectorNodes = wiredConnectors(graph, n.id);
    // Inline nodes stand for a filter copy the live route still holds; compare them by description.
    const fids = filterNodes.map((f) => (f.data.inline ? `?${f.data.description}` : f.data.fid)).filter(Boolean);
    const cids = connectorNodes.map((c) => c.data.cid);
    if (cids.length === 0) {
      errors.push(`Route ${label} has no connector.`);
      continue;
    }
    if (desiredOrders.has(order)) {
      errors.push(`Two routes use order ${order}.`);
      continue;
    }
    desiredOrders.add(order);

    const live = s.mtRoutes.find((r) => r.order === order);
    if (live) {
      const liveFids = resolveRouteFilters(live, s.filters).map((f) => f.fid ?? `?${f.description}`);
      const same =
        live.type === d.type &&
        rate5(live.rate) === rate5(rate) &&
        sameList(live.connectors.map(cidOf), cids) &&
        sameSet(liveFids, fids) &&
        !fids.some((f) => changedFilters.has(f));
      if (same) {
        unchanged++;
        continue;
      }
    }
    // The route will be (re)written: everything it references must be deployable.
    const routeProblems: string[] = [];
    if (isDefault && (cids.length !== 1 || fids.length)) routeProblems.push('a DefaultRoute takes exactly one connector and no filters');
    if (d.type === 'StaticMTRoute' && cids.length !== 1) routeProblems.push('a StaticMTRoute takes exactly one connector');
    if ((d.type === 'RandomRoundrobinMTRoute' || d.type === 'FailoverMTRoute') && cids.length < 2) routeProblems.push(`a ${d.type} needs at least two connectors`);
    if (!isDefault && fids.length === 0) routeProblems.push(`a ${d.type} needs at least one filter`);
    for (const f of filterNodes) if (f.data.inline) routeProblems.push(`unnamed filter ${f.data.description}: open it and give it a Filter ID, type and value`);
    for (const c of connectorNodes) if (c.data.missing) routeProblems.push(`connector smppc(${c.data.cid}) no longer exists`);
    if (routeProblems.length) {
      errors.push(`Route ${label}: ${routeProblems.join('; ')}.`);
      continue;
    }
    steps.push({
      action: live ? 'replace' : 'add',
      kind: 'route',
      id: String(order),
      summary: `#${order} ${d.type} rate=${rate} → ${cids.join(', ')}${fids.length ? ` [${fids.join(', ')}]` : ''}`,
      // Adding a route with an existing order replaces it atomically in Jasmin.
      run: (c) => c.createMtRoute(d.type, rate, cids, order, fids)
    });
  }

  if (opts.prune) {
    for (const r of s.mtRoutes) {
      if (desiredOrders.has(r.order)) continue;
      steps.push({ action: 'remove', kind: 'route', id: String(r.order), summary: `#${r.order} ${r.type}`, run: (c) => c.deleteMtRoute(r.order) });
      if (r.order === 0) warnings.push('The DefaultRoute (#0) will be removed: messages that match no other route will be rejected.');
    }
  }
  if (steps.some((st) => st.action === 'remove')) {
    const n = steps.filter((st) => st.action === 'remove').length;
    warnings.push(`${n} live route(s) are not in the flow and will be removed (prune).`);
  }

  // Execution order: groups, users, connectors, filters, then routes (routes reference the others).
  const rank = { group: 0, user: 1, connector: 2, filter: 3, route: 4 } as const;
  steps.sort((a, b) => rank[a.kind] - rank[b.kind]);
  return { steps, errors, warnings, unchanged };
}

/**
 * Identifies a plan by what it would do. The deploy endpoint recomputes the plan from a fresh
 * snapshot and refuses when it differs from the plan the user reviewed (someone else changed the
 * gateway in between, or the editor worked from a stale baseline).
 */
export function planFingerprint(plan: DeployPlan): string {
  const body = JSON.stringify(plan.steps.map(({ action, kind, id, summary }) => [action, kind, id, summary]));
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 32);
}

/** Serializable view of a plan (functions removed). */
export function describePlan(plan: DeployPlan) {
  return {
    errors: plan.errors,
    warnings: plan.warnings,
    fingerprint: planFingerprint(plan),
    unchanged: plan.unchanged,
    steps: plan.steps.map(({ action, kind, id, summary }) => ({ action, kind, id, summary }))
  };
}

/** Execute plan steps in order; stops at the first failure and reports what ran. */
export async function applyPlan(c: JCliClient, plan: DeployPlan) {
  const done: Array<{ action: string; kind: string; id: string; summary: string }> = [];
  for (const step of plan.steps) {
    try {
      await step.run(c);
      done.push({ action: step.action, kind: step.kind, id: step.id, summary: step.summary });
    } catch (err: any) {
      throw Object.assign(new Error(`${step.action} ${step.kind} ${step.id}: ${err.message}`), { done });
    }
  }
  return done;
}

// ---------------------------------------------------------------------------
// Route simulation (mirrors jasmin.routing.Filters semantics)
// ---------------------------------------------------------------------------

export interface SimulationInput {
  uid?: string;
  source_addr?: string;
  destination_addr: string;
  text?: string;
  /** Jasmin compares tags as strings. */
  tags?: Array<string | number>;
  at?: Date;
}

export interface FilterVerdict {
  fid: string;
  description: string;
  matched: boolean | null;
  reason: string;
}

function evalFilter(type: string, value: string, input: SimulationInput, user?: JasminUser): { matched: boolean | null; reason: string } {
  // Jasmin compiles patterns with re.compile() and uses .match(): anchored at the start, not at the end.
  const reMatch = (pattern: string, subject: string) => {
    try {
      return new RegExp(`^(?:${pattern})`).test(subject);
    } catch (e: any) {
      return null;
    }
  };
  switch (type) {
    case 'TransparentFilter':
      return { matched: true, reason: 'matches every message' };
    case 'DestinationAddrFilter': {
      const m = reMatch(value, input.destination_addr);
      return { matched: m, reason: m === null ? 'pattern is not valid in JavaScript' : `destination ${input.destination_addr} ${m ? 'matches' : 'does not match'} ${value}` };
    }
    case 'SourceAddrFilter': {
      const m = reMatch(value, input.source_addr ?? '');
      return { matched: m, reason: m === null ? 'pattern is not valid in JavaScript' : `sender "${input.source_addr ?? ''}" ${m ? 'matches' : 'does not match'} ${value}` };
    }
    case 'ShortMessageFilter': {
      const m = reMatch(value, input.text ?? '');
      return { matched: m, reason: m === null ? 'pattern is not valid in JavaScript' : `message body ${m ? 'matches' : 'does not match'} ${value}` };
    }
    case 'UserFilter':
      return { matched: input.uid === value, reason: input.uid ? `user ${input.uid} ${input.uid === value ? '=' : '≠'} ${value}` : 'no user given' };
    case 'GroupFilter':
      return { matched: !!user && user.gid === value, reason: user ? `group ${user.gid} ${user.gid === value ? '=' : '≠'} ${value}` : 'user unknown, group cannot be resolved' };
    case 'TagFilter': {
      const present = (input.tags ?? []).map(String).includes(String(value));
      return { matched: present, reason: `tag ${value} ${present ? 'present' : 'absent'}` };
    }
    case 'TimeIntervalFilter': {
      const [a, b] = value.split(';');
      const now = (input.at ?? new Date()).toTimeString().slice(0, 8);
      const m = !!a && !!b && now >= a && now <= b;
      return { matched: m, reason: `time ${now} ${m ? 'inside' : 'outside'} ${a}–${b}` };
    }
    case 'DateIntervalFilter': {
      const [a, b] = value.split(';');
      // Jasmin uses the gateway's local date (datetime.now()), like the time filter below.
      const at = input.at ?? new Date();
      const today = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
      const m = !!a && !!b && today >= a && today <= b;
      return { matched: m, reason: `date ${today} ${m ? 'inside' : 'outside'} ${a}–${b}` };
    }
    default:
      return { matched: null, reason: `${type || 'this filter'} cannot be evaluated by the simulator` };
  }
}

/** Evaluate MT routes in Jasmin order (highest order first, DefaultRoute last). */
export function simulateMtRouting(s: GatewaySnapshot, input: SimulationInput) {
  const user = input.uid ? s.users.find((u) => u.uid === input.uid) : undefined;
  const trace: Array<{ order: number; type: string; connectors: string[]; filters: FilterVerdict[]; matched: boolean | null }> = [];
  let winner: JasminMtRoute | null = null;

  for (const route of [...s.mtRoutes].sort((a, b) => b.order - a.order)) {
    const verdicts: FilterVerdict[] = [];
    let matched: boolean | null = true;
    for (const rf of resolveRouteFilters(route, s.filters)) {
      const f = rf.fid ? s.filters.find((x) => x.fid === rf.fid) : undefined;
      const type = f?.type ?? Object.keys(FILTER_PARAM).find((t) => rf.description.startsWith(`<${FILTER_PARAM[t].tag} `) || rf.description === `<${FILTER_PARAM[t].tag}>`) ?? '';
      const raw = f?.value ?? rf.description.replace(/^<\w+ \((?:\w+=)?(.*)\)>$/, '$1');
      // Only interval borders are comma-separated in descriptions; regexes keep their commas.
      const value = !f && (type === 'DateIntervalFilter' || type === 'TimeIntervalFilter') ? raw.replace(',', ';') : raw;
      const v = evalFilter(type, value, input, user);
      verdicts.push({ fid: rf.fid ?? '(unnamed)', description: rf.description, matched: v.matched, reason: v.reason });
      if (v.matched === false) {
        matched = false;
        break;
      }
      if (v.matched === null) matched = null;
    }
    trace.push({ order: route.order, type: route.type, connectors: route.connectors, filters: verdicts, matched });
    if (matched === true) {
      winner = route;
      break;
    }
    if (matched === null) break; // Cannot decide beyond an unevaluable route.
  }

  return {
    matched: !!winner,
    undetermined: !winner && trace.some((t) => t.matched === null),
    route: winner ? { order: winner.order, type: winner.type, rate: winner.rate, connectors: winner.connectors } : null,
    user: user ? { uid: user.uid, gid: user.gid } : null,
    trace
  };
}
