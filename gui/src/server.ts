import express from 'express';
import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { JCliClient } from './jasmin/jcli-client.js';
import { ConfigReader } from './jasmin/config-reader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const configReader = new ConfigReader();
const initialConfig = configReader.getConfig();
const jcliSec = initialConfig.sections['jcli'] || {};
const httpSec = initialConfig.sections['http-api'] || {};

const JCLI_HOST = process.env.JCLI_HOST || (jcliSec['bind'] && jcliSec['bind'] !== '0.0.0.0' ? jcliSec['bind'] : '127.0.0.1');
const JCLI_PORT = parseInt(process.env.JCLI_PORT || jcliSec['port'] || '8990', 10);
const JCLI_USERNAME = process.env.JCLI_ADMIN_USERNAME || jcliSec['admin_username'] || jcliSec['admin_user'] || 'jcliadmin';
const JCLI_PASSWORD = process.env.JCLI_ADMIN_PASSWORD || 'mysecretpass';
const HTTP_API_URL = process.env.HTTP_API_URL || (httpSec['port'] ? `http://127.0.0.1:${httpSec['port']}` : 'http://127.0.0.1:1401');
const PORT = parseInt(process.env.PORT || '3000', 10);

const jcli = new JCliClient({
  host: JCLI_HOST,
  port: JCLI_PORT,
  username: JCLI_USERNAME,
  password: JCLI_PASSWORD
});

// Auto-connect on start
jcli.connect().then(() => {
  console.log(`[JCli] Connected to Jasmin Gateway at ${JCLI_HOST}:${JCLI_PORT}`);
}).catch(err => {
  console.error(`[JCli] Initial connection error: ${err.message}. Retrying on demand...`);
});

// Broadcast state to all WebSocket clients
function broadcast(data: any) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

// Periodic live telemetry broadcast (every 2.5s)
setInterval(async () => {
  if (wss.clients.size === 0) return;
  try {
    const stats = await jcli.getStats();
    broadcast({ type: 'STATS_UPDATE', data: stats });
  } catch (err: any) {
    // Ignore transient errors
  }
}, 2500);

// --- REST Endpoints ---

// 1. Overview & System Telemetry
app.get('/api/overview', async (req, res) => {
  try {
    const [users, groups, httpConnectors, smppConnectors, moRoutes, mtRoutes, filters, mtInterceptors, moInterceptors, stats] = await Promise.all([
      jcli.getUsers(),
      jcli.getGroups(),
      jcli.getHttpConnectors(),
      jcli.getSmppConnectors(),
      jcli.getMoRoutes(),
      jcli.getMtRoutes(),
      jcli.getFilters(),
      jcli.getMtInterceptors(),
      jcli.getMoInterceptors(),
      jcli.getStats()
    ]);

    res.json({
      status: 'ONLINE',
      gatewayVersion: '0.11.1',
      counts: {
        users: users.length,
        groups: groups.length,
        httpConnectors: httpConnectors.length,
        smppConnectors: smppConnectors.length,
        moRoutes: moRoutes.length,
        mtRoutes: mtRoutes.length,
        filters: filters.length,
        interceptors: mtInterceptors.length + moInterceptors.length
      },
      users,
      groups,
      httpConnectors,
      smppConnectors,
      moRoutes,
      mtRoutes,
      filters,
      mtInterceptors,
      moInterceptors,
      stats,
      configFile: configReader.getConfig().filePath
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// System Shared Configuration (jasmin.cfg reader)
app.get('/api/config', (req, res) => {
  res.json(configReader.getConfig());
});

// 2. Users Management
app.get('/api/users', async (req, res) => {
  try {
    const users = await jcli.getUsers();
    res.json(users);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users', async (req, res) => {
  const { uid, gid, username, password, balance, httpThroughput } = req.body;
  if (!uid || !gid || !username || !password) {
    return res.status(400).json({ error: 'uid, gid, username, and password are required' });
  }

  try {
    const success = await jcli.createUser({
      uid,
      gid,
      username,
      password,
      balance: balance !== undefined ? Number(balance) : undefined,
      httpThroughput: httpThroughput !== undefined ? Number(httpThroughput) : undefined
    });
    if (success) {
      broadcast({ type: 'USER_CREATED', uid });
      res.json({ success: true, message: `User ${uid} created successfully.` });
    } else {
      res.status(400).json({ error: 'Failed to create user. Check group existence or params.' });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/users/:uid', async (req, res) => {
  try {
    const success = await jcli.deleteUser(req.params.uid);
    broadcast({ type: 'USER_DELETED', uid: req.params.uid });
    res.json({ success, message: `User ${req.params.uid} removed.` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Groups Management
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
    const success = await jcli.createGroup(gid);
    res.json({ success, message: `Group ${gid} created.` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 4. HTTP & SMPP Connectors
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
    const success = await jcli.createHttpConnector(cid, url, method || 'POST');
    if (success) {
      broadcast({ type: 'CONNECTOR_CREATED', cid });
      res.json({ success: true, message: `HTTP Connector ${cid} created.` });
    } else {
      res.status(400).json({ error: 'Failed to create connector. Ensure URL is valid.' });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/connectors/http/:cid', async (req, res) => {
  const { cid } = req.params;
  try {
    const success = await jcli.deleteHttpConnector(cid);
    if (success) {
      broadcast({ type: 'CONNECTOR_DELETED', cid });
      res.json({ success: true, message: `HTTP Connector ${cid} removed.` });
    } else {
      res.status(400).json({ error: `Failed to remove HTTP connector ${cid}.` });
    }
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
  const { cid, host, port, username, password } = req.body;
  if (!cid || !host || !username || !password) {
    return res.status(400).json({ error: 'cid, host, username, and password are required' });
  }
  try {
    const success = await jcli.createSmppConnector({
      cid,
      host,
      port: port ? parseInt(port, 10) : 2775,
      username,
      password
    });
    if (success) {
      broadcast({ type: 'CONNECTOR_CREATED', cid });
      res.json({ success: true, message: `SMPP Connector ${cid} created.` });
    } else {
      res.status(400).json({ error: 'Failed to create SMPP connector.' });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/connectors/smpp/:cid/start', async (req, res) => {
  try {
    const success = await jcli.startSmppConnector(req.params.cid);
    res.json({ success, message: `SMPP Connector ${req.params.cid} started.` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/connectors/smpp/:cid/stop', async (req, res) => {
  try {
    const success = await jcli.stopSmppConnector(req.params.cid);
    res.json({ success, message: `SMPP Connector ${req.params.cid} stopped.` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/connectors/smpp/:cid', async (req, res) => {
  const { cid } = req.params;
  try {
    const success = await jcli.deleteSmppConnector(cid);
    if (success) {
      broadcast({ type: 'CONNECTOR_DELETED', cid });
      res.json({ success: true, message: `SMPP Connector ${cid} removed.` });
    } else {
      res.status(400).json({ error: `Failed to remove SMPP connector ${cid}.` });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Routes (MO & MT)
app.get('/api/routes/mo', async (req, res) => {
  try {
    const routes = await jcli.getMoRoutes();
    res.json(routes);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/routes/mo', async (req, res) => {
  const { type, connector, order } = req.body;
  if (!type || !connector) return res.status(400).json({ error: 'type and connector are required' });
  try {
    const success = await jcli.createMoRoute(type, connector, order || 0);
    if (success) {
      broadcast({ type: 'ROUTE_CREATED', connector });
      res.json({ success: true, message: `MO Route created.` });
    } else {
      res.status(400).json({ error: 'Failed to create route.' });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/routes/mo/:order', async (req, res) => {
  const order = parseInt(req.params.order, 10);
  try {
    const success = await jcli.deleteMoRoute(order);
    if (success) {
      broadcast({ type: 'ROUTE_DELETED', order });
      res.json({ success: true, message: `MO Route ${order} removed.` });
    } else {
      res.status(400).json({ error: `Failed to remove MO route ${order}.` });
    }
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
  if (!type || !connector) return res.status(400).json({ error: 'type and connector are required' });
  try {
    const success = await jcli.createMtRoute(
      type,
      rate !== undefined ? parseFloat(rate) : 0.0,
      connector,
      order || 0,
      Array.isArray(filters) ? filters : (filters ? [filters] : [])
    );
    if (success) {
      broadcast({ type: 'ROUTE_CREATED', connector });
      res.json({ success: true, message: `MT Route created.` });
    } else {
      res.status(400).json({ error: 'Failed to create MT route.' });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/routes/mt/:order', async (req, res) => {
  const order = parseInt(req.params.order, 10);
  try {
    const success = await jcli.deleteMtRoute(order);
    if (success) {
      broadcast({ type: 'ROUTE_DELETED', order });
      res.json({ success: true, message: `MT Route ${order} removed.` });
    } else {
      res.status(400).json({ error: `Failed to remove MT route ${order}.` });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Traffic Filters Management (filtersm)
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
  if (!fid || !type) return res.status(400).json({ error: 'fid and type are required' });
  try {
    const success = await jcli.createFilter(fid, type, paramKey, paramValue);
    if (success) {
      broadcast({ type: 'FILTER_CREATED', fid });
      res.json({ success: true, message: `Filter ${fid} created successfully.` });
    } else {
      res.status(400).json({ error: 'Failed to create filter.' });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/filters/:fid', async (req, res) => {
  const { fid } = req.params;
  try {
    const success = await jcli.deleteFilter(fid);
    if (success) {
      broadcast({ type: 'FILTER_DELETED', fid });
      res.json({ success: true, message: `Filter ${fid} removed.` });
    } else {
      res.status(400).json({ error: `Failed to remove filter ${fid}.` });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Interceptors Management (interceptorm)
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

// 8. Test SMS Injection via Jasmin HTTP API (Port 1401)
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

// 7. System Persistence (persist & load)
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Jasmin Enterprise GUI] Web Server running at http://localhost:${PORT}`);
});
