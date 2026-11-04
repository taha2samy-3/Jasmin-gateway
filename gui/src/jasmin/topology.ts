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

/** jCLI parameter used by `filter -a` for each filter class, and the short tag shown in descriptions. */
export const FILTER_PARAM: Record<string, { key: string | null; tag: string; descKey?: string }> = {
  TransparentFilter: { key: null, tag: 'T' },
  DestinationAddrFilter: { key: 'destination_addr', tag: 'DA', descKey: 'dst_addr' },
  SourceAddrFilter: { key: 'source_addr', tag: 'SA', descKey: 'src_addr' },
  ShortMessageFilter: { key: 'short_message', tag: 'SM', descKey: 'msg' },
  UserFilter: { key: 'uid', tag: 'U', descKey: 'uid' },
  GroupFilter: { key: 'gid', tag: 'G', descKey: 'gid' },
  TagFilter: { key: 'tag', tag: 'TG', descKey: 'tag' },
  ConnectorFilter: { key: 'cid', tag: 'C', descKey: 'cid' },
  DateIntervalFilter: { key: 'dateInterval', tag: 'DI' },
  TimeIntervalFilter: { key: 'timeInterval', tag: 'TI' },
  EvalPyFilter: { key: 'pyCode', tag: 'EPF', descKey: 'pyCode' }
};

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
      add('connector', id, { cid, kind: 'smpp', missing: true });
      warnings.push(`A route uses smppc(${cid}), which no longer exists in the gateway.`);
    }
    return id;
  };

  let inlineSeq = 0;
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
    if (d.inline) {
      if (usedFilterNodes.has(n.id)) errors.push(`Route uses unnamed filter ${d.description}: open it and give it a Filter ID, type and value.`);
      continue;
    }
    const spec = FILTER_PARAM[d.type];
    if (!spec) {
      errors.push(`Filter "${d.fid}": unsupported type "${d.type}".`);
      continue;
    }
    const value = String(d.value ?? '').trim();
    const live = s.filters.find((f) => f.fid === d.fid);
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
  for (const n of graph.nodes.filter((n) => n.type === 'route')) {
    const d = n.data;
    const order = d.type === 'DefaultRoute' ? 0 : Number(d.order);
    const rate = Number(d.rate ?? 0) || 0;
    const fids = wiredFilters(graph, n.id).map((f) => f.data.fid).filter(Boolean);
    const cids = wiredConnectors(graph, n.id).map((c) => c.data.cid);
    if (cids.length === 0) {
      errors.push(`Route #${order} has no connector.`);
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
        Math.abs(live.rate - rate) < 1e-9 &&
        sameList(live.connectors.map(cidOf), cids) &&
        sameSet(liveFids, fids) &&
        !fids.some((f) => changedFilters.has(f));
      if (same) {
        unchanged++;
        continue;
      }
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
    }
  }

  // Execution order: groups, users, connectors, filters, then routes (routes reference the others).
  const rank = { group: 0, user: 1, connector: 2, filter: 3, route: 4 } as const;
  steps.sort((a, b) => rank[a.kind] - rank[b.kind]);
  return { steps, errors, unchanged };
}

/** Serializable view of a plan (functions removed). */
export function describePlan(plan: DeployPlan) {
  return {
    errors: plan.errors,
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
  tags?: number[];
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
    case 'TagFilter':
      return { matched: (input.tags ?? []).includes(Number(value)), reason: `tag ${value} ${(input.tags ?? []).includes(Number(value)) ? 'present' : 'absent'}` };
    case 'TimeIntervalFilter': {
      const [a, b] = value.split(';');
      const now = (input.at ?? new Date()).toTimeString().slice(0, 8);
      const m = !!a && !!b && now >= a && now <= b;
      return { matched: m, reason: `time ${now} ${m ? 'inside' : 'outside'} ${a}–${b}` };
    }
    case 'DateIntervalFilter': {
      const [a, b] = value.split(';');
      const today = (input.at ?? new Date()).toISOString().slice(0, 10);
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
      const value = f?.value ?? rf.description.replace(/^<\w+ \((?:\w+=)?(.*)\)>$/, '$1').replace(',', ';');
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
