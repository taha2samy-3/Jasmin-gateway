import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuditLog } from './audit-log.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
const clock = (iso: string) => {
  let t = new Date(iso).getTime();
  return { now: () => new Date(t), advanceDays: (d: number) => (t += d * 86400_000) };
};

describe('AuditLog lifecycle', () => {
  test('rotates at the first write of a new day and reads newest first across files', () => {
    const dir = tmp();
    const c = clock('2026-01-01T10:00:00Z');
    const log = new AuditLog(dir, { retentionDays: 0 }, c.now);
    log.append({ actor: 'a', action: 'one' });
    c.advanceDays(1);
    log.append({ actor: 'a', action: 'two' });
    log.close();
    assert.deepEqual(fs.readdirSync(dir).sort(), ['audit-2026-01-01.log', 'audit.log']);
    assert.deepEqual(log.read(10).map((e) => e.action), ['two', 'one']);
  });

  test('rotates on size and numbers same-day files', () => {
    const dir = tmp();
    const c = clock('2026-01-01T10:00:00Z');
    const log = new AuditLog(dir, { retentionDays: 0, maxFileBytes: 150, maxTotalBytes: 0 }, c.now);
    for (let i = 0; i < 6; i++) log.append({ actor: 'a', action: `n${i}`, target: 'x'.repeat(40) });
    log.close();
    const files = fs.readdirSync(dir).sort();
    assert.ok(files.includes('audit-2026-01-01.log') && files.includes('audit-2026-01-01.1.log'), files.join());
    assert.deepEqual(log.read(100).map((e) => e.action), ['n5', 'n4', 'n3', 'n2', 'n1', 'n0']);
  });

  test('deletes rotated files older than retentionDays, keeps the active file', () => {
    const dir = tmp();
    const c = clock('2026-01-01T10:00:00Z');
    const log = new AuditLog(dir, { retentionDays: 30 }, c.now);
    log.append({ actor: 'a', action: 'old' });
    c.advanceDays(1);
    log.append({ actor: 'a', action: 'recent' });
    c.advanceDays(40);
    log.append({ actor: 'a', action: 'today' });
    log.close();
    assert.deepEqual(log.read(10).map((e) => e.action), ['today']);
  });

  test('caps total size by removing the oldest rotated files', () => {
    const dir = tmp();
    const c = clock('2026-01-01T10:00:00Z');
    const log = new AuditLog(dir, { retentionDays: 0, maxTotalBytes: 400 }, c.now);
    for (let i = 0; i < 6; i++) {
      log.append({ actor: 'a', action: `day${i}`, target: 'x'.repeat(80) });
      c.advanceDays(1);
    }
    log.prune();
    log.close();
    const st = log.stats();
    assert.ok(st.totalBytes <= 400, String(st.totalBytes));
    assert.equal(log.read(1)[0].action, 'day5');
  });

  test('filters and export (oldest first, since)', () => {
    const dir = tmp();
    const c = clock('2026-01-01T10:00:00Z');
    const log = new AuditLog(dir, { retentionDays: 0 }, c.now);
    log.append({ actor: 'alice', action: 'login' });
    c.advanceDays(1);
    log.append({ actor: 'bob', action: 'login' });
    log.append({ actor: 'alice', action: 'gateway-change', target: 'POST /api/users' });
    log.close();
    assert.deepEqual(log.read(10, { actor: 'alice' }).map((e) => e.action), ['gateway-change', 'login']);
    assert.deepEqual(log.read(10, { q: 'api/users' }).length, 1);
    assert.deepEqual(log.read(10, { since: '2026-01-02T00:00:00.000Z' }).map((e) => e.actor), ['alice', 'bob']);
    assert.deepEqual([...log.exportLines()].map((l) => JSON.parse(l).actor), ['alice', 'bob', 'alice']);
    assert.equal([...log.exportLines('2026-01-02T00:00:00.000Z')].length, 2);
  });

  test('resumes the active file day after a restart', () => {
    const dir = tmp();
    const c = clock('2026-01-01T10:00:00Z');
    new AuditLog(dir, {}, c.now).append({ actor: 'a', action: 'before-restart' });
    c.advanceDays(1);
    const log = new AuditLog(dir, {}, c.now);
    log.append({ actor: 'a', action: 'after-restart' });
    log.close();
    assert.ok(fs.existsSync(path.join(dir, 'audit-2026-01-01.log')));
  });
});
