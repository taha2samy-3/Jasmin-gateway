import * as fs from 'fs';
import * as path from 'path';

export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  target?: string;
  detail?: unknown;
  ip?: string;
}

export interface AuditLogOptions {
  /** Delete rotated files whose day is older than this many days (0 = keep forever). */
  retentionDays: number;
  /** Rotate the active file when it reaches this size. */
  maxFileBytes: number;
  /** Delete the oldest rotated files while all files together exceed this size (0 = no cap). */
  maxTotalBytes: number;
  /** Also write every entry to stdout as one JSON line (for Fluent Bit / Promtail / SIEM). */
  stdout: boolean;
}

export const DEFAULT_AUDIT_OPTIONS: AuditLogOptions = {
  retentionDays: 180,
  maxFileBytes: 20 * 1024 * 1024,
  maxTotalBytes: 500 * 1024 * 1024,
  stdout: false
};

const ACTIVE = 'audit.log';
// Rotated files: audit-YYYY-MM-DD.log, audit-YYYY-MM-DD.1.log, ... (the day of their entries).
const ROTATED_RE = /^audit-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.log$/;

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Append-only audit trail with a lifecycle:
 *  - the active file is rotated at the first write of a new (UTC) day and when it reaches maxFileBytes;
 *  - rotated files are deleted after retentionDays, and the oldest go first when maxTotalBytes is exceeded;
 *  - pruning runs at start-up, after every rotation and daily.
 * Reads walk the active file and then the rotated files, newest first.
 */
export class AuditLog {
  private readonly active: string;
  private activeDay: string | null = null;
  private activeSize = 0;
  private readonly opts: AuditLogOptions;
  private timer: NodeJS.Timeout;

  constructor(private readonly dir: string, opts: Partial<AuditLogOptions> = {}, private readonly now: () => Date = () => new Date()) {
    this.opts = { ...DEFAULT_AUDIT_OPTIONS, ...opts };
    this.active = path.join(dir, ACTIVE);
    if (fs.existsSync(this.active)) {
      const st = fs.statSync(this.active);
      this.activeSize = st.size;
      this.activeDay = this.firstEntryDay() ?? day(st.mtime);
    }
    this.prune();
    this.timer = setInterval(() => this.prune(), 6 * 3600_000);
    this.timer.unref();
  }

  close() {
    clearInterval(this.timer);
  }

  append(entry: Omit<AuditEntry, 'at'>): AuditEntry {
    const now = this.now();
    const full: AuditEntry = { at: now.toISOString(), ...entry };
    const line = JSON.stringify(full) + '\n';
    const today = day(now);
    if (this.activeSize > 0 && (this.activeDay !== today || this.activeSize + Buffer.byteLength(line) > this.opts.maxFileBytes)) {
      this.rotate();
    }
    fs.appendFileSync(this.active, line, { mode: 0o600 });
    if (this.activeSize === 0) this.activeDay = today;
    this.activeSize += Buffer.byteLength(line);
    if (this.opts.stdout) process.stdout.write(JSON.stringify({ log: 'audit', ...full }) + '\n');
    return full;
  }

  /** Newest entries first, optionally filtered. Walks rotated files only as far as needed. */
  read(limit = 200, filter: { since?: string; actor?: string; action?: string; q?: string } = {}): AuditEntry[] {
    const out: AuditEntry[] = [];
    const q = filter.q?.toLowerCase();
    for (const file of this.files()) {
      const lines = fs.readFileSync(file.path, 'utf8').split('\n');
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        if (!lines[i]) continue;
        let e: AuditEntry;
        try {
          e = JSON.parse(lines[i]);
        } catch {
          continue;
        }
        if (filter.since && e.at < filter.since) return out;
        if (filter.actor && e.actor !== filter.actor) continue;
        if (filter.action && e.action !== filter.action) continue;
        if (q && !lines[i].toLowerCase().includes(q)) continue;
        out.push(e);
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Oldest-first JSON lines of every retained file (for export/download). */
  *exportLines(since?: string): Generator<string> {
    for (const file of this.files().reverse()) {
      for (const line of fs.readFileSync(file.path, 'utf8').split('\n')) {
        if (!line) continue;
        if (since) {
          const at = /"at":"([^"]+)"/.exec(line)?.[1];
          if (at && at < since) continue;
        }
        yield line;
      }
    }
  }

  /** Retained files, newest first (active file first). */
  files(): { path: string; day: string; size: number }[] {
    const rotated = fs
      .readdirSync(this.dir)
      .map((name) => ({ name, m: ROTATED_RE.exec(name) }))
      .filter((x): x is { name: string; m: RegExpExecArray } => !!x.m)
      .map(({ name, m }) => ({ path: path.join(this.dir, name), day: m[1], seq: Number(m[2] ?? 0), size: fs.statSync(path.join(this.dir, name)).size }))
      .sort((a, b) => (a.day === b.day ? b.seq - a.seq : a.day < b.day ? 1 : -1))
      .map(({ path: p, day: d, size }) => ({ path: p, day: d, size }));
    const active = fs.existsSync(this.active) ? [{ path: this.active, day: this.activeDay ?? day(this.now()), size: this.activeSize }] : [];
    return [...active, ...rotated];
  }

  stats() {
    const files = this.files();
    return {
      files: files.length,
      totalBytes: files.reduce((n, f) => n + f.size, 0),
      oldestDay: files.length ? files[files.length - 1].day : null,
      ...this.opts
    };
  }

  private firstEntryDay(): string | null {
    const fd = fs.openSync(this.active, 'r');
    try {
      const buf = Buffer.alloc(256);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const at = /"at":"(\d{4}-\d{2}-\d{2})/.exec(buf.subarray(0, n).toString('utf8'))?.[1];
      return at ?? null;
    } finally {
      fs.closeSync(fd);
    }
  }

  private rotate() {
    const d = this.activeDay ?? day(this.now());
    let target = path.join(this.dir, `audit-${d}.log`);
    for (let seq = 1; fs.existsSync(target); seq++) target = path.join(this.dir, `audit-${d}.${seq}.log`);
    fs.renameSync(this.active, target);
    this.activeSize = 0;
    this.activeDay = null;
    this.prune();
  }

  /** Apply retentionDays and maxTotalBytes to rotated files (the active file is never deleted). */
  prune(): string[] {
    const removed: string[] = [];
    const rotated = this.files().filter((f) => f.path !== this.active);
    if (this.opts.retentionDays > 0) {
      const cutoff = day(new Date(this.now().getTime() - this.opts.retentionDays * 86400_000));
      for (const f of rotated) if (f.day < cutoff) removed.push(f.path);
    }
    if (this.opts.maxTotalBytes > 0) {
      let total = this.activeSize + rotated.filter((f) => !removed.includes(f.path)).reduce((n, f) => n + f.size, 0);
      for (const f of [...rotated].reverse()) {
        if (total <= this.opts.maxTotalBytes) break;
        if (removed.includes(f.path)) continue;
        removed.push(f.path);
        total -= f.size;
      }
    }
    for (const p of removed) {
      fs.rmSync(p, { force: true });
      console.log(`[audit] Removed ${path.basename(p)} (retention ${this.opts.retentionDays}d, cap ${Math.round(this.opts.maxTotalBytes / 1048576)} MB)`);
    }
    return removed;
  }
}
