import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { IncomingMessage } from 'http';
import express, { Express, NextFunction, Request, Response } from 'express';
import { BaseClient, generators, Issuer } from 'openid-client';
import { can, ConsoleUser, hashPassword, passwordProblem, Permission, ROLES, Role, toPublic, UserStore, verifyPassword } from './store.js';

export interface AuthOptions {
  store: UserStore;
  /** External URL of the console, e.g. https://jasmin.example.com (used for the OIDC redirect URI). */
  publicUrl?: string;
  bootstrapAdmin: { username: string; password?: string };
  sessionIdleMinutes: number;
  sessionMaxHours: number;
  /** Keep sessions in DATA_DIR/sessions.json so a console restart does not sign everyone out (default true). */
  persistSessions?: boolean;
  oidc?: {
    issuerUrl: string;
    clientId: string;
    clientSecret?: string;
    scopes: string;
    displayName: string;
    /** Claim holding roles/groups (Entra app roles arrive in `roles`). */
    roleClaim: string;
    /** Map of console role -> claim value. When a user has a mapped value the role is assigned automatically. */
    roleMap: Partial<Record<Role, string>>;
  };
}

interface Session {
  id: string;
  userId: string;
  createdAt: number;
  lastSeen: number;
  idToken?: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: ConsoleUser;
      session?: Session;
    }
  }
}

const COOKIE = 'jc_session';
const FLOW_COOKIE = 'jc_oidc';

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * True when an Origin header is absent or names the same host as the request.
 * Never throws: browsers send `Origin: null` (sandboxed frames, some redirects) and attackers can
 * send anything, so an unparsable value is treated as cross-origin instead of raising.
 */
export function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function clientIp(req: Request | IncomingMessage): string {
  return ((req as Request).ip || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

/** Simple fixed-window limiter for login attempts. */
export class Limiter {
  private hits = new Map<string, { count: number; reset: number }>();
  constructor(private max: number, private windowMs: number) {}
  hit(key: string): boolean {
    const now = Date.now();
    const e = this.hits.get(key);
    if (!e || e.reset < now) {
      this.hits.set(key, { count: 1, reset: now + this.windowMs });
      return true;
    }
    e.count++;
    return e.count <= this.max;
  }
  clear(key: string) {
    this.hits.delete(key);
  }
  /** Drop expired windows so random usernames cannot grow the map without bound. */
  sweep(now = Date.now()) {
    for (const [k, e] of this.hits) if (e.reset < now) this.hits.delete(k);
  }
  get size() {
    return this.hits.size;
  }
}

/** Session ids are stored hashed: a leaked sessions.json cannot be replayed as cookies. */
const sessionKey = (sid: string) => crypto.createHash('sha256').update(sid).digest('base64url');

export class Auth {
  private sessions = new Map<string, Session>();
  private oidcClient: BaseClient | null = null;
  private oidcIssuer: Issuer<BaseClient> | null = null;
  private oidcError: string | null = null;
  /** Per account+IP: stops guessing one account. */
  private limiter = new Limiter(10, 15 * 60 * 1000);
  /** Per IP: stops spraying many usernames from one address. */
  private ipLimiter = new Limiter(50, 15 * 60 * 1000);
  private readonly sessionsFile: string | null;
  private sessionsDirty = false;
  private timer: NodeJS.Timeout;
  readonly store: UserStore;

  constructor(private readonly opts: AuthOptions) {
    this.store = opts.store;
    this.sessionsFile = opts.persistSessions === false ? null : path.join(opts.store.dir, 'sessions.json');
    this.loadSessions();
    this.timer = setInterval(() => {
      this.sweep();
      this.saveSessions();
    }, 30_000);
    this.timer.unref();
  }

  /** Flush sessions and stop timers (call on shutdown). */
  close() {
    clearInterval(this.timer);
    this.saveSessions(true);
    this.store.auditLog.close();
  }

  private loadSessions() {
    if (!this.sessionsFile || !fs.existsSync(this.sessionsFile)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8'));
      const now = Date.now();
      for (const s of Array.isArray(parsed.sessions) ? parsed.sessions : []) {
        if (typeof s?.id === 'string' && typeof s.userId === 'string' && this.valid(s, now)) {
          this.sessions.set(s.id, { id: s.id, userId: s.userId, createdAt: s.createdAt, lastSeen: s.lastSeen });
        }
      }
    } catch (err: any) {
      console.warn(`[auth] Ignoring unreadable ${this.sessionsFile}: ${err.message}`);
    }
  }

  /** Atomic write; the OIDC id_token is not persisted (only used as a logout hint). */
  private saveSessions(force = false) {
    if (!this.sessionsFile || (!this.sessionsDirty && !force)) return;
    const sessions = [...this.sessions.values()].map(({ id, userId, createdAt, lastSeen }) => ({ id, userId, createdAt, lastSeen }));
    const tmp = `${this.sessionsFile}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessions }), { mode: 0o600 });
      fs.renameSync(tmp, this.sessionsFile);
      this.sessionsDirty = false;
    } catch (err: any) {
      console.warn(`[auth] Could not save sessions: ${err.message}`);
    }
  }

  get oidcEnabled() {
    return !!this.opts.oidc;
  }

  /** Create the first administrator if no active admin exists. */
  bootstrap(): void {
    if (this.store.activeAdmins().length > 0) return;
    const { username } = this.opts.bootstrapAdmin;
    let password = this.opts.bootstrapAdmin.password;
    let generated = false;
    if (!password) {
      password = crypto.randomBytes(15).toString('base64url');
      generated = true;
    }
    const existing = this.store.findLocal(username);
    if (existing) {
      this.store.update(existing.id, { role: 'admin', status: 'active', passwordHash: hashPassword(password), mustChangePassword: generated });
    } else {
      this.store.create({ provider: 'local', username, displayName: 'Administrator', passwordHash: hashPassword(password), mustChangePassword: generated, role: 'admin', status: 'active' });
    }
    this.store.audit({ actor: 'system', action: 'bootstrap-admin', target: username });
    if (generated) {
      console.warn('='.repeat(72));
      console.warn(`[auth] Initial administrator created: username "${username}"`);
      console.warn(`[auth] Generated password: ${password}`);
      console.warn('[auth] Sign in and change it now; it will not be shown again.');
      console.warn('='.repeat(72));
    } else {
      console.log(`[auth] Initial administrator "${username}" created from ADMIN_PASSWORD`);
    }
  }

  private async oidc(): Promise<BaseClient> {
    if (this.oidcClient) return this.oidcClient;
    const o = this.opts.oidc!;
    try {
      this.oidcIssuer = await Issuer.discover(o.issuerUrl);
      this.oidcClient = new this.oidcIssuer.Client({
        client_id: o.clientId,
        client_secret: o.clientSecret,
        redirect_uris: [this.redirectUri()],
        response_types: ['code'],
        token_endpoint_auth_method: o.clientSecret ? 'client_secret_post' : 'none'
      });
      this.oidcError = null;
      return this.oidcClient;
    } catch (err: any) {
      this.oidcError = err.message;
      throw new Error(`OIDC discovery failed for ${o.issuerUrl}: ${err.message}`);
    }
  }

  private redirectUri() {
    return `${(this.opts.publicUrl || '').replace(/\/$/, '')}/auth/oidc/callback`;
  }

  private secureCookies(req: Request) {
    return req.secure || (this.opts.publicUrl || '').startsWith('https://');
  }

  private setCookie(req: Request, res: Response, name: string, value: string, maxAgeMs: number) {
    res.cookie(name, value, { httpOnly: true, sameSite: 'lax', secure: this.secureCookies(req), path: '/', maxAge: maxAgeMs });
  }

  private startSession(req: Request, res: Response, user: ConsoleUser, idToken?: string) {
    const sid = crypto.randomBytes(32).toString('base64url');
    const id = sessionKey(sid);
    const now = Date.now();
    this.sessions.set(id, { id, userId: user.id, createdAt: now, lastSeen: now, idToken });
    this.saveSessions(true);
    this.setCookie(req, res, COOKIE, sid, this.opts.sessionMaxHours * 3600_000);
    this.store.update(user.id, { lastLoginAt: new Date().toISOString() });
  }

  private sweep() {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (!this.valid(s, now)) {
        this.sessions.delete(id);
        this.sessionsDirty = true;
      }
    }
    this.limiter.sweep(now);
    this.ipLimiter.sweep(now);
  }

  private valid(s: Session, now = Date.now()) {
    return now - s.lastSeen < this.opts.sessionIdleMinutes * 60_000 && now - s.createdAt < this.opts.sessionMaxHours * 3600_000;
  }

  /** Resolve the session from a cookie header (also used for WebSocket upgrades). */
  resolve(cookieHeader: string | undefined): { session: Session; user: ConsoleUser } | null {
    const sid = parseCookies(cookieHeader)[COOKIE];
    const session = sid ? this.sessions.get(sessionKey(sid)) : undefined;
    if (!session || !this.valid(session)) return null;
    const user = this.store.get(session.userId);
    if (!user || user.status === 'disabled') return null;
    session.lastSeen = Date.now();
    this.sessionsDirty = true;
    return { session, user };
  }

  /** Revoke every session of an account (after disable, role change or password change). */
  revokeUser(userId: string, except?: string) {
    let changed = false;
    for (const [id, s] of this.sessions) {
      if (s.userId === userId && id !== except) {
        this.sessions.delete(id);
        changed = true;
      }
    }
    if (changed) this.saveSessions(true);
  }

  /** Attach req.user when a valid session cookie is present. */
  authenticate = (req: Request, _res: Response, next: NextFunction) => {
    const r = this.resolve(req.headers.cookie);
    if (r) {
      req.user = r.user;
      req.session = r.session;
    }
    next();
  };

  /** Reject cross-site state-changing requests (cookie auth requires CSRF protection). */
  csrf = (req: Request, res: Response, next: NextFunction) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('X-Requested-With') !== 'jasmin-console') return res.status(403).json({ error: 'Missing anti-CSRF header' });
    if (!sameOrigin(req.get('Origin'), req.get('Host'))) return res.status(403).json({ error: 'Cross-origin request rejected' });
    next();
  };

  /** Require an active account with the given permission. */
  require = (permission: Permission) => (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in required' });
    if (req.user.status === 'pending') return res.status(403).json({ error: 'Your account is waiting for administrator approval', pending: true });
    if (req.user.mustChangePassword && !['gateway:read', 'traffic:read'].includes(permission)) {
      return res.status(403).json({ error: 'Change your password before making changes', mustChangePassword: true });
    }
    if (!can(req.user.role, permission)) return res.status(403).json({ error: `Your role (${req.user.role ?? 'none'}) does not allow this action` });
    next();
  };

  audit(req: Request, action: string, target?: string, detail?: unknown) {
    this.store.audit({ actor: req.user ? req.user.username : 'anonymous', action, target, detail, ip: clientIp(req) });
  }

  /** Mount /auth/* and /api/auth/* and /api/admin/* routes. */
  mount(app: Express) {
    const json = express.json({ limit: '64kb' });

    app.get('/auth/providers', (_req, res) => {
      res.json({ local: true, oidc: this.opts.oidc ? { name: this.opts.oidc.displayName, error: this.oidcError } : null });
    });

    app.post('/auth/login', json, this.csrf, (req, res) => {
      const username = String(req.body?.username ?? '').trim();
      const password = String(req.body?.password ?? '');
      const ip = clientIp(req);
      const key = `${ip}|${username.toLowerCase()}`;
      if (!this.ipLimiter.hit(ip) || !this.limiter.hit(key)) {
        this.store.audit({ actor: username || 'anonymous', action: 'login-throttled', ip });
        return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
      }
      const user = this.store.findLocal(username);
      // Verify even for unknown users to keep timing uniform.
      const ok = verifyPassword(password, user?.passwordHash ?? hashPassword('timing-dummy-password'));
      if (!user || !ok) {
        this.store.audit({ actor: username || 'anonymous', action: 'login-failed', ip: clientIp(req) });
        return res.status(401).json({ error: 'Invalid username or password' });
      }
      if (user.status === 'disabled') return res.status(403).json({ error: 'This account is disabled' });
      this.limiter.clear(key);
      this.startSession(req, res, user);
      this.store.audit({ actor: user.username, action: 'login', detail: { provider: 'local' }, ip: clientIp(req) });
      res.json({ user: toPublic(user) });
    });

    app.post('/auth/logout', this.csrf, async (req, res) => {
      const r = this.resolve(req.headers.cookie);
      let logoutUrl: string | null = null;
      if (r) {
        this.sessions.delete(r.session.id);
        this.saveSessions(true);
        this.store.audit({ actor: r.user.username, action: 'logout', ip: clientIp(req) });
        if (r.session.idToken && this.oidcClient && this.oidcIssuer?.metadata.end_session_endpoint) {
          logoutUrl = this.oidcClient.endSessionUrl({ id_token_hint: r.session.idToken, post_logout_redirect_uri: `${(this.opts.publicUrl || '').replace(/\/$/, '')}/login` });
        }
      }
      res.clearCookie(COOKIE, { path: '/' });
      res.json({ success: true, logoutUrl });
    });

    // OIDC Authorization Code flow with PKCE, state and nonce.
    app.get('/auth/oidc/login', async (req, res) => {
      if (!this.opts.oidc) return res.redirect('/login?error=' + encodeURIComponent('Single sign-on is not configured'));
      try {
        const client = await this.oidc();
        const state = generators.state();
        const nonce = generators.nonce();
        const verifier = generators.codeVerifier();
        this.setCookie(req, res, FLOW_COOKIE, JSON.stringify({ state, nonce, verifier }), 10 * 60_000);
        res.redirect(
          client.authorizationUrl({
            scope: this.opts.oidc.scopes,
            state,
            nonce,
            code_challenge: generators.codeChallenge(verifier),
            code_challenge_method: 'S256'
          })
        );
      } catch (err: any) {
        res.redirect('/login?error=' + encodeURIComponent(err.message));
      }
    });

    app.get('/auth/oidc/callback', async (req, res) => {
      const fail = (msg: string) => res.redirect('/login?error=' + encodeURIComponent(msg));
      let flow: { state: string; nonce: string; verifier: string };
      try {
        flow = JSON.parse(parseCookies(req.headers.cookie)[FLOW_COOKIE] || '');
      } catch {
        return fail('Sign-in session expired, please try again');
      }
      res.clearCookie(FLOW_COOKIE, { path: '/' });
      try {
        const client = await this.oidc();
        const params = client.callbackParams(req);
        if (params.error) return fail(`${params.error}: ${params.error_description || ''}`);
        const tokens = await client.callback(this.redirectUri(), params, { state: flow.state, nonce: flow.nonce, code_verifier: flow.verifier });
        const claims = tokens.claims();
        const issuer = claims.iss;
        const subject = claims.sub;
        // Entra ID often has no `email`; preferred_username carries the UPN.
        const username = String(claims.preferred_username || claims.email || claims.upn || subject);
        const displayName = String(claims.name || username);
        const email = claims.email ? String(claims.email) : claims.preferred_username && String(claims.preferred_username).includes('@') ? String(claims.preferred_username) : undefined;
        const mappedRole = this.roleFromClaims(claims as Record<string, unknown>);

        let user = this.store.findOidc(issuer, subject);
        if (!user) {
          user = this.store.create({
            provider: 'oidc',
            issuer,
            subject,
            username,
            displayName,
            email,
            role: mappedRole,
            status: mappedRole ? 'active' : 'pending'
          });
          this.store.audit({ actor: username, action: mappedRole ? 'account-created' : 'account-requested', detail: { provider: 'oidc', role: mappedRole }, ip: clientIp(req) });
        } else {
          const patch: Partial<ConsoleUser> = { username, displayName, email };
          // When role mapping is configured the identity provider stays authoritative.
          if (mappedRole && user.status !== 'disabled' && (mappedRole !== user.role || user.status === 'pending')) {
            patch.role = mappedRole;
            patch.status = 'active';
          }
          user = this.store.update(user.id, patch);
        }
        if (user.status === 'disabled') return fail('This account is disabled');
        this.startSession(req, res, user, tokens.id_token);
        this.store.audit({ actor: user.username, action: 'login', detail: { provider: 'oidc', status: user.status }, ip: clientIp(req) });
        res.redirect(user.status === 'pending' ? '/login?pending=1' : '/');
      } catch (err: any) {
        fail(`Single sign-on failed: ${err.message}`);
      }
    });

    app.get('/api/auth/me', (req, res) => {
      if (!req.user) return res.status(401).json({ error: 'Sign in required' });
      const perms = Object.keys({ 'gateway:read': 1, 'gateway:write': 1, 'traffic:read': 1, 'traffic:content': 1, 'sms:send': 1, 'terminal:use': 1, 'console:admin': 1 }) as Permission[];
      res.json({
        user: toPublic(req.user),
        permissions: req.user.status === 'active' ? perms.filter((p) => can(req.user!.role, p)) : []
      });
    });

    app.post('/api/auth/password', json, this.csrf, (req, res) => {
      const user = req.user;
      if (!user) return res.status(401).json({ error: 'Sign in required' });
      if (user.provider !== 'local') return res.status(400).json({ error: 'Single sign-on accounts change their password at the identity provider' });
      if (!verifyPassword(String(req.body?.current ?? ''), user.passwordHash)) return res.status(400).json({ error: 'Current password is incorrect' });
      const next = String(req.body?.next ?? '');
      const problem = passwordProblem(next);
      if (problem) return res.status(400).json({ error: problem });
      this.store.update(user.id, { passwordHash: hashPassword(next), mustChangePassword: false });
      this.revokeUser(user.id, req.session?.id);
      this.audit(req, 'password-changed', user.username);
      res.json({ success: true });
    });

    // --- Account administration ------------------------------------------------------------
    const admin = this.require('console:admin');

    app.get('/api/admin/users', admin, (_req, res) => {
      res.json({ users: this.store.list().map(toPublic), roles: ROLES });
    });

    app.post('/api/admin/users', json, this.csrf, admin, (req, res) => {
      const username = String(req.body?.username ?? '').trim();
      const role = req.body?.role as Role;
      if (!/^[A-Za-z0-9._@-]{3,64}$/.test(username)) return res.status(400).json({ error: 'Username must be 3-64 characters (letters, digits, . _ @ -)' });
      if (!ROLES.includes(role)) return res.status(400).json({ error: 'Choose a valid role' });
      if (this.store.findLocal(username)) return res.status(409).json({ error: 'A local account with this username already exists' });
      const password = String(req.body?.password ?? '');
      const problem = passwordProblem(password);
      if (problem) return res.status(400).json({ error: problem });
      const user = this.store.create({
        provider: 'local',
        username,
        displayName: String(req.body?.displayName || username),
        passwordHash: hashPassword(password),
        mustChangePassword: true,
        role,
        status: 'active',
        reviewedBy: req.user!.username,
        reviewedAt: new Date().toISOString()
      });
      this.audit(req, 'account-created', username, { role, provider: 'local' });
      res.json({ user: toPublic(user) });
    });

    app.patch('/api/admin/users/:id', json, this.csrf, admin, (req, res) => {
      const user = this.store.get(req.params.id);
      if (!user) return res.status(404).json({ error: 'Account not found' });
      const patch: Partial<ConsoleUser> = {};
      if (req.body?.role !== undefined) {
        if (!ROLES.includes(req.body.role)) return res.status(400).json({ error: 'Choose a valid role' });
        patch.role = req.body.role;
      }
      if (req.body?.status !== undefined) {
        if (!['active', 'disabled'].includes(req.body.status)) return res.status(400).json({ error: 'Status must be active or disabled' });
        patch.status = req.body.status;
        if (patch.status === 'active' && !(patch.role ?? user.role)) return res.status(400).json({ error: 'Assign a role before approving the account' });
      }
      const losingAdmin = user.role === 'admin' && user.status === 'active' && ((patch.role && patch.role !== 'admin') || patch.status === 'disabled');
      if (losingAdmin && this.store.activeAdmins().length <= 1) return res.status(409).json({ error: 'At least one active administrator must remain' });
      if (req.body?.resetPassword) {
        if (user.provider !== 'local') return res.status(400).json({ error: 'Only local accounts have a password' });
        const problem = passwordProblem(String(req.body.resetPassword));
        if (problem) return res.status(400).json({ error: problem });
        patch.passwordHash = hashPassword(String(req.body.resetPassword));
        patch.mustChangePassword = true;
      }
      const wasPending = user.status === 'pending';
      patch.reviewedBy = req.user!.username;
      patch.reviewedAt = new Date().toISOString();
      const updated = this.store.update(user.id, patch);
      // Role or status changes take effect immediately: force re-authentication elsewhere.
      if (patch.status === 'disabled' || patch.passwordHash) this.revokeUser(user.id);
      this.audit(req, wasPending && updated.status === 'active' ? 'account-approved' : 'account-updated', user.username, {
        role: patch.role,
        status: patch.status,
        passwordReset: !!patch.passwordHash
      });
      res.json({ user: toPublic(updated) });
    });

    app.delete('/api/admin/users/:id', this.csrf, admin, (req, res) => {
      const user = this.store.get(req.params.id);
      if (!user) return res.status(404).json({ error: 'Account not found' });
      if (user.id === req.user!.id) return res.status(409).json({ error: 'You cannot delete your own account' });
      if (user.role === 'admin' && user.status === 'active' && this.store.activeAdmins().length <= 1) {
        return res.status(409).json({ error: 'At least one active administrator must remain' });
      }
      this.store.remove(user.id);
      this.revokeUser(user.id);
      this.audit(req, user.status === 'pending' ? 'account-rejected' : 'account-deleted', user.username);
      res.json({ success: true });
    });

    const auditFilter = (req: Request) => {
      const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
      const since = str(req.query.since);
      return { since: since && !isNaN(Date.parse(since)) ? new Date(since).toISOString() : undefined, actor: str(req.query.actor), action: str(req.query.action), q: str(req.query.q) };
    };

    app.get('/api/admin/audit', admin, (req, res) => {
      res.json({ entries: this.store.readAudit(Math.min(Number(req.query.limit) || 200, 5000), auditFilter(req)), lifecycle: this.store.auditLog.stats() });
    });

    // Full retained trail, oldest first: JSON lines or CSV.
    app.get('/api/admin/audit/export', admin, (req, res) => {
      const { since } = auditFilter(req);
      const csv = req.query.format === 'csv';
      this.audit(req, 'audit-exported', csv ? 'csv' : 'jsonl', { since });
      const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '');
      res.setHeader('Content-Type', csv ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="jasmin-console-audit-${stamp}.${csv ? 'csv' : 'jsonl'}"`);
      // Leading =,+,-,@ would run as formulas when the CSV is opened in a spreadsheet.
      const cell = (v: unknown) => {
        let t = v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
        if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
        return `"${t.replace(/"/g, '""')}"`;
      };
      if (csv) res.write('at,actor,action,target,detail,ip\n');
      for (const line of this.store.auditLog.exportLines(since)) {
        if (!csv) {
          res.write(line + '\n');
          continue;
        }
        try {
          const e = JSON.parse(line);
          res.write([e.at, e.actor, e.action, e.target, e.detail, e.ip].map(cell).join(',') + '\n');
        } catch {
          /* skip a damaged line */
        }
      }
      res.end();
    });
  }

  private roleFromClaims(claims: Record<string, unknown>): Role | null {
    const o = this.opts.oidc;
    if (!o || Object.keys(o.roleMap).length === 0) return null;
    const raw = claims[o.roleClaim];
    const values = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(/[\s,]+/) : [];
    // Highest privilege wins.
    for (const role of ROLES) {
      const expected = o.roleMap[role];
      if (expected && values.includes(expected)) return role;
    }
    return null;
  }
}
