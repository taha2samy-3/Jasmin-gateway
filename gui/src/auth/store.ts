import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { AuditEntry, AuditLog, AuditLogOptions } from './audit-log.js';

export const ROLES = ['admin', 'operator', 'viewer'] as const;
export type Role = (typeof ROLES)[number];
export type AccountStatus = 'active' | 'pending' | 'disabled';

/**
 * Permissions checked by the API. Roles are fixed bundles of permissions (RBAC):
 *  - admin:    everything, including console account management and the audit log
 *  - operator: change gateway configuration, deploy flows, use the jCLI terminal, send test SMS
 *  - viewer:   read-only monitoring; message bodies are masked
 */
export const PERMISSIONS = {
  'gateway:read': ['admin', 'operator', 'viewer'],
  'gateway:write': ['admin', 'operator'],
  'traffic:read': ['admin', 'operator', 'viewer'],
  'traffic:content': ['admin', 'operator'],
  'sms:send': ['admin', 'operator'],
  'terminal:use': ['admin', 'operator'],
  'console:admin': ['admin']
} as const satisfies Record<string, readonly Role[]>;
export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role | null | undefined, permission: Permission): boolean {
  return !!role && (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

export interface ConsoleUser {
  id: string;
  provider: 'local' | 'oidc';
  username: string;
  displayName: string;
  email?: string;
  /** OIDC issuer + subject uniquely identify an external account. */
  issuer?: string;
  subject?: string;
  passwordHash?: string;
  mustChangePassword?: boolean;
  role: Role | null;
  status: AccountStatus;
  createdAt: string;
  lastLoginAt?: string;
  reviewedBy?: string;
  reviewedAt?: string;
}

export type PublicUser = Omit<ConsoleUser, 'passwordHash'>;

export function toPublic(u: ConsoleUser): PublicUser {
  const { passwordHash, ...rest } = u;
  return rest;
}

// --- Password hashing (scrypt, per-user salt) ------------------------------------------------
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string | undefined): boolean {
  if (!stored) return false;
  const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: +n, r: +r, p: +p });
  return crypto.timingSafeEqual(actual, expected);
}

export function passwordProblem(password: string): string | null {
  if (typeof password !== 'string' || password.length < 12) return 'Password must be at least 12 characters';
  if (password.length > 256) return 'Password is too long';
  return null;
}

// --- File-backed store -----------------------------------------------------------------------
export type { AuditEntry } from './audit-log.js';

/**
 * Console accounts and audit log, stored in DATA_DIR.
 * Account writes are atomic (temp file + rename) so a crash never leaves a half-written file.
 * The audit log has its own lifecycle (rotation, retention): see AuditLog.
 */
export class UserStore {
  private users: ConsoleUser[] = [];
  private readonly usersFile: string;
  readonly auditLog: AuditLog;

  constructor(private readonly dataDir: string, auditOptions: Partial<AuditLogOptions> = {}) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.usersFile = path.join(dataDir, 'users.json');
    if (fs.existsSync(this.usersFile)) {
      const parsed = JSON.parse(fs.readFileSync(this.usersFile, 'utf8'));
      this.users = Array.isArray(parsed.users) ? parsed.users : [];
    }
    this.auditLog = new AuditLog(dataDir, auditOptions);
  }

  get dir() {
    return this.dataDir;
  }

  private save() {
    const tmp = `${this.usersFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, users: this.users }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.usersFile);
  }

  list(): ConsoleUser[] {
    return [...this.users];
  }

  get(id: string): ConsoleUser | undefined {
    return this.users.find((u) => u.id === id);
  }

  findLocal(username: string): ConsoleUser | undefined {
    return this.users.find((u) => u.provider === 'local' && u.username.toLowerCase() === username.toLowerCase());
  }

  findOidc(issuer: string, subject: string): ConsoleUser | undefined {
    return this.users.find((u) => u.provider === 'oidc' && u.issuer === issuer && u.subject === subject);
  }

  activeAdmins(): ConsoleUser[] {
    return this.users.filter((u) => u.role === 'admin' && u.status === 'active');
  }

  create(fields: Omit<ConsoleUser, 'id' | 'createdAt'>): ConsoleUser {
    const user: ConsoleUser = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...fields };
    this.users.push(user);
    this.save();
    return user;
  }

  update(id: string, patch: Partial<ConsoleUser>): ConsoleUser {
    const user = this.get(id);
    if (!user) throw new Error('Account not found');
    Object.assign(user, patch);
    this.save();
    return user;
  }

  remove(id: string) {
    this.users = this.users.filter((u) => u.id !== id);
    this.save();
  }

  audit(entry: Omit<AuditEntry, 'at'>) {
    this.auditLog.append(entry);
  }

  readAudit(limit = 200, filter?: Parameters<AuditLog['read']>[1]): AuditEntry[] {
    return this.auditLog.read(limit, filter);
  }
}
