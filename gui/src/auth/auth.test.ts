import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import express from 'express';
import { Auth, Limiter, sameOrigin } from './auth.js';
import { can, hashPassword, UserStore, verifyPassword } from './store.js';

describe('password hashing and RBAC table', () => {
  test('scrypt hashes verify and are salted', () => {
    const a = hashPassword('correct horse battery');
    const b = hashPassword('correct horse battery');
    assert.notEqual(a, b);
    assert.ok(verifyPassword('correct horse battery', a));
    assert.ok(!verifyPassword('wrong', a));
  });
  test('roles grant the documented permissions', () => {
    assert.ok(can('viewer', 'gateway:read') && !can('viewer', 'gateway:write') && !can('viewer', 'traffic:content'));
    assert.ok(can('operator', 'gateway:write') && can('operator', 'terminal:use') && !can('operator', 'console:admin'));
    assert.ok(can('admin', 'console:admin'));
    assert.ok(!can(null, 'gateway:read'));
  });
});

describe('Auth over HTTP', () => {
  let dir: string;
  let server: http.Server;
  let base: string;
  let auth: Auth;
  const ADMIN_PW = 'Initial-Admin-Pass';

  /** Minimal cookie-aware client. */
  const client = () => {
    let cookie = '';
    return async (method: string, url: string, body?: unknown, headers: Record<string, string> = { 'X-Requested-With': 'jasmin-console' }) => {
      const res = await fetch(base + url, {
        method,
        redirect: 'manual',
        headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, body: await res.json().catch(() => null) };
    };
  };

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-auth-'));
    auth = new Auth({
      store: new UserStore(dir),
      publicUrl: 'http://127.0.0.1',
      bootstrapAdmin: { username: 'admin', password: ADMIN_PW },
      sessionIdleMinutes: 60,
      sessionMaxHours: 12,
      oidc: { issuerUrl: 'http://127.0.0.1:1/none', clientId: 'x', scopes: 'openid', displayName: 'SSO', roleClaim: 'roles', roleMap: { admin: 'App.Admin', operator: 'App.Operator' } }
    });
    auth.bootstrap();
    const app = express();
    app.use(auth.authenticate);
    auth.mount(app);
    app.use('/api', auth.csrf);
    app.get('/api/read', auth.require('gateway:read'), (_req, res) => res.json({ ok: true }));
    app.post('/api/write', express.json(), auth.require('gateway:write'), (_req, res) => res.json({ ok: true }));
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('bootstrap creates exactly one admin and is idempotent', () => {
    auth.bootstrap();
    assert.equal(auth.store.list().filter((u) => u.role === 'admin').length, 1);
  });

  test('login, session cookie, and permissions', async () => {
    const c = client();
    assert.equal((await c('GET', '/api/read')).status, 401);
    assert.equal((await c('POST', '/auth/login', { username: 'admin', password: 'nope' })).status, 401);
    const ok = await c('POST', '/auth/login', { username: 'admin', password: ADMIN_PW });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.passwordHash, undefined, 'hash never leaves the server');
    assert.equal((await c('GET', '/api/read')).status, 200);
    assert.equal((await c('POST', '/api/write', {})).status, 200);
  });

  test('state-changing requests need the anti-CSRF header', async () => {
    const c = client();
    await c('POST', '/auth/login', { username: 'admin', password: ADMIN_PW });
    assert.equal((await c('POST', '/api/write', {}, {})).status, 403);
  });

  test('admin workflow: create viewer, viewer is read-only, last admin is protected', async () => {
    const admin = client();
    await admin('POST', '/auth/login', { username: 'admin', password: ADMIN_PW });
    assert.equal((await admin('POST', '/api/admin/users', { username: 'viewer1', role: 'viewer', password: 'short' })).status, 400);
    const created = await admin('POST', '/api/admin/users', { username: 'viewer1', role: 'viewer', password: 'Viewer-Password-1' });
    assert.equal(created.status, 200);
    assert.equal(created.body.user.mustChangePassword, true);

    const viewer = client();
    await viewer('POST', '/auth/login', { username: 'viewer1', password: 'Viewer-Password-1' });
    assert.equal((await viewer('GET', '/api/read')).status, 200);
    assert.equal((await viewer('POST', '/api/write', {})).status, 403);
    assert.equal((await viewer('GET', '/api/admin/users')).status, 403);

    const adminId = auth.store.findLocal('admin')!.id;
    assert.equal((await admin('PATCH', `/api/admin/users/${adminId}`, { role: 'viewer' })).status, 409);
    assert.equal((await admin('DELETE', `/api/admin/users/${adminId}`)).status, 409);
  });

  test('disabling an account ends its sessions immediately', async () => {
    const admin = client();
    await admin('POST', '/auth/login', { username: 'admin', password: ADMIN_PW });
    await admin('POST', '/api/admin/users', { username: 'op1', role: 'operator', password: 'Operator-Pass-12' });
    const op = client();
    await op('POST', '/auth/login', { username: 'op1', password: 'Operator-Pass-12' });
    assert.equal((await op('GET', '/api/read')).status, 200);
    const id = auth.store.findLocal('op1')!.id;
    assert.equal((await admin('PATCH', `/api/admin/users/${id}`, { status: 'disabled' })).status, 200);
    assert.equal((await op('GET', '/api/read')).status, 401);
  });

  test('pending accounts (new SSO users) cannot use the API until approved with a role', async () => {
    const pending = auth.store.create({ provider: 'oidc', issuer: 'https://login.example', subject: 'abc', username: 'sara@contoso.com', displayName: 'Sara', role: null, status: 'pending' });
    const admin = client();
    await admin('POST', '/auth/login', { username: 'admin', password: ADMIN_PW });
    assert.equal((await admin('PATCH', `/api/admin/users/${pending.id}`, { status: 'active' })).status, 400, 'approval requires a role');
    assert.equal((await admin('PATCH', `/api/admin/users/${pending.id}`, { role: 'viewer', status: 'active' })).status, 200);
    assert.equal(auth.store.get(pending.id)!.status, 'active');
    const audit = auth.store.readAudit(5).map((e) => e.action);
    assert.ok(audit.includes('account-approved'));
  });

  test('role mapping from the identity provider picks the highest role', () => {
    const map = (claims: Record<string, unknown>) => (auth as any).roleFromClaims(claims);
    assert.equal(map({ roles: ['App.Operator', 'App.Admin'] }), 'admin');
    assert.equal(map({ roles: ['App.Operator'] }), 'operator');
    assert.equal(map({ roles: ['Other'] }), null);
    assert.equal(map({}), null);
  });

  test('changing the password requires the current one and revokes other sessions', async () => {
    const admin = client();
    await admin('POST', '/auth/login', { username: 'admin', password: ADMIN_PW });
    await admin('POST', '/api/admin/users', { username: 'pw1', role: 'viewer', password: 'Original-Pass-1' });
    const a = client();
    const b = client();
    await a('POST', '/auth/login', { username: 'pw1', password: 'Original-Pass-1' });
    await b('POST', '/auth/login', { username: 'pw1', password: 'Original-Pass-1' });
    assert.equal((await a('POST', '/api/auth/password', { current: 'bad', next: 'Brand-New-Pass-1' })).status, 400);
    assert.equal((await a('POST', '/api/auth/password', { current: 'Original-Pass-1', next: 'Brand-New-Pass-1' })).status, 200);
    assert.equal((await a('GET', '/api/read')).status, 200, 'current session stays');
    assert.equal((await b('GET', '/api/read')).status, 401, 'other sessions are ended');
  });

  test('repeated failed logins are rate limited', async () => {
    const c = client();
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await c('POST', '/auth/login', { username: 'ratelimited', password: 'x' })).status;
    assert.equal(last, 429);
  });
});

describe('sameOrigin', () => {
  test('accepts a missing or matching Origin', () => {
    assert.equal(sameOrigin(undefined, 'console.example.com'), true);
    assert.equal(sameOrigin('https://console.example.com', 'console.example.com'), true);
    assert.equal(sameOrigin('http://localhost:3000', 'localhost:3000'), true);
  });
  test('rejects other hosts and unparsable values without throwing', () => {
    assert.equal(sameOrigin('https://evil.example', 'console.example.com'), false);
    assert.equal(sameOrigin('null', 'console.example.com'), false);
    assert.equal(sameOrigin('not a url', 'console.example.com'), false);
  });
});

describe('sessions survive a console restart', () => {
  test('a cookie stays valid for a new Auth on the same DATA_DIR, and logout revokes it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-sess-'));
    const make = () => {
      const a = new Auth({ store: new UserStore(dir), bootstrapAdmin: { username: 'admin', password: 'Restart-Test-Pass' }, sessionIdleMinutes: 60, sessionMaxHours: 12 });
      a.bootstrap();
      const app = express();
      app.use(a.authenticate);
      a.mount(app);
      return { a, app };
    };
    const listen = async (app: express.Express) => {
      const srv = http.createServer(app);
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
      return { srv, url: `http://127.0.0.1:${(srv.address() as any).port}` };
    };
    const h = { 'X-Requested-With': 'jasmin-console', 'Content-Type': 'application/json' };

    const first = make();
    const s1 = await listen(first.app);
    const login = await fetch(`${s1.url}/auth/login`, { method: 'POST', headers: h, body: JSON.stringify({ username: 'admin', password: 'Restart-Test-Pass' }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    first.a.close();
    s1.srv.close();

    // The raw session id is never written to disk.
    const onDisk = fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8');
    assert.ok(!onDisk.includes(cookie.split('=')[1]));

    const second = make();
    const s2 = await listen(second.app);
    assert.equal((await fetch(`${s2.url}/api/auth/me`, { headers: { Cookie: cookie } })).status, 200);
    await fetch(`${s2.url}/auth/logout`, { method: 'POST', headers: { ...h, Cookie: cookie } });
    second.a.close();
    s2.srv.close();

    const third = make();
    const s3 = await listen(third.app);
    assert.equal((await fetch(`${s3.url}/api/auth/me`, { headers: { Cookie: cookie } })).status, 401);
    third.a.close();
    s3.srv.close();
  });
});

describe('Limiter', () => {
  test('sweep drops expired windows', () => {
    const l = new Limiter(2, 1);
    for (let i = 0; i < 100; i++) l.hit(`user${i}`);
    assert.equal(l.size, 100);
    l.sweep(Date.now() + 10);
    assert.equal(l.size, 0);
  });
});
