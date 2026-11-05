import express, { NextFunction, Request, Response } from 'express';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { JCliError } from './jasmin/jcli-client.js';
import { JasminGateway } from './jasmin/gateway.js';
import { ConfigReader } from './jasmin/config-reader.js';
import { AmqpTap, JasminTrafficMessage } from './jasmin/amqp-tap.js';
import { Auth, sameOrigin } from './auth/auth.js';
import { can, ROLES, Role, UserStore } from './auth/store.js';
import {
  applyPlan,
  buildTopology,
  describePlan,
  FILTER_PARAM,
  FlowGraph,
  planDeploy,
  planFingerprint,
  resolveRouteFilters,
  simulateMtRouting
} from './jasmin/topology.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// --- Configuration ---------------------------------------------------------------------------
const configReader = new ConfigReader();
const cfg = configReader.getConfig().sections;
const sec = (name: string) => cfg[name] || {};

const env = process.env;
const JCLI_HOST = env.JCLI_HOST || (sec('jcli').bind && sec('jcli').bind !== '0.0.0.0' ? sec('jcli').bind : '127.0.0.1');
const JCLI_PORT = parseInt(env.JCLI_PORT || sec('jcli').port || '8990', 10);
const JCLI_USERNAME = env.JCLI_ADMIN_USERNAME || sec('jcli').admin_username || 'jcliadmin';
const JCLI_PASSWORD = env.JCLI_ADMIN_RAW_PASSWORD || env.JCLI_ADMIN_PASSWORD || 'jclipwd';
const HTTP_API_PORT = parseInt(sec('http-api').port || '1401', 10);
const SMPP_SERVER_PORT = parseInt(sec('smpp-server').port || '2775', 10);
const HTTP_API_URL = env.HTTP_API_URL || `http://127.0.0.1:${HTTP_API_PORT}`;
const PORT = parseInt(env.PORT || '3000', 10);
const PUBLIC_URL = (env.PUBLIC_URL || `http://localhost:${env.PORT || '3000'}`).replace(/\/$/, '');
const DATA_DIR = env.DATA_DIR || path.join(process.cwd(), 'data');
// Jasmin logs to stdout (chart: config.logToStdout): new SMPP connectors follow, instead of files.
const LOG_TO_STDOUT = env.JASMIN_LOG_TO_STDOUT === 'true';

const amqpSec = sec('amqp-broker');
const amqpTap = new AmqpTap({
  host: env.RABBITMQ_HOST || amqpSec.host || '127.0.0.1',
  port: parseInt(env.RABBITMQ_PORT || amqpSec.port || '5672', 10),
  username: env.RABBITMQ_USER || amqpSec.username || 'guest',
  password: env.RABBITMQ_PASS || env.RABBITMQ_PASSWORD || amqpSec.password || 'guest',
  vhost: env.RABBITMQ_VHOST || amqpSec.vhost || '/',
  maxBufferSize: 10000
});

const gateway = new JasminGateway({ host: JCLI_HOST, port: JCLI_PORT, username: JCLI_USERNAME, password: JCLI_PASSWORD });

// --- HTTP app --------------------------------------------------------------------------------
const app = express();
const server = http.createServer(app);
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// --- Authentication (local accounts + optional OpenID Connect) ----------------------------
if (env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : env.TRUST_PROXY);

const parseRoleMap = (raw: string | undefined) => {
  const map: Partial<Record<Role, string>> = {};
  for (const pair of (raw || '').split(',')) {
    const [role, value] = pair.split('=').map((x) => x?.trim());
    if (role && value && (ROLES as readonly string[]).includes(role)) map[role as Role] = value;
  }
  return map;
};

const mb = (v: string | undefined, fallback: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback) * 1024 * 1024;
const auth = new Auth({
  store: new UserStore(DATA_DIR, {
    retentionDays: Number(env.AUDIT_RETENTION_DAYS ?? 180),
    maxFileBytes: mb(env.AUDIT_MAX_FILE_MB, 20),
    maxTotalBytes: mb(env.AUDIT_MAX_TOTAL_MB, 500),
    stdout: env.AUDIT_STDOUT === 'true'
  }),
  persistSessions: env.SESSION_PERSIST !== 'false',
  publicUrl: PUBLIC_URL,
  bootstrapAdmin: { username: env.ADMIN_USERNAME || 'admin', password: env.ADMIN_PASSWORD || undefined },
  sessionIdleMinutes: Number(env.SESSION_IDLE_MINUTES || 60),
  sessionMaxHours: Number(env.SESSION_MAX_HOURS || 12),
  oidc:
    env.OIDC_ISSUER_URL && env.OIDC_CLIENT_ID
      ? {
          issuerUrl: env.OIDC_ISSUER_URL,
          clientId: env.OIDC_CLIENT_ID,
          clientSecret: env.OIDC_CLIENT_SECRET || undefined,
          scopes: env.OIDC_SCOPES || 'openid profile email',
          displayName: env.OIDC_DISPLAY_NAME || 'Single sign-on',
          roleClaim: env.OIDC_ROLE_CLAIM || 'roles',
          roleMap: parseRoleMap(env.OIDC_ROLE_MAP)
        }
      : undefined
});
auth.bootstrap();

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.use(auth.authenticate);
auth.mount(app);

// Pages and assets reachable without a session (the sign-in page and what it needs).
const PUBLIC_PATHS = [/^\/login(\.html)?$/, /^\/css\//, /^\/fonts\//, /^\/assets\//, /^\/js\/(login|lib)\.js$/, /^\/favicon/];
app.use((req, res, next) => {
  if (PUBLIC_PATHS.some((re) => re.test(req.path))) return next();
  if (req.path.startsWith('/api/')) return req.user ? next() : res.status(401).json({ error: 'Sign in required' });
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  if (req.user.status === 'pending') return res.redirect('/login?pending=1');
  next();
});
app.use('/api', auth.csrf);

const read = auth.require('gateway:read');
const write = auth.require('gateway:write');

app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));
// Front-end libraries are served from node_modules so the console works without internet access.
const vendor: Record<string, string> = {
  'chart.umd.js': 'chart.js/dist/chart.umd.js',
  'xterm.js': '@xterm/xterm/lib/xterm.js',
  'xterm.css': '@xterm/xterm/css/xterm.css',
  'addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js'
};
app.get('/vendor/:file', (req, res) => {
  const rel = vendor[req.params.file];
  if (!rel) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(ROOT, 'node_modules', rel));
});

const ID_RE = /^[A-Za-z0-9_-]{1,25}$/;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const requireId = (value: unknown, field: string) => {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new HttpError(400, `${field} must be 1-25 characters: letters, digits, _ or -`);
  return value;
};
const requireText = (value: unknown, field: string) => {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${field} is required`);
  if (/[\r\n]/.test(value)) throw new HttpError(400, `${field} must be a single line`);
  return value.trim();
};
const optionalNumber = (value: unknown, field: string) => {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${field} must be a number ≥ 0`);
  return n;
};

type Handler = (req: Request, res: Response) => Promise<unknown>;
const route = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch((err: any) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err instanceof JCliError) return res.status(422).json({ error: err.message, detail: err.output });
    if (/ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|timed out|connection closed|authentication failed/i.test(err?.message || '')) {
      return res.status(503).json({ error: `Jasmin jCLI unavailable: ${err.message}`, offline: true });
    }
    next(err);
  });
};

/** Run a change and reply with a uniform payload. */
const change = async (req: Request, res: Response, message: string, fn: Parameters<JasminGateway['mutate']>[0]) => {
  try {
    await gateway.mutate(fn);
  } catch (err: any) {
    auth.audit(req, 'gateway-change-failed', `${req.method} ${req.path}`, { error: err.message });
    throw err;
  }
  auth.audit(req, 'gateway-change', `${req.method} ${req.path}`, { message });
  res.json({ success: true, message });
};

/** Viewers may monitor traffic but not read message bodies (personal data). */
const maskTraffic = (m: JasminTrafficMessage, role: Role | null | undefined): JasminTrafficMessage =>
  can(role, 'traffic:content') ? m : { ...m, shortMessage: m.shortMessage ? `•••• (${m.shortMessage.length} chars)` : '', rawPdu: undefined };

// --- Status & state --------------------------------------------------------------------------
app.get(
  '/api/status', read,
  route(async (_req, res) => {
    const reachable = await gateway.ping();
    res.json({
      jcli: { connected: reachable, host: JCLI_HOST, port: JCLI_PORT, error: reachable ? null : gateway.lastError },
      amqp: { connected: amqpTap.connected, error: amqpTap.lastError },
      jasminVersion: gateway.version,
      httpApi: HTTP_API_URL,
      ports: { http: HTTP_API_PORT, smpp: SMPP_SERVER_PORT },
      oidc: auth.oidcEnabled
    });
  })
);

app.get(
  '/api/state', read,
  route(async (req, res) => {
    const s = await gateway.snapshot(req.query.fresh === '1');
    res.json({
      ...s,
      mtRoutes: s.mtRoutes.map((r) => ({ ...r, filterRefs: resolveRouteFilters(r, s.filters) })),
      traffic: amqpTap.getStats()
    });
  })
);

app.get('/api/config', read, (_req, res) => {
  const c = configReader.getConfig();
  // Never expose secrets: drop password-like keys from the structured view.
  const sections: Record<string, Record<string, string>> = {};
  for (const [name, values] of Object.entries(c.sections)) {
    sections[name] = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, /pass|secret|token/i.test(k) ? '••••••' : v]));
  }
  res.json({ filePath: c.filePath, exists: c.exists, sections });
});

// --- Groups & users --------------------------------------------------------------------------
app.post(
  '/api/groups', write,
  route(async (req, res) => {
    const gid = requireId(req.body.gid, 'Group ID');
    const s = await gateway.snapshot(true);
    if (s.groups.some((g) => g.gid === gid)) throw new HttpError(409, `Group ${gid} already exists`);
    await change(req, res, `Group ${gid} created`, (c) => c.createGroup(gid));
  })
);

app.delete(
  '/api/groups/:gid', write,
  route(async (req, res) => {
    const gid = requireId(req.params.gid, 'Group ID');
    const s = await gateway.snapshot(true);
    const members = s.users.filter((u) => u.gid === gid);
    if (members.length && req.query.force !== '1') {
      throw new HttpError(409, `Group ${gid} still has ${members.length} user(s): ${members.map((u) => u.uid).join(', ')}. Jasmin would delete them too.`);
    }
    await change(req, res, `Group ${gid} removed`, (c) => c.deleteGroup(gid));
  })
);

app.post(
  '/api/users', write,
  route(async (req, res) => {
    const uid = requireId(req.body.uid, 'User ID');
    const gid = requireId(req.body.gid, 'Group ID');
    const username = requireId(req.body.username, 'Username');
    const password = requireText(req.body.password, 'Password');
    const balance = optionalNumber(req.body.balance, 'Balance');
    const mtSmsQuota = optionalNumber(req.body.mtSmsQuota, 'SMS quota');
    const httpThroughput = optionalNumber(req.body.throughput, 'Throughput');
    const s = await gateway.snapshot(true);
    // jCLI silently overwrites an existing UID, so refuse explicitly.
    if (s.users.some((u) => u.uid === uid)) throw new HttpError(409, `User ${uid} already exists`);
    if (!s.groups.some((g) => g.gid === gid)) throw new HttpError(400, `Group ${gid} does not exist; create it first`);
    await change(req, res, `User ${uid} created`, (c) => c.createUser({ uid, gid, username, password, balance, mtSmsQuota, httpThroughput }));
  })
);

app.patch(
  '/api/users/:uid', write,
  route(async (req, res) => {
    const uid = requireId(req.params.uid, 'User ID');
    const updates: string[] = [];
    const balance = optionalNumber(req.body.balance, 'Balance');
    const quota = optionalNumber(req.body.mtSmsQuota, 'SMS quota');
    const throughput = optionalNumber(req.body.throughput, 'Throughput');
    if (balance !== undefined) updates.push(`mt_messaging_cred quota balance ${balance}`);
    if (quota !== undefined) updates.push(`mt_messaging_cred quota sms_count ${quota}`);
    if (throughput !== undefined) updates.push(`mt_messaging_cred quota http_throughput ${throughput}`);
    if (req.body.password) updates.push(`password ${requireText(req.body.password, 'Password')}`);
    if (!updates.length) throw new HttpError(400, 'Nothing to update');
    await change(req, res, `User ${uid} updated`, (c) => c.updateUser(uid, updates));
  })
);

app.delete(
  '/api/users/:uid', write,
  route(async (req, res) => {
    const uid = requireId(req.params.uid, 'User ID');
    await change(req, res, `User ${uid} removed`, (c) => c.deleteUser(uid));
  })
);

// --- Connectors ------------------------------------------------------------------------------
app.post(
  '/api/connectors/http', write,
  route(async (req, res) => {
    const cid = requireId(req.body.cid, 'Connector ID');
    const url = requireText(req.body.url, 'URL');
    if (!/^https?:\/\/\S+$/i.test(url)) throw new HttpError(400, 'URL must start with http:// or https://');
    const method = String(req.body.method || 'POST').toUpperCase();
    if (!['GET', 'POST'].includes(method)) throw new HttpError(400, 'Method must be GET or POST');
    await change(req, res, `HTTP connector ${cid} created`, (c) => c.createHttpConnector(cid, url, method));
  })
);

app.delete(
  '/api/connectors/http/:cid', write,
  route(async (req, res) => {
    const cid = requireId(req.params.cid, 'Connector ID');
    const s = await gateway.snapshot(true);
    const users = s.moRoutes.filter((r) => r.connectors.includes(`http(${cid})`));
    if (users.length && req.query.force !== '1') {
      throw new HttpError(409, `http(${cid}) is used by MO route(s) ${users.map((r) => '#' + r.order).join(', ')}`);
    }
    await change(req, res, `HTTP connector ${cid} removed`, (c) => c.deleteHttpConnector(cid));
  })
);

app.post(
  '/api/connectors/smpp', write,
  route(async (req, res) => {
    const cid = requireId(req.body.cid, 'Connector ID');
    const host = requireText(req.body.host, 'Host');
    const port = optionalNumber(req.body.port, 'Port');
    if (!port || port > 65535) throw new HttpError(400, 'Port must be 1-65535');
    const username = requireText(req.body.username, 'System ID');
    const password = requireText(req.body.password, 'Password');
    const s = await gateway.snapshot(true);
    if (s.smppConnectors.some((c) => c.cid === cid)) throw new HttpError(409, `Connector ${cid} already exists`);
    await change(req, res, `SMPP connector ${cid} created`, (c) =>
      c.createSmppConnector({ cid, host, port, username, password, systemType: req.body.systemType || undefined, logFile: LOG_TO_STDOUT ? '/dev/stdout' : undefined })
    );
  })
);

app.post(
  '/api/connectors/smpp/:cid/:action(start|stop)', write,
  route(async (req, res) => {
    const cid = requireId(req.params.cid, 'Connector ID');
    const start = req.params.action === 'start';
    await change(req, res, `Connector ${cid} ${start ? 'started' : 'stopped'}`, (c) => (start ? c.startSmppConnector(cid) : c.stopSmppConnector(cid)));
  })
);

app.delete(
  '/api/connectors/smpp/:cid', write,
  route(async (req, res) => {
    const cid = requireId(req.params.cid, 'Connector ID');
    const s = await gateway.snapshot(true);
    const routes = s.mtRoutes.filter((r) => r.connectors.includes(`smppc(${cid})`));
    // Jasmin removes the connector anyway and leaves routes pointing at nothing.
    if (routes.length && req.query.force !== '1') {
      throw new HttpError(409, `smppc(${cid}) is used by MT route(s) ${routes.map((r) => '#' + r.order).join(', ')}. Remove or rewire them first.`);
    }
    await change(req, res, `SMPP connector ${cid} removed`, (c) => c.deleteSmppConnector(cid));
  })
);

// --- Filters & routes ------------------------------------------------------------------------
app.post(
  '/api/filters', write,
  route(async (req, res) => {
    const fid = requireId(req.body.fid, 'Filter ID');
    const type = String(req.body.type || '');
    const spec = FILTER_PARAM[type];
    if (!spec) throw new HttpError(400, `Unsupported filter type ${type}`);
    const value = spec.key ? requireText(req.body.value, 'Filter value') : '';
    const s = await gateway.snapshot(true);
    if (s.filters.some((f) => f.fid === fid)) throw new HttpError(409, `Filter ${fid} already exists`);
    await change(req, res, `Filter ${fid} created`, (c) => c.createFilter(fid, type, spec.key, value));
  })
);

app.delete(
  '/api/filters/:fid', write,
  route(async (req, res) => {
    const fid = requireId(req.params.fid, 'Filter ID');
    await change(req, res, `Filter ${fid} removed`, (c) => c.deleteFilter(fid));
  })
);

const requireOrder = (value: unknown) => {
  const order = Number(value);
  if (!Number.isInteger(order) || order < 0) throw new HttpError(400, 'Route order must be an integer ≥ 0');
  return order;
};

const parseList = (v: unknown) =>
  (Array.isArray(v) ? v : String(v ?? '').split(/[;,]/)).map((x) => String(x).trim()).filter(Boolean);

app.post(
  '/api/routes/mt', write,
  route(async (req, res) => {
    const type = String(req.body.type || '');
    if (!['DefaultRoute', 'StaticMTRoute', 'RandomRoundrobinMTRoute', 'FailoverMTRoute'].includes(type)) throw new HttpError(400, `Unsupported MT route type ${type}`);
    const order = type === 'DefaultRoute' ? 0 : Number(req.body.order);
    if (type !== 'DefaultRoute' && (!Number.isInteger(order) || order < 1)) throw new HttpError(400, 'Order must be an integer ≥ 1 (0 is reserved for DefaultRoute)');
    const rate = optionalNumber(req.body.rate, 'Rate') ?? 0;
    const connectors = parseList(req.body.connectors ?? req.body.connector);
    const filters = parseList(req.body.filters);
    if (!connectors.length) throw new HttpError(400, 'At least one connector is required');
    if (type !== 'DefaultRoute' && !filters.length) throw new HttpError(400, `${type} requires at least one filter`);
    const s = await gateway.snapshot(true);
    if (s.mtRoutes.some((r) => r.order === order) && req.query.replace !== '1') throw new HttpError(409, `MT route #${order} already exists`);
    await change(req, res, `MT route #${order} saved`, (c) => c.createMtRoute(type, rate, connectors, order, filters));
  })
);

app.delete(
  '/api/routes/mt/:order', write,
  route(async (req, res) => {
    const order = requireOrder(req.params.order);
    await change(req, res, `MT route #${order} removed`, (c) => c.deleteMtRoute(order));
  })
);

app.post(
  '/api/routes/mo', write,
  route(async (req, res) => {
    const type = String(req.body.type || '');
    if (!['DefaultRoute', 'StaticMORoute', 'RandomRoundrobinMORoute', 'FailoverMORoute'].includes(type)) throw new HttpError(400, `Unsupported MO route type ${type}`);
    const order = type === 'DefaultRoute' ? 0 : Number(req.body.order);
    if (type !== 'DefaultRoute' && (!Number.isInteger(order) || order < 1)) throw new HttpError(400, 'Order must be an integer ≥ 1');
    const connectors = parseList(req.body.connectors ?? req.body.connector);
    const filters = parseList(req.body.filters);
    if (!connectors.length) throw new HttpError(400, 'At least one connector is required');
    if (type !== 'DefaultRoute' && !filters.length) throw new HttpError(400, `${type} requires at least one filter`);
    const s = await gateway.snapshot(true);
    if (s.moRoutes.some((r) => r.order === order) && req.query.replace !== '1') throw new HttpError(409, `MO route #${order} already exists`);
    await change(req, res, `MO route #${order} saved`, (c) => c.createMoRoute(type, connectors, order, filters));
  })
);

app.delete(
  '/api/routes/mo/:order', write,
  route(async (req, res) => {
    const order = requireOrder(req.params.order);
    await change(req, res, `MO route #${order} removed`, (c) => c.deleteMoRoute(order));
  })
);

app.post(
  '/api/routes/simulate', read,
  route(async (req, res) => {
    const destination = requireText(req.body.destination_addr, 'Recipient');
    // Jasmin compares tags as strings ("05" and "5" are different tags).
    const tags = parseList(req.body.tags);
    const s = await gateway.snapshot();
    res.json(
      simulateMtRouting(s, {
        uid: req.body.uid || undefined,
        source_addr: req.body.source_addr || '',
        destination_addr: destination,
        text: req.body.text || '',
        tags
      })
    );
  })
);

// --- Flow editor -----------------------------------------------------------------------------
app.get(
  '/api/topology', read,
  route(async (_req, res) => {
    const s = await gateway.snapshot(true);
    res.json({ fetchedAt: s.fetchedAt, ...buildTopology(s, { httpPort: HTTP_API_PORT, smppPort: SMPP_SERVER_PORT }) });
  })
);

const readGraph = (body: any): FlowGraph => {
  if (!body || !Array.isArray(body.nodes) || !Array.isArray(body.connections)) throw new HttpError(400, 'Body must contain nodes[] and connections[]');
  return { nodes: body.nodes, connections: body.connections };
};

app.post(
  '/api/topology/plan', read,
  route(async (req, res) => {
    const s = await gateway.snapshot(true);
    res.json({ fetchedAt: s.fetchedAt, ...describePlan(planDeploy(readGraph(req.body), s, { prune: req.body.prune !== false })) });
  })
);

app.post(
  '/api/topology/deploy', write,
  route(async (req, res) => {
    const graph = readGraph(req.body);
    const s = await gateway.snapshot(true);
    const plan = planDeploy(graph, s, { prune: req.body.prune !== false });
    if (plan.errors.length) return res.status(400).json({ error: 'The flow has problems that must be fixed before deploying', errors: plan.errors });
    // Deploy exactly what was reviewed: if the gateway changed since the review (another user,
    // the jCLI terminal, a stale editor tab), the recomputed plan differs and nothing is applied.
    const fingerprint = planFingerprint(plan);
    if (req.body.fingerprint !== fingerprint) {
      auth.audit(req, 'flow-deploy-refused', 'plan changed since review', { reviewed: req.body.fingerprint ?? null, current: fingerprint });
      return res.status(409).json({
        error: req.body.fingerprint ? 'The gateway changed since you reviewed this deployment. Review the updated plan.' : 'Review the deployment plan first.',
        stale: true,
        plan: { fetchedAt: s.fetchedAt, ...describePlan(plan) }
      });
    }
    if (!plan.steps.length) return res.json({ success: true, applied: [], message: 'Nothing to deploy: the gateway already matches the flow' });
    try {
      const { result } = await gateway.mutate((c) => applyPlan(c, plan));
      auth.audit(req, 'flow-deployed', `${result.length} change(s)`, { fingerprint, applied: result.map((r) => `${r.action} ${r.kind} ${r.id}: ${r.summary}`) });
      res.json({ success: true, applied: result, message: `Deployed ${result.length} change(s) and persisted` });
    } catch (err: any) {
      auth.audit(req, 'flow-deploy-failed', undefined, { error: err.message });
      res.status(422).json({ error: err.message, applied: err.done ?? [] });
    }
  })
);

// --- Traffic, SMS & system -------------------------------------------------------------------
app.get('/api/traffic', auth.require('traffic:read'), (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit), 10) || 200, 2000);
  const messages = amqpTap.getMessages(limit, String(req.query.q || ''), String(req.query.status || '')).map((m) => maskTraffic(m, req.user?.role));
  res.json({ messages, stats: amqpTap.getStats(), connected: amqpTap.connected });
});

app.get('/api/traffic/:msgid', auth.require('traffic:read'), (req, res) => {
  const msg = amqpTap.getMessageById(req.params.msgid);
  if (!msg) return res.status(404).json({ error: 'Message not found in the live buffer' });
  res.json(maskTraffic(msg, req.user?.role));
});

app.delete('/api/traffic', write, (req, res) => {
  const cleared = amqpTap.getStats();
  amqpTap.clear();
  auth.audit(req, 'traffic-buffer-cleared', undefined, { stats: cleared });
  res.json({ success: true });
});

app.post(
  '/api/sms/send', auth.require('sms:send'),
  route(async (req, res) => {
    const username = requireText(req.body.username, 'Username');
    const password = requireText(req.body.password, 'Password');
    const to = requireText(req.body.to, 'Recipient');
    const content = String(req.body.content ?? '');
    if (!content) throw new HttpError(400, 'Message content is required');
    const params = new URLSearchParams({ username, password, to, content });
    if (req.body.from) params.set('from', String(req.body.from));
    if (req.body.dlr) {
      params.set('dlr', 'yes');
      params.set('dlr-level', '3');
      params.set('dlr-url', String(req.body.dlrUrl || 'http://127.0.0.1/'));
    }
    let response: globalThis.Response;
    try {
      response = await fetch(`${HTTP_API_URL}/send`, { method: 'POST', body: params, signal: AbortSignal.timeout(10000) });
    } catch (err: any) {
      throw new HttpError(503, `Jasmin HTTP API (${HTTP_API_URL}) unreachable: ${err.message}`);
    }
    const text = (await response.text()).trim();
    const id = /^Success "([^"]+)"/.exec(text)?.[1];
    res.json({ success: response.ok && !!id, status: response.status, response: text, messageId: id ?? null });
  })
);

app.get(
  '/api/system/export', read,
  route(async (_req, res) => {
    const s = await gateway.snapshot(true);
    const { stats, fetchedAt, ...config } = s;
    res.setHeader('Content-Disposition', `attachment; filename="jasmin-snapshot-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.json"`);
    res.json({ format: 'jasmin-console-snapshot/1', jasminVersion: gateway.version, exportedAt: new Date().toISOString(), gateway: config });
  })
);

app.post(
  '/api/system/persist', write,
  route(async (req, res) => {
    const { persisted } = await gateway.mutate(async () => undefined);
    auth.audit(req, 'gateway-persisted');
    res.json({ success: true, log: persisted });
  })
);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API endpoint' }));
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[api]', err);
  res.status(500).json({ error: err?.message || 'Internal error' });
});

// --- WebSockets ------------------------------------------------------------------------------
const wssTelemetry = new WebSocketServer({ noServer: true });
const wssTerminal = new WebSocketServer({ noServer: true });

const wsUser = new WeakMap<WebSocket, { username: string; role: Role | null }>();

server.on('upgrade', (req, socket, head) => {
  const reject = (code: string) => {
    socket.write(`HTTP/1.1 ${code}\r\n\r\n`);
    socket.destroy();
  };
  // Browsers always send Origin on WebSocket handshakes: refuse cross-site hijacking attempts.
  if (!sameOrigin(req.headers.origin, req.headers.host)) return reject('403 Forbidden');
  const session = auth.resolve(req.headers.cookie);
  if (!session || session.user.status !== 'active') return reject('401 Unauthorized');
  const pathname = (req.url || '').split('?')[0];
  const target = pathname === '/ws/telemetry' ? wssTelemetry : pathname === '/ws/terminal' ? wssTerminal : null;
  if (!target) return reject('404 Not Found');
  const needed = target === wssTerminal ? 'terminal:use' : 'gateway:read';
  if (!can(session.user.role, needed) || (target === wssTerminal && session.user.mustChangePassword)) return reject('403 Forbidden');
  target.handleUpgrade(req, socket, head, (ws) => {
    wsUser.set(ws, { username: session.user.username, role: session.user.role });
    target.emit('connection', ws, req);
  });
});

function broadcast(payload: unknown) {
  const msg = JSON.stringify(payload);
  for (const client of wssTelemetry.clients) if (client.readyState === WebSocket.OPEN) client.send(msg);
}

amqpTap.onMessage((message, isUpdate) => {
  const type = isUpdate ? 'traffic:update' : 'traffic:new';
  for (const client of wssTelemetry.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    client.send(JSON.stringify({ type, data: maskTraffic(message, wsUser.get(client)?.role) }));
  }
});

let telemetryBusy = false;
setInterval(async () => {
  if (wssTelemetry.clients.size === 0 || telemetryBusy) return;
  telemetryBusy = true;
  try {
    const stats = await gateway.stats();
    broadcast({ type: 'stats', at: Date.now(), data: { ...stats, traffic: amqpTap.getStats() } });
    broadcast({ type: 'status', data: { jcli: true, amqp: amqpTap.connected, version: gateway.version } });
  } catch (err: any) {
    broadcast({ type: 'status', data: { jcli: false, amqp: amqpTap.connected, version: gateway.version, error: err.message } });
  } finally {
    telemetryBusy = false;
  }
}, 2500);

/**
 * Web terminal: bridges xterm.js to a dedicated jCLI telnet session.
 * Frames are JSON: client -> {t:'input', d} ; server -> {t:'data', d} | {t:'status', state, ...}.
 */
wssTerminal.on('connection', (ws, req: http.IncomingMessage) => {
  const who = wsUser.get(ws)?.username ?? 'unknown';
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  auth.store.audit({ actor: who, action: 'terminal-opened', ip });
  let line = '';
  let lineEdited = false;
  const tcp = new net.Socket();
  let ready = false;
  let buf = '';
  const send = (obj: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(obj));

  send({ t: 'status', state: 'connecting', host: JCLI_HOST, port: JCLI_PORT });
  tcp.setTimeout(10000);
  tcp.connect(JCLI_PORT, JCLI_HOST);

  tcp.on('data', (chunk) => {
    // jCLI ends lines with "\r\r\r\n" and pads table rows with trailing spaces wider than the
    // terminal (which then wrap into blank lines): normalise to CRLF without trailing blanks.
    const text = chunk.toString('utf8').replace(/[ \t]*\r+\n/g, '\r\n');
    if (ready) return send({ t: 'data', d: text });
    buf += text;
    if (/Incorrect|Authentication failed/i.test(buf)) {
      send({ t: 'status', state: 'error', message: 'jCLI rejected the console credentials (JCLI_ADMIN_USERNAME / password).' });
      tcp.destroy();
    } else if (/Authentication required|Username:\s*$/.test(buf) && !/Password:/.test(buf)) {
      buf = buf.replace(/Authentication required\.?/, '');
      tcp.write(`${JCLI_USERNAME}\r\n`);
    } else if (/Password:\s*$/.test(buf)) {
      buf = '';
      tcp.write(`${JCLI_PASSWORD}\r\n`);
    } else if (/jcli : $/.test(buf)) {
      ready = true;
      tcp.setTimeout(0);
      const version = buf.match(/Welcome to Jasmin ([\w.\-]+)/)?.[1] ?? null;
      const session = buf.match(/Session ref: (\d+)/)?.[1] ?? null;
      send({ t: 'status', state: 'ready', version, session, host: JCLI_HOST, port: JCLI_PORT });
      // Show the banner without the login noise.
      const banner = buf.slice(Math.max(0, buf.indexOf('Welcome to Jasmin'))).replace(/\r+\n/g, '\r\n');
      send({ t: 'data', d: banner });
      buf = '';
    }
  });

  tcp.on('timeout', () => {
    send({ t: 'status', state: 'error', message: `No answer from jCLI at ${JCLI_HOST}:${JCLI_PORT}` });
    tcp.destroy();
  });
  tcp.on('error', (err) => send({ t: 'status', state: 'error', message: `Cannot reach jCLI at ${JCLI_HOST}:${JCLI_PORT} (${err.message})` }));
  tcp.on('close', () => {
    send({ t: 'status', state: 'closed' });
    if (ws.readyState === WebSocket.OPEN) ws.close();
  });

  ws.on('message', (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg?.t === 'input' && ready && typeof msg.d === 'string' && !tcp.destroyed) {
      tcp.write(msg.d);
      // Audit each submitted command line; secrets typed into jCLI are redacted. Escape sequences
      // (arrow keys, history recall) and TAB completion edit the line inside jCLI, so the exact
      // command cannot be rebuilt from the keystrokes: such lines are flagged instead of guessed.
      const input = msg.d.replace(/\x1b(?:\[[0-9;?]*[ -\/]*[@-~]|O.|[@-Z\\-_])/g, () => {
        lineEdited = true;
        return '';
      });
      for (const ch of input) {
        if (ch === '\r' || ch === '\n') {
          const cmd = line.trim();
          if (cmd || lineEdited) {
            const secret = /^(password|\S*_password|\S*pass(word|wd)?)\b/i.test(cmd);
            auth.store.audit({
              actor: who,
              action: 'terminal-command',
              target: secret ? cmd.split(/\s+/)[0] + ' ••••' : cmd,
              ...(lineEdited ? { detail: { edited: 'arrow keys / history / completion used: the line sent may differ from target' } } : {}),
              ip
            });
          }
          line = '';
          lineEdited = false;
        } else if (ch === '\x7f' || ch === '\b') line = line.slice(0, -1);
        else if (ch === '\t') lineEdited = true;
        else if (ch === '\x15') line = '';
        else if (ch >= ' ') line += ch;
      }
    }
  });
  ws.on('close', () => {
    tcp.destroy();
    auth.store.audit({ actor: who, action: 'terminal-closed', ip });
  });
});

// --- Start -----------------------------------------------------------------------------------
amqpTap.start();
gateway.ping().then((ok) =>
  console.log(ok ? `[jcli] Connected to Jasmin ${gateway.version ?? ''} at ${JCLI_HOST}:${JCLI_PORT}` : `[jcli] ${JCLI_HOST}:${JCLI_PORT} unreachable (${gateway.lastError}); retrying on demand`)
);

server.listen(PORT, '0.0.0.0', () => console.log(`[console] Listening on http://0.0.0.0:${PORT}`));

const shutdown = () => {
  auth.close();
  amqpTap.stop();
  gateway.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
