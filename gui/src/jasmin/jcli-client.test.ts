import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as net from 'node:net';
import { JCliClient, JCliError, cleanOutput, parseTable, splitList, filterValueFromDescription } from './jcli-client.js';
import { JCLI_0_11_1 } from './__fixtures__/jasmin-0.11.1.js';

const NL = '\r\r\r\n';

/**
 * Fake jCLI that reproduces the wire behaviour recorded from Jasmin 0.11.1:
 * telnet negotiation + "Authentication required." without a Username prompt, echoed input,
 * "\r\r\r\n" line endings, "> " prompt inside add sessions and jCLI's real error lines.
 */
function fakeJcli() {
  const commands: string[] = [];
  const server = net.createServer((socket) => {
    let stage: 'user' | 'pass' | 'ready' = 'user';
    let session: { kind: string; keys: Record<string, string> } | null = null;
    let buf = '';
    socket.write(Buffer.from([0xff, 0xfd, 0x22, 0xff, 0xfd, 0x1f, 0xff, 0xfb, 0x01]));
    socket.write(`\x1bc\x1b[4hAuthentication required.${NL}${NL}`);
    socket.on('data', (data) => {
      buf += data.toString();
      let i: number;
      while ((i = buf.search(/\r?\n/)) !== -1) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + (buf[i] === '\r' ? 2 : 1));
        handle(line);
      }
    });
    const prompt = () => (session ? '> ' : 'jcli : ');
    const reply = (cmd: string, body = '') => socket.write(`${cmd}${NL}${body ? body + NL : ''}${prompt()}`);
    function handle(line: string) {
      if (stage === 'user') {
        stage = 'pass';
        socket.write(`${line}${NL}Password: `);
        return;
      }
      if (stage === 'pass') {
        if (line !== 'jclipwd') {
          socket.write(`${NL}Incorrect Username/Password.${NL}`);
          socket.end();
          return;
        }
        stage = 'ready';
        socket.write(`${NL}Welcome to Jasmin 0.11.1 console${NL}Type help or ? to list commands.${NL}${NL}Session ref: 7${NL}jcli : `);
        return;
      }
      commands.push(line);
      if (session) {
        const [key, ...rest] = line.split(' ');
        const value = rest.join(' ');
        if (line === 'ko') {
          session = null;
          return reply(line);
        }
        if (line === 'ok') {
          if (session.kind === 'group' && session.keys.gid) {
            const gid = session.keys.gid;
            session = null;
            return reply(line, `Successfully added Group [${gid}]`);
          }
          if (session.kind === 'mtroute') return reply(line, 'You must set these options before saving: order, type, filters, connector, rate');
          session = null;
          return reply(line, 'Successfully added');
        }
        if (session.kind === 'mtroute' && key === 'connector' && value === 'smppc(nope)') return reply(line, 'Unknown smppc cid: nope');
        if (session.kind === 'user' && key === 'badkey') return reply(line, 'Unknown User key: badkey');
        session.keys[key] = value;
        return reply(line);
      }
      if (line === 'group -a') {
        session = { kind: 'group', keys: {} };
        return reply(line, 'Adding a new Group: (ok: save, ko: exit)');
      }
      if (line === 'user -a') {
        session = { kind: 'user', keys: {} };
        return reply(line, 'Adding a new User: (ok: save, ko: exit)');
      }
      if (line === 'mtrouter -a') {
        session = { kind: 'mtroute', keys: {} };
        return reply(line, 'Adding a new MT Route: (ok: save, ko: exit)');
      }
      if (line === 'user -r nope') return reply(line, 'Unknown User: nope');
      if (JCLI_0_11_1[line]) {
        // Replay the exact recorded bytes (they already contain the echo and the prompt).
        socket.write(JCLI_0_11_1[line]);
        return;
      }
      reply(line, `Incorrect command: ${line}, type help for a list of commands`);
    }
  });
  return { server, commands };
}

describe('jCLI parsing helpers (real Jasmin 0.11.1 output)', () => {
  test('cleanOutput strips the echoed command, carriage returns and the prompt', () => {
    const out = cleanOutput(JCLI_0_11_1['group -l'], 'group -l');
    assert.ok(!out.includes('jcli :'));
    assert.ok(!out.includes('\r'));
    assert.ok(out.startsWith('#Group id'));
  });

  test('parseTable keeps values containing spaces (filter descriptions, "ND (!)")', () => {
    const rows = parseTable(cleanOutput(JCLI_0_11_1['filter -l']), ['Filter id', 'Type', 'Routes', 'Description']);
    const da = rows.find((r) => r[0] === 'eg_vodafone')!;
    assert.deepEqual(da, ['eg_vodafone', 'DestinationAddrFilter', 'MO MT', '<DA (dst_addr=^2010)>']);
    const transparent = rows.find((r) => r[1] === 'TransparentFilter')!;
    assert.equal(transparent[3], '<T>');
  });

  test('parseTable handles columns separated by a single space (mtrouter -l)', () => {
    const rows = parseTable(cleanOutput(JCLI_0_11_1['mtrouter -l']), ['Order', 'Type', 'Rate', 'Connector ID(s)', 'Filter(s)']);
    const rr = rows.find((r) => r[1] === 'RandomRoundrobinMTRoute');
    assert.ok(rr, 'RandomRoundrobinMTRoute row parsed');
    assert.equal(rr![1], 'RandomRoundrobinMTRoute');
    assert.match(rr![2], /^0\.\d+/);
  });

  test('splitList splits on top-level commas only', () => {
    assert.deepEqual(splitList('smppc(a), smppc(b)'), ['smppc(a)', 'smppc(b)']);
    assert.deepEqual(splitList('<DA (dst_addr=^1,2)>, <T>'), ['<DA (dst_addr=^1,2)>', '<T>']);
    assert.deepEqual(splitList(''), []);
  });

  test('filterValueFromDescription extracts values for every filter shape', () => {
    assert.equal(filterValueFromDescription('<DA (dst_addr=^2010\\d+)>'), '^2010\\d+');
    assert.equal(filterValueFromDescription('<SM (msg=code \\d+)>'), 'code \\d+');
    assert.equal(filterValueFromDescription('<TI (08:00:00,18:00:00)>'), '08:00:00;18:00:00');
    assert.equal(filterValueFromDescription('<T>'), '');
  });
});

describe('JCliClient against a protocol-faithful fake console', () => {
  let fake: ReturnType<typeof fakeJcli>;
  let port: number;
  const client = (password = 'jclipwd') => new JCliClient({ host: '127.0.0.1', port, username: 'jcliadmin', password, commandTimeoutMs: 2000, connectTimeoutMs: 2000 });

  before(async () => {
    fake = fakeJcli();
    await new Promise<void>((r) => fake.server.listen(0, '127.0.0.1', () => r()));
    port = (fake.server.address() as net.AddressInfo).port;
  });
  after(() => fake.server.close());

  test('logs in without a Username: prompt and reads the version banner', async () => {
    const c = client();
    await c.connect();
    assert.equal(c.version, '0.11.1');
    c.disconnect();
  });

  test('rejects bad credentials', async () => {
    await assert.rejects(client('wrong').connect(), /authentication failed/i);
  });

  test('parses users, normalising "ND (!)" to ND', async () => {
    const c = client();
    const users = await c.getUsers();
    const acme = users.find((u) => u.uid === 'acme_otp')!;
    assert.equal(acme.gid, 'retail');
    assert.equal(acme.username, 'acme');
    assert.equal(typeof acme.balance, 'number');
    const bank = users.find((u) => u.uid === 'bank_alerts')!;
    assert.equal(bank.balance, 'ND');
    assert.equal(bank.mtSmsQuota, 'ND');
    c.disconnect();
  });

  test('merges smppccm -l with stats --smppcs', async () => {
    const c = client();
    const conns = await c.getSmppConnectors();
    const a = conns.find((x) => x.cid === 'carrier_a')!;
    assert.equal(a.service, 'started');
    assert.equal(a.session, 'BOUND_TRX');
    assert.match(a.boundAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.match(a.submits, /^\d+\/\d+$/);
    c.disconnect();
  });

  test('parses MT routes with multiple connectors and filter descriptions', async () => {
    const c = client();
    const routes = await c.getMtRoutes();
    const failover = routes.find((r) => r.type === 'FailoverMTRoute')!;
    assert.deepEqual(failover.connectors, ['smppc(carrier_b)', 'smppc(carrier_c)']);
    assert.deepEqual(failover.filters, ['<DA (dst_addr=^2012)>']);
    const def = routes.find((r) => r.order === 0)!;
    assert.equal(def.type, 'DefaultRoute');
    assert.deepEqual(def.filters, []);
    c.disconnect();
  });

  test('parses MO routes with http() connectors', async () => {
    const c = client();
    const routes = await c.getMoRoutes();
    assert.deepEqual(routes[0].connectors, ['http(crm_inbound)']);
    c.disconnect();
  });

  test('parses stats (httpapi and smppsapi)', async () => {
    const c = client();
    const s = await c.getStats();
    assert.ok(s.httpApi.requestCount > 0);
    assert.equal(typeof s.smppsApi.boundTrxCount, 'number');
    c.disconnect();
  });

  test('add session succeeds', async () => {
    const c = client();
    await c.createGroup('g_test');
    c.disconnect();
  });

  test('add session surfaces the jCLI error and aborts with ko', async () => {
    const c = client();
    fake.commands.length = 0;
    await assert.rejects(c.createMtRoute('StaticMTRoute', 0, 'smppc(nope)', 50, ['match_all']), (err: any) => {
      assert.ok(err instanceof JCliError);
      assert.match(err.message, /Unknown smppc cid: nope/);
      return true;
    });
    assert.equal(fake.commands.at(-1), 'ko', 'session aborted so the console returns to the main prompt');
    // The console is usable afterwards.
    const groups = await c.getGroups();
    assert.ok(groups.length > 0);
    c.disconnect();
  });

  test('concurrent calls never interleave inside an add session', async () => {
    const c = client();
    fake.commands.length = 0;
    await Promise.all([c.createGroup('g_a'), c.getUsers(), c.createGroup('g_b'), c.getGroups()]);
    const cmds = fake.commands;
    const start = cmds.indexOf('group -a');
    assert.deepEqual(cmds.slice(start, start + 3), ['group -a', 'gid g_a', 'ok']);
    const second = cmds.indexOf('group -a', start + 1);
    assert.deepEqual(cmds.slice(second, second + 3), ['group -a', 'gid g_b', 'ok']);
    c.disconnect();
  });

  test('remove reports the jCLI error', async () => {
    const c = client();
    await assert.rejects(c.deleteUser('nope'), /Unknown User: nope/);
    c.disconnect();
  });
});
