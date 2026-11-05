// Shared flow-graph rules for the Jasmin routing editor.
// Pure functions only (no DOM) so the same file is used by the browser editor
// and by the Node test-suite (src/jasmin/flowgraph.test.ts).

/** Pipeline stages, left to right. */
export const NODE_TYPES = {
  ingress: { stage: 1, title: 'Ingress', color: '#81a1c1', inputs: 0, outputs: 1 },
  user: { stage: 2, title: 'User', color: '#a3be8c', inputs: 1, outputs: 1 },
  interceptor: { stage: 3, title: 'Interceptor', color: '#b48ead', inputs: 1, outputs: 1 },
  filter: { stage: 4, title: 'Filter', color: '#ebcb8b', inputs: 1, outputs: 1 },
  route: { stage: 5, title: 'MT Route', color: '#88c0d0', inputs: 1, outputs: 1 },
  connector: { stage: 6, title: 'Connector', color: '#8fbcbb', inputs: 1, outputs: 0 }
};

/** Jasmin 0.11 MT route classes (exact jCLI spelling). */
export const MT_ROUTE_TYPES = ['DefaultRoute', 'StaticMTRoute', 'RandomRoundrobinMTRoute', 'FailoverMTRoute'];

/**
 * Jasmin 0.11 filter classes usable on MT routes.
 * `key` is the jCLI parameter set during `filter -a`; `regex` marks values validated as regular expressions.
 */
export const FILTER_TYPES = {
  TransparentFilter: { key: null, regex: false, hint: 'Matches every message' },
  DestinationAddrFilter: { key: 'destination_addr', regex: true, hint: 'Regex on recipient, e.g. ^2010\\d+' },
  SourceAddrFilter: { key: 'source_addr', regex: true, hint: 'Regex on sender ID, e.g. ^BANK' },
  ShortMessageFilter: { key: 'short_message', regex: true, hint: 'Regex on message body' },
  UserFilter: { key: 'uid', regex: false, hint: 'Exact user UID' },
  GroupFilter: { key: 'gid', regex: false, hint: 'Exact group GID' },
  TagFilter: { key: 'tag', regex: false, hint: 'Integer tag', integer: true },
  DateIntervalFilter: { key: 'dateInterval', regex: false, hint: 'YYYY-MM-DD;YYYY-MM-DD' },
  TimeIntervalFilter: { key: 'timeInterval', regex: false, hint: 'HH:MM:SS;HH:MM:SS' },
  EvalPyFilter: { key: 'pyCode', regex: false, hint: 'Path to Python script' }
};

/** Edges allowed between node types (source type -> allowed target types). */
const ALLOWED_EDGES = {
  ingress: ['user'],
  user: ['interceptor', 'filter', 'route'],
  interceptor: ['filter', 'route'],
  filter: ['route'],
  route: ['connector'],
  connector: []
};

const ID_PATTERN = /^[A-Za-z0-9_-]{1,25}$/;

export function stageOf(node) {
  return NODE_TYPES[node?.type]?.stage ?? 0;
}

export function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function findNode(graph, id) {
  return graph.nodes.find((n) => n.id === id);
}

/**
 * Validate a new wire from `fromId` to `toId`.
 * @returns {{valid: boolean, reason?: string}}
 */
export function validateConnection(graph, fromId, toId) {
  const source = findNode(graph, fromId);
  const target = findNode(graph, toId);
  if (!source || !target) return { valid: false, reason: 'Unknown source or target node.' };
  if (fromId === toId) return { valid: false, reason: 'A node cannot be wired to itself.' };

  if (graph.connections.some((c) => c.from === fromId && c.to === toId)) {
    return { valid: false, reason: 'These nodes are already wired.' };
  }

  const allowed = ALLOWED_EDGES[source.type] || [];
  if (!allowed.includes(target.type)) {
    const titles = allowed.map((t) => NODE_TYPES[t].title).join(', ') || 'nothing';
    return {
      valid: false,
      reason: `${NODE_TYPES[source.type]?.title || source.type} can only feed: ${titles}.`
    };
  }

  if (source.type === 'route' && target.type === 'connector' && target.data?.kind === 'http') {
    return { valid: false, reason: 'MT routes deliver to SMPP client connectors only (HTTP connectors are for MO).' };
  }

  if (source.type === 'route') {
    const outCount = graph.connections.filter((c) => c.from === fromId).length;
    const routeType = source.data?.type;
    if ((routeType === 'DefaultRoute' || routeType === 'StaticMTRoute') && outCount >= 1) {
      return { valid: false, reason: `${routeType} sends to exactly one connector. Use Failover or RandomRoundrobin for several.` };
    }
  }

  if (source.type === 'filter' && target.type === 'route' && target.data?.type === 'DefaultRoute') {
    return { valid: false, reason: 'DefaultRoute is the catch-all and cannot have filters.' };
  }

  return { valid: true };
}

/** Ordered connector CIDs of a route, following wire order (failover priority). */
export function routeConnectors(graph, routeId) {
  const wires = graph.connections.filter((c) => c.from === routeId);
  // Legacy exports used role 'pri'/'bak'; keep primaries first.
  const rank = (c) => (c.role === 'bak' ? 1 : 0);
  return wires
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map(({ c }) => findNode(graph, c.to))
    .filter((n) => n && n.type === 'connector')
    .map((n) => n.data.cid);
}

/** FIDs of filters wired into a route. */
export function routeFilters(graph, routeId) {
  return graph.connections
    .filter((c) => c.to === routeId)
    .map((c) => findNode(graph, c.from))
    .filter((n) => n && n.type === 'filter')
    .map((n) => n.data.fid);
}

/**
 * Lint the whole graph against Jasmin's MT routing rules.
 * @returns {Array<{nodeId: string|null, level: 'error'|'warning', message: string}>}
 */
export function lintGraph(graph) {
  const issues = [];
  const push = (nodeId, level, message) => issues.push({ nodeId, level, message });

  const seenIds = new Map();
  for (const n of graph.nodes) {
    if (!NODE_TYPES[n.type]) push(n.id, 'error', `Unknown node type "${n.type}".`);
    const key = n.type === 'filter' ? `f:${n.data?.fid}` : n.type === 'connector' ? `c:${n.data?.cid}` : n.type === 'user' ? `u:${n.data?.uid}` : null;
    if (key) {
      if (seenIds.has(key)) push(n.id, 'error', `Duplicate ${n.type} id "${key.slice(2)}".`);
      seenIds.set(key, n.id);
    }
  }

  const routes = graph.nodes.filter((n) => n.type === 'route');
  const orders = new Map();
  for (const r of routes) {
    const type = r.data?.type;
    const order = Number(r.data?.order);
    const conns = routeConnectors(graph, r.id);
    const filters = routeFilters(graph, r.id);

    if (!MT_ROUTE_TYPES.includes(type)) push(r.id, 'error', `Unsupported route type "${type}".`);
    if (!Number.isInteger(order) || order < 0) push(r.id, 'error', 'Route order must be a non-negative integer.');
    if (type === 'DefaultRoute' && order !== 0) push(r.id, 'error', 'DefaultRoute must use order 0.');
    if (type !== 'DefaultRoute' && order === 0) push(r.id, 'error', 'Order 0 is reserved for DefaultRoute.');
    if (orders.has(order)) push(r.id, 'error', `Order ${order} is used by another route.`);
    orders.set(order, r.id);

    const rate = Number(r.data?.rate ?? 0);
    if (!Number.isFinite(rate) || rate < 0) push(r.id, 'error', 'Rate must be a number ≥ 0.');

    if (conns.length === 0) push(r.id, 'error', 'Route is not wired to any connector.');
    if ((type === 'DefaultRoute' || type === 'StaticMTRoute') && conns.length > 1) {
      push(r.id, 'error', `${type} accepts exactly one connector.`);
    }
    if ((type === 'FailoverMTRoute' || type === 'RandomRoundrobinMTRoute') && conns.length === 1) {
      push(r.id, 'warning', `${type} with a single connector behaves like a static route.`);
    }
    if (type === 'DefaultRoute' && filters.length > 0) push(r.id, 'error', 'DefaultRoute cannot have filters.');
    if (type !== 'DefaultRoute' && filters.length === 0) {
      push(r.id, 'error', `${type} needs at least one filter (wire a filter, or use TransparentFilter).`);
    }
  }

  for (const f of graph.nodes.filter((n) => n.type === 'filter')) {
    const spec = FILTER_TYPES[f.data?.type];
    // Inline nodes are copies held by a live route: only a problem when that route is changed (server decides).
    if (f.data?.inline) continue;
    if (!/^[A-Za-z0-9_-]{1,16}$/.test(String(f.data?.fid ?? ''))) push(f.id, 'error', 'Filter ID must be 1-16 chars: letters, digits, _ or - (Jasmin limit).');
    if (!spec) {
      push(f.id, 'error', `Unsupported filter type "${f.data?.type}".`);
      continue;
    }
    const value = String(f.data?.value ?? '').trim();
    if (spec.key && !value) push(f.id, 'error', `${f.data.type} needs a value (${spec.hint}).`);
    if (spec.regex && value) {
      try {
        new RegExp(value);
      } catch (e) {
        push(f.id, 'error', `Invalid regex: ${e.message}`);
      }
    }
    if (spec.integer && value && !/^\d+$/.test(value)) push(f.id, 'error', 'Tag must be an integer.');
    if (!graph.connections.some((c) => c.from === f.id)) push(f.id, 'warning', 'Filter is not used by any route.');
  }

  // Wires from a user straight to a route are drawn but Jasmin has no such link: it would route
  // every user's traffic, not only this user's. Say so instead of deploying something misleading.
  for (const w of graph.connections) {
    const from = graph.nodes.find((x) => x.id === w.from);
    const to = graph.nodes.find((x) => x.id === w.to);
    if (from?.type === 'user' && to?.type === 'route') {
      push(to.id, 'warning', `The wire from user ${from.data?.uid} is only visual: this route applies to all users. Add a UserFilter (uid=${from.data?.uid}) to limit it.`);
    }
  }

  for (const c of graph.nodes.filter((n) => n.type === 'connector')) {
    if (c.data?.missing) {
      push(c.id, 'warning', `smppc(${c.data.cid}) no longer exists in the gateway; routes using it cannot be changed until it is recreated.`);
      continue;
    }
    if (!/^[A-Za-z0-9_-]{3,25}$/.test(String(c.data?.cid ?? ''))) push(c.id, 'error', 'Connector ID must be 3-25 chars: letters, digits, _ or - (Jasmin limit).');
  }

  for (const u of graph.nodes.filter((n) => n.type === 'user')) {
    if (!isValidId(u.data?.uid)) push(u.id, 'error', 'User UID must be 1-25 chars: letters, digits, _ or -.');
  }

  return issues;
}

/**
 * Normalise a flow loaded from JSON (export file, older versions, API).
 * Accepts `connections` or `edges` (source/target) and drops dangling wires.
 */
export function normalizeFlow(raw) {
  const nodes = [];
  const ids = new Set();
  for (const n of Array.isArray(raw?.nodes) ? raw.nodes : []) {
    if (!n || typeof n.id !== 'string' || ids.has(n.id) || !NODE_TYPES[n.type]) continue;
    ids.add(n.id);
    const data = { ...(n.data || {}) };
    // Older flows stored the filter value as `pattern`.
    if (n.type === 'filter' && data.value === undefined && data.pattern !== undefined) data.value = data.pattern;
    if (n.type === 'connector' && !data.kind) data.kind = String(n.id).startsWith('conn_http_') ? 'http' : 'smpp';
    nodes.push({
      id: n.id,
      type: n.type,
      x: Number.isFinite(n.x) ? n.x : 100,
      y: Number.isFinite(n.y) ? n.y : 100,
      data
    });
  }
  const rawWires = Array.isArray(raw?.connections) ? raw.connections : Array.isArray(raw?.edges) ? raw.edges : [];
  const connections = [];
  for (const w of rawWires) {
    const from = w?.from ?? w?.source;
    const to = w?.to ?? w?.target;
    if (!ids.has(from) || !ids.has(to) || w?.isDlr) continue;
    if (connections.some((c) => c.from === from && c.to === to)) continue;
    const wire = { from, to };
    if (w.role === 'pri' || w.role === 'bak') wire.role = w.role;
    connections.push(wire);
  }
  return { nodes, connections };
}

/** Human label for a node. */
export function nodeLabel(node) {
  const d = node.data || {};
  switch (node.type) {
    case 'ingress':
      return d.protocol === 'smpp' ? `SMPP Server :${d.port ?? 2775}` : `HTTP API :${d.port ?? 1401}`;
    case 'user':
      return d.username ? `${d.uid} (${d.username})` : d.uid || 'user';
    case 'interceptor':
      return `Interceptor #${d.order ?? 0}`;
    case 'filter':
      return d.fid || 'filter';
    case 'route':
      return `#${d.order ?? '?'} ${String(d.type || '').replace('MTRoute', '').replace('Route', '') || 'Route'}`;
    case 'connector':
      return d.kind === 'http' ? `http(${d.cid})` : `smppc(${d.cid})`;
    default:
      return node.id;
  }
}
