import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConfigReader } from './config-reader.js';

describe('ConfigReader Unit Tests', () => {
  test('returns exists: false for non-existent file', () => {
    const reader = new ConfigReader('/tmp/non_existent_jasmin_' + Date.now() + '.cfg');
    const config = reader.getConfig();
    assert.equal(config.exists, false);
    assert.deepEqual(config.sections, {});
    assert.match(config.rawMasked, /Configuration file not found/);
  });

  test('parses INI sections and key-values accurately', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jasmin-cfg-test-'));
    const testCfg = path.join(tmpDir, 'test.cfg');
    const content = `
[redis-client]
host = 127.0.0.1
port = 6379
password = supersecretpassword

[jcli]
bind = 0.0.0.0
port = 8990
admin_username = "admin"
admin_password = 'mysecretpassword'
`;
    fs.writeFileSync(testCfg, content, 'utf-8');

    try {
      const reader = new ConfigReader(testCfg);
      const config = reader.getConfig();

      assert.equal(config.exists, true);
      assert.equal(config.sections['redis-client']?.host, '127.0.0.1');
      assert.equal(config.sections['redis-client']?.port, '6379');
      assert.equal(config.sections['redis-client']?.password, 'supersecretpassword');
      assert.equal(config.sections['jcli']?.bind, '0.0.0.0');
      assert.equal(config.sections['jcli']?.port, '8990');
      assert.equal(config.sections['jcli']?.admin_username, 'admin');
      assert.equal(config.sections['jcli']?.admin_password, 'mysecretpassword');

      // Check masking
      assert.doesNotMatch(config.rawMasked, /supersecretpassword/);
      assert.doesNotMatch(config.rawMasked, /mysecretpassword/);
      assert.match(config.rawMasked, /password\s*=\s*\*{8}/);
      assert.match(config.rawMasked, /admin_password\s*=\s*\*{8}/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('handles commented lines and active overrides', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jasmin-cfg-test-'));
    const testCfg = path.join(tmpDir, 'test-comments.cfg');
    const content = `
[smpp-server]
# port = 2774
port = 2775
`;
    fs.writeFileSync(testCfg, content, 'utf-8');

    try {
      const reader = new ConfigReader(testCfg);
      const config = reader.getConfig();
      assert.equal(config.sections['smpp-server']?.port, '2775');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
