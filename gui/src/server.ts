import express from 'express';
import * as http from 'http';
import * as net from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { JCliClient } from './jasmin/jcli-client.js';
import { ConfigReader } from './jasmin/config-reader.js';
import { AmqpTap, JasminTrafficMessage } from './jasmin/amqp-tap.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

// WebSocket Servers for Telemetry and Interactive Terminal
const wssTelemetry = new WebSocketServer({ noServer: true });
const wssTerminal = new WebSocketServer({ noServer: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const configReader = new ConfigReader();
const initialConfig = configReader.getConfig();
const jcliSec = initialConfig.sections['jcli'] || {};
const httpSec = initialConfig.sections['http-api'] || {};
const amqpSec = initialConfig.sections['amqp-broker'] || {};

const JCLI_HOST = process.env.JCLI_HOST || (jcliSec['bind'] && jcliSec['bind'] !== '0.0.0.0' ? jcliSec['bind'] : '127.0.0.1');
const JCLI_PORT = parseInt(process.env.JCLI_PORT || jcliSec['port'] || '8990', 10);
const JCLI_USERNAME = process.env.JCLI_ADMIN_USERNAME || jcliSec['admin_username'] || jcliSec['admin_user'] || 'jcliadmin';
const JCLI_PASSWORD = process.env.JCLI_ADMIN_PASSWORD || 'jclipwd';
const HTTP_API_URL = process.env.HTTP_API_URL || (httpSec['port'] ? `http://127.0.0.1:${httpSec['port']}` : 'http://127.0.0.1:1401');
const PORT = parseInt(process.env.PORT || '3000', 10);

const RABBITMQ_HOST = process.env.RABBITMQ_HOST || amqpSec['host'] || '127.0.0.1';
const RABBITMQ_PORT = parseInt(process.env.RABBITMQ_PORT || amqpSec['port'] || '5672', 10);
const RABBITMQ_USER = process.env.RABBITMQ_USER || amqpSec['username'] || 'guest';
const RABBITMQ_PASS = process.env.RABBITMQ_PASS || amqpSec['password'] || 'guest';
const RABBITMQ_VHOST = process.env.RABBITMQ_VHOST || amqpSec['vhost'] || '/';

const jcli = new JCliClient({
  host: JCLI_HOST,
  port: JCLI_PORT,
  username: JCLI_USERNAME,
  password: JCLI_PASSWORD
});

// Native AMQP Real-time Traffic Tap
const amqpTap = new AmqpTap({
  host: RABBITMQ_HOST,
  port: RABBITMQ_PORT,
  username: RABBITMQ_USER,
  password: RABBITMQ_PASS,
  vhost: RABBITMQ_VHOST,
  maxBufferSize: 10000
});

// Auto-connect to jCLI
jcli.connect().then(() => {
  console.log(`[JCli] Connected to Jasmin Gateway at ${JCLI_HOST}:${JCLI_PORT}`);
}).catch(err => {
  console.error(`[JCli] Initial connection error: ${err.message}. Retrying on demand...`);
});

// Auto-connect AMQP Tap
amqpTap.start().catch(() => {});

// Broadcast to telemetry WebSocket clients
function broadcastTelemetry(data: any) {
  const msg = JSON.stringify(data);
  for (const client of wssTelemetry.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

// Push live AMQP traffic to telemetry clients
amqpTap.onMessage((trafficMsg, isUpdate) => {
  broadcastTelemetry({
    type: isUpdate ? 'TRAFFIC_UPDATE' : 'TRAFFIC_NEW',
    data: trafficMsg
  });
});

// Periodic live telemetry broadcast (every 2.5s)
setInterval(async () => {
  if (wssTelemetry.clients.size === 0) return;
  try {
    const stats = await jcli.getStats();
    broadcastTelemetry({
      type: 'STATS_UPDATE',
      data: {
        ...stats,
        trafficStats: amqpTap.getStats()
      }
    });
  } catch (err: any) {
    // Ignore transient errors
  }
}, 2500);

// --- WebSocket Upgrade Router ---
server.on('upgrade', (request, socket, head) => {
  const pathname = request.url?.split('?')[0];

  if (pathname === '/ws' || pathname === '/ws/telemetry') {
    wssTelemetry.handleUpgrade(request, socket, head, (ws) => {
      wssTelemetry.emit('connection', ws, request);
    });
  } else if (pathname === '/ws/terminal') {
    wssTerminal.handleUpgrade(request, socket, head, (ws) => {
      wssTerminal.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// --- Interactive Web jCLI Terminal Proxy ---
wssTerminal.on('connection', (ws) => {
  const tcpSocket = new net.Socket();
  let isAuthenticated = false;
  let authBuffer = '';

  tcpSocket.connect(JCLI_PORT, JCLI_HOST, () => {
    ws.send('\x1b[36m[Connecting to Jasmin jCLI Console at ' + JCLI_HOST + ':' + JCLI_PORT + '...]\x1b[0m\r\n');
  });

  tcpSocket.on('data', (data) => {
    const text = data.toString('utf-8');

    if (!isAuthenticated) {
      authBuffer += text;
      if (authBuffer.includes('Authentication required') || authBuffer.includes('Username:')) {
        tcpSocket.write(`${JCLI_USERNAME}\n`);
        authBuffer = '';
      } else if (authBuffer.includes('Password:')) {
        tcpSocket.write(`${JCLI_PASSWORD}\n`);
        authBuffer = '';
      } else if (authBuffer.includes('Welcome to Jasmin') || authBuffer.includes('jcli :')) {
        isAuthenticated = true;
        ws.send(data);
      } else if (authBuffer.includes('Incorrect') || authBuffer.includes('Authentication failed')) {
        ws.send('\r\n\x1b[31mjCLI Authentication Failed: check credentials.\x1b[0m\r\n');
        tcpSocket.destroy();
        ws.close();
      }
    } else {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  });

  tcpSocket.on('error', (err) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(`\r\n\x1b[31m[TCP Error: ${err.message}]\x1b[0m\r\n`);
      ws.close();
    }
  });

  tcpSocket.on('close', () => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send('\r\n\x1b[33m[jCLI Session Closed]\x1b[0m\r\n');
      ws.close();
    }
  });

  ws.on('message', (msg) => {
    if (isAuthenticated && !tcpSocket.destroyed) {
      tcpSocket.write(msg.toString());
    }
  });

  ws.on('close', () => {
    tcpSocket.destroy();
  });
});

// --- REST Endpoints ---

// 1. Overview & System Telemetry
app.get('/api/overview', async (req, res) => {
  try {
    const [stats, users, groups, httpConns, smppConns, moRoutes, mtRoutes] = await Promise.all([
      jcli.getStats(),
      jcli.getUsers(),
      jcli.getGroups(),
      jcli.getHttpConnectors(),
      jcli.getSmppConnectors(),
      jcli.getMoRoutes(),
      jcli.getMtRoutes()
    ]);

    res.json({
      timestamp: new Date().toISOString(),
      jcliStatus: 'CONNECTED',
      stats,
      counts: {
        users: users.length,
        groups: groups.length,
        httpConnectors: httpConns.length,
        smppConnectors: smppConns.length,
        moRoutes: moRoutes.length,
        mtRoutes: mtRoutes.length
      },
      trafficStats: amqpTap.getStats()
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message, jcliStatus: 'DISCONNECTED' });
  }
});

// 2. Configuration Explorer (jasmin.cfg)
app.get('/api/config', (req, res) => {
  res.json(configReader.getConfig());
});

// 3. User & Group Management
app.get('/api/users', async (req, res) => {
  try {
    const users = await jcli.getUsers();
    res.json(users);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users', async (req, res) => {
  const { uid, gid, username, password, balance, mtSmsQuota, throughput } = req.body;
  if (!uid || !gid || !username || !password) {
    return res.status(400).json({ error: 'uid, gid, username, and password are required' });
  }

  try {
    await jcli.createUser({
      uid,
      gid,
      username,
      password,
      balance: balance ? parseFloat(balance) : undefined,
      mtSmsQuota: mtSmsQuota ? parseInt(mtSmsQuota, 10) : undefined,
      httpThroughput: throughput ? parseInt(throughput, 10) : undefined
    });
    res.json({ success: true, uid });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/users/:uid', async (req, res) => {
  try {
    await jcli.deleteUser(req.params.uid);
    res.json({ success: true, uid: req.params.uid });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/groups', async (req, res) => {
  try {
    const groups = await jcli.getGroups();
    res.json(groups);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/groups', async (req, res) => {
  const { gid } = req.body;
  if (!gid) return res.status(400).json({ error: 'gid is required' });

  try {
    await jcli.createGroup(gid);
    res.json({ success: true, gid });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Connectors Management (HTTP & SMPP)
app.get('/api/connectors/http', async (req, res) => {
  try {
    const connectors = await jcli.getHttpConnectors();
    res.json(connectors);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/connectors/http', async (req, res) => {
  const { cid, url, method } = req.body;
  if (!cid || !url) return res.status(400).json({ error: 'cid and url are required' });

  try {
    await jcli.createHttpConnector(cid, url, method || 'POST');
    res.json({ success: true, cid });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/connectors/http/:cid', async (req, res) => {
  try {
    await jcli.deleteHttpConnector(req.params.cid);
    res.json({ success: true, cid: req.params.cid });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/connectors/smpp', async (req, res) => {
  try {
    const connectors = await jcli.getSmppConnectors();
    res.json(connectors);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/connectors/smpp', async (req, res) => {
  const { cid, host, port, username, password, systemType } = req.body;
  if (!cid || !host || !port || !username || !password) {
    return res.status(400).json({ error: 'cid, host, port, username, and password are required' });
  }

  try {
    await jcli.createSmppConnector({
      cid,
      host,
      port: parseInt(port, 10),
      username,
      password,
      systemType
    });
    res.json({ success: true, cid });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/connectors/smpp/:cid/start', async (req, res) => {
  try {
    await jcli.startSmppConnector(req.params.cid);
    res.json({ success: true, cid: req.params.cid });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/connectors/smpp/:cid/stop', async (req, res) => {
  try {
    await jcli.stopSmppConnector(req.params.cid);
    res.json({ success: true, cid: req.params.cid });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/connectors/smpp/:cid', async (req, res) => {
  try {
    await jcli.deleteSmppConnector(req.params.cid);
    res.json({ success: true, cid: req.params.cid });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Routing Engine (MO & MT)
app.get('/api/routes/mo', async (req, res) => {
  try {
    const routes = await jcli.getMoRoutes();
    res.json(routes);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/routes/mo', async (req, res) => {
  const { type, connector, order, filters } = req.body;
  if (!type || !connector) {
    return res.status(400).json({ error: 'type and connector are required' });
  }

  try {
    await jcli.createMoRoute(type, connector, order ? parseInt(order, 10) : 0, filters || []);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/routes/mo/:order', async (req, res) => {
  try {
    await jcli.deleteMoRoute(parseInt(req.params.order, 10));
    res.json({ success: true, order: req.params.order });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/routes/mt', async (req, res) => {
  try {
    const routes = await jcli.getMtRoutes();
    res.json(routes);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/routes/mt', async (req, res) => {
  const { type, rate, connector, order, filters } = req.body;
  if (!type || !connector) {
    return res.status(400).json({ error: 'type and connector are required' });
  }

  try {
    await jcli.createMtRoute(
      type,
      rate ? parseFloat(rate) : 0,
      connector,
      order ? parseInt(order, 10) : 0,
      filters || []
    );
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/routes/mt/:order', async (req, res) => {
  try {
    await jcli.deleteMtRoute(parseInt(req.params.order, 10));
    res.json({ success: true, order: req.params.order });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Update MT Route (for Node-RED style visual rewiring)
app.put('/api/routes/mt/:order', async (req, res) => {
  const currentOrder = parseInt(req.params.order, 10);
  const { type, rate, connector, filters, newOrder } = req.body;

  try {
    // Jasmin replaces routes by removing and re-adding at the given priority order
    await jcli.deleteMtRoute(currentOrder);
    await jcli.createMtRoute(
      type || 'StaticMTRoute',
      rate !== undefined ? parseFloat(rate) : 0,
      connector,
      newOrder !== undefined ? parseInt(newOrder, 10) : currentOrder,
      filters || []
    );
    res.json({ success: true, order: newOrder !== undefined ? newOrder : currentOrder });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Interactive Route Match Simulator
app.post('/api/routes/simulate', async (req, res) => {
  const { uid, source_addr, destination_addr, text } = req.body;
  if (!destination_addr) {
    return res.status(400).json({ error: 'destination_addr is required' });
  }

  try {
    const [filters, mtRoutes, users] = await Promise.all([
      jcli.getFilters(),
      jcli.getMtRoutes(),
      jcli.getUsers()
    ]);

    const user = uid ? users.find((u) => u.uid === uid) : undefined;
    const filterMap = new Map(filters.map((f) => [f.fid, f]));

    const trace: Array<{
      order: number;
      type: string;
      connector: string;
      filtersEvaluated: Array<{ fid: string; matched: boolean; reason: string }>;
      routeMatched: boolean;
    }> = [];

    let winningRoute: any = null;

    for (const route of mtRoutes) {
      let allPassed = true;
      const filtersEvaluated: Array<{ fid: string; matched: boolean; reason: string }> = [];

      for (const fid of route.filters) {
        const filter = filterMap.get(fid);
        if (!filter) {
          filtersEvaluated.push({ fid, matched: false, reason: 'Filter ID not found' });
          allPassed = false;
          break;
        }

        let matched = false;
        let reason = '';
        const typeLower = filter.type.toLowerCase();

        if (typeLower.includes('transparent')) {
          matched = true;
          reason = 'Transparent filter matches all traffic';
        } else if (typeLower.includes('user')) {
          matched = Boolean(uid && (filter.routes === uid || filter.description?.includes(uid)));
          reason = matched ? `User matches '${uid}'` : `User does not match filter '${filter.routes}'`;
        } else if (typeLower.includes('group')) {
          matched = Boolean(user && (filter.routes === user.gid || filter.description?.includes(user.gid)));
          reason = matched ? `User group '${user?.gid}' matches` : `User group does not match filter '${filter.routes}'`;
        } else if (typeLower.includes('sourceaddr')) {
          try {
            const re = new RegExp(filter.description || filter.routes || '.*');
            matched = re.test(source_addr || '');
            reason = matched ? `Regex matched sender: ${source_addr}` : `Regex did not match sender: ${source_addr}`;
          } catch (e: any) {
            matched = false;
            reason = `Invalid regex in filter: ${e.message}`;
          }
        } else if (typeLower.includes('destinationaddr')) {
          try {
            const re = new RegExp(filter.description || filter.routes || '.*');
            matched = re.test(destination_addr);
            reason = matched ? `Regex matched recipient: ${destination_addr}` : `Regex did not match recipient: ${destination_addr}`;
          } catch (e: any) {
            matched = false;
            reason = `Invalid regex in filter: ${e.message}`;
          }
        } else if (typeLower.includes('shortmessage')) {
          try {
            const re = new RegExp(filter.description || filter.routes || '.*');
            matched = re.test(text || '');
            reason = matched ? `Regex matched message body` : `Regex did not match message body`;
          } catch (e: any) {
            matched = false;
            reason = `Invalid regex in filter: ${e.message}`;
          }
        } else {
          matched = true;
          reason = `${filter.type} matched for simulation`;
        }

        filtersEvaluated.push({ fid, matched, reason });
        if (!matched) {
          allPassed = false;
          break;
        }
      }

      trace.push({
        order: route.order,
        type: route.type,
        connector: route.connector,
        filtersEvaluated,
        routeMatched: allPassed
      });

      if (allPassed && !winningRoute) {
        winningRoute = route;
      }
    }

    res.json({
      matched: Boolean(winningRoute),
      winningRoute,
      targetConnector: winningRoute ? winningRoute.connector : null,
      trace
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Filters Management
app.get('/api/filters', async (req, res) => {
  try {
    const filters = await jcli.getFilters();
    res.json(filters);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/filters', async (req, res) => {
  const { fid, type, paramKey, paramValue } = req.body;
  if (!fid || !type || !paramKey || !paramValue) {
    return res.status(400).json({ error: 'fid, type, paramKey, and paramValue are required' });
  }

  try {
    await jcli.createFilter(fid, type, paramKey, paramValue);
    res.json({ success: true, fid });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/filters/:fid', async (req, res) => {
  try {
    await jcli.deleteFilter(req.params.fid);
    res.json({ success: true, fid: req.params.fid });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/filters/validate-regex', (req, res) => {
  const { pattern, sample } = req.body;
  if (!pattern) return res.status(400).json({ error: 'pattern is required' });
  try {
    const re = new RegExp(pattern);
    const matches = sample !== undefined ? re.test(sample) : true;
    res.json({ valid: true, matches });
  } catch (err: any) {
    res.json({ valid: false, error: err.message });
  }
});

// 7. Interceptors
app.get('/api/interceptors', async (req, res) => {
  try {
    const [mt, mo] = await Promise.all([
      jcli.getMtInterceptors(),
      jcli.getMoInterceptors()
    ]);
    res.json({ mt, mo });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Real-Time AMQP Message Traffic & DLR Monitor
app.get('/api/traffic', (req, res) => {
  const limit = parseInt(req.query.limit as string, 10) || 100;
  const query = (req.query.q as string) || '';
  const status = (req.query.status as string) || '';
  res.json({
    messages: amqpTap.getMessages(limit, query, status),
    stats: amqpTap.getStats()
  });
});

app.get('/api/traffic/:msgid', (req, res) => {
  const msg = amqpTap.getMessageById(req.params.msgid);
  if (!msg) return res.status(404).json({ error: 'Message ID not found in ring buffer' });
  res.json(msg);
});

app.delete('/api/traffic', (req, res) => {
  amqpTap.clear();
  res.json({ success: true, message: 'Traffic ring buffer cleared' });
});

// 9. Test SMS Injection via Jasmin HTTP API (Port 1401)
app.post('/api/sms/send', async (req, res) => {
  const { username, password, to, content, from } = req.body;
  if (!username || !password || !to || !content) {
    return res.status(400).json({ error: 'username, password, to, and content are required' });
  }

  try {
    const params = new URLSearchParams({
      username,
      password,
      to,
      content,
      from: from || 'JASMIN'
    });

    const response = await fetch(`${HTTP_API_URL}/send?${params.toString()}`);
    const text = await response.text();

    res.json({
      status: response.status,
      response: text,
      success: response.status === 200 && text.startsWith('Success')
    });
  } catch (err: any) {
    res.status(500).json({ error: `HTTP API error: ${err.message}` });
  }
});

// 10. Gateway State Snapshot Export & Restore
app.get('/api/system/export', async (req, res) => {
  try {
    const [users, groups, httpConns, smppConns, filters, moRoutes, mtRoutes] = await Promise.all([
      jcli.getUsers(),
      jcli.getGroups(),
      jcli.getHttpConnectors(),
      jcli.getSmppConnectors(),
      jcli.getFilters(),
      jcli.getMoRoutes(),
      jcli.getMtRoutes()
    ]);

    const snapshot = {
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      gateway: {
        groups,
        users,
        httpConnectors: httpConns,
        smppConnectors: smppConns,
        filters,
        moRoutes,
        mtRoutes
      }
    };

    res.setHeader('Content-Disposition', `attachment; filename="jasmin-backup-${Date.now()}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(snapshot, null, 2));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 11. System Persistence (persist & load)
app.post('/api/system/persist', async (req, res) => {
  try {
    const result = await jcli.persist();
    res.json({ success: true, log: result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/system/load', async (req, res) => {
  try {
    const result = await jcli.load();
    res.json({ success: true, log: result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 12. Topology DAG Aggregator (Node-RED / Telecom Flow Engine)
app.get('/api/topology', async (req, res) => {
  try {
    const [users, groups, filters, moRoutes, mtRoutes, smppConns, httpConns, mtInterceptors] = await Promise.all([
      jcli.getUsers().catch(() => []),
      jcli.getGroups().catch(() => []),
      jcli.getFilters().catch(() => []),
      jcli.getMoRoutes().catch(() => []),
      jcli.getMtRoutes().catch(() => []),
      jcli.getSmppConnectors().catch(() => []),
      jcli.getHttpConnectors().catch(() => []),
      jcli.getMtInterceptors().catch(() => [])
    ]);

    const nodes: any[] = [];
    const edges: any[] = [];

    // Stage 1: Ingress Nodes
    nodes.push({
      id: 'ingress_http',
      type: 'ingress',
      stage: 1,
      label: 'HTTP REST API (:1401)',
      data: { port: 1401, protocol: 'HTTP/REST' }
    });
    nodes.push({
      id: 'ingress_smpp',
      type: 'ingress',
      stage: 1,
      label: 'SMPP Server (:2775)',
      data: { port: 2775, protocol: 'SMPP v3.4' }
    });

    // Stage 2: Users
    for (const u of users) {
      const uNodeId = `user_${u.uid}`;
      nodes.push({
        id: uNodeId,
        type: 'user',
        stage: 2,
        label: `User: ${u.username}`,
        data: u
      });
      edges.push({ id: `e_http_${u.uid}`, source: 'ingress_http', target: uNodeId });
      edges.push({ id: `e_smpp_${u.uid}`, source: 'ingress_smpp', target: uNodeId });
    }

    // Stage 3: Interceptors
    for (const ic of mtInterceptors) {
      const icNodeId = `interceptor_${ic.order}`;
      nodes.push({
        id: icNodeId,
        type: 'interceptor',
        stage: 3,
        label: `Interceptor #${ic.order}`,
        data: ic
      });
      if (ic.order === 0) {
        for (const u of users) {
          edges.push({ id: `e_u_${u.uid}_ic_${ic.order}`, source: `user_${u.uid}`, target: icNodeId });
        }
      }
    }

    // Stage 4: Filters
    for (const f of filters) {
      const fNodeId = `filter_${f.fid}`;
      nodes.push({
        id: fNodeId,
        type: 'filter',
        stage: 4,
        label: `Filter: ${f.fid}`,
        data: f
      });
    }

    // Stage 5: Routes
    for (const r of mtRoutes) {
      const rNodeId = `route_mt_${r.order}`;
      nodes.push({
        id: rNodeId,
        type: 'route',
        stage: 5,
        label: `${r.type} #${r.order}`,
        data: r
      });

      if (r.filters && r.filters.length > 0) {
        for (const fid of r.filters) {
          edges.push({ id: `e_f_${fid}_r_${r.order}`, source: `filter_${fid}`, target: rNodeId });
        }
      } else if (users.length > 0) {
        edges.push({ id: `e_def_u_${r.order}`, source: `user_${users[0].uid}`, target: rNodeId });
      }

      if (r.connector) {
        const cNodeId = `conn_smpp_${r.connector}`;
        edges.push({ id: `e_r_${r.order}_c_${r.connector}`, source: rNodeId, target: cNodeId });
      }
    }

    // Stage 6: Connectors
    for (const c of smppConns) {
      const cNodeId = `conn_smpp_${c.cid}`;
      nodes.push({
        id: cNodeId,
        type: 'connector',
        stage: 6,
        label: `smppc(${c.cid})`,
        data: c
      });
    }
    for (const c of httpConns) {
      const cNodeId = `conn_http_${c.cid}`;
      nodes.push({
        id: cNodeId,
        type: 'connector',
        stage: 6,
        label: `httpc(${c.cid})`,
        data: c
      });
    }

    res.json({
      timestamp: new Date().toISOString(),
      nodes,
      edges
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Jasmin Enterprise GUI] Web Server running at http://localhost:${PORT}`);
});
