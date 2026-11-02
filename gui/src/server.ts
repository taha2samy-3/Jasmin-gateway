import express from 'express';
import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { JCliClient } from './jasmin/jcli-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const JCLI_HOST = process.env.JCLI_HOST || '127.0.0.1';
const JCLI_PORT = parseInt(process.env.JCLI_PORT || '8990', 10);
const JCLI_USERNAME = process.env.JCLI_ADMIN_USERNAME || 'jcliadmin';
const JCLI_PASSWORD = process.env.JCLI_ADMIN_PASSWORD || 'mysecretpass';
const HTTP_API_URL = process.env.HTTP_API_URL || 'http://127.0.0.1:1401';
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
    const [users, groups, httpConnectors, moRoutes, mtRoutes, stats] = await Promise.all([
      jcli.getUsers(),
      jcli.getGroups(),
      jcli.getHttpConnectors(),
      jcli.getMoRoutes(),
      jcli.getMtRoutes(),
      jcli.getStats()
    ]);

    res.json({
      status: 'ONLINE',
      gatewayVersion: '0.11.1',
      counts: {
        users: users.length,
        groups: groups.length,
        httpConnectors: httpConnectors.length,
        moRoutes: moRoutes.length,
        mtRoutes: mtRoutes.length
      },
      users,
      groups,
      httpConnectors,
      moRoutes,
      mtRoutes,
      stats
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
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

// 4. HTTP Connectors
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

// 5. Routes
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

// 6. Test SMS Injection via Jasmin HTTP API (Port 1401)
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
