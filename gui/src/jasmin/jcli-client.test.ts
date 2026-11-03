import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as net from 'node:net';
import { JCliClient } from './jcli-client.js';

describe('JCliClient Unit & Mock Integration Tests', () => {
  let mockServer: net.Server;
  let mockPort: number;

  before(async () => {
    mockServer = net.createServer((socket) => {
      let stage = 0;
      socket.write('\xff\xfd"\xff\xfd\x1fAuthentication required.\r\nUsername: ');

      socket.on('data', (data) => {
        const str = data.toString();
        if (stage === 0 && str.includes('jcliadmin')) {
          stage = 1;
          socket.write('Password: ');
        } else if (stage === 1 && str.includes('jclipwd')) {
          stage = 2;
          socket.write('Welcome to Jasmin 0.11.1 console\r\njcli : ');
        } else if (stage === 1 && str.includes('wrongpwd')) {
          socket.write('Authentication failed: Incorrect Username/Password.\r\n');
          socket.end();
        } else if (stage === 2) {
          const cmd = str.trim();
          if (cmd === 'user -l') {
            socket.write(
              '#User id     Group id     Username     Balance   MT SMS Quota   Throughput\r\n' +
              '#user_01     default      client1      100.5     ND             ND\r\n' +
              '#user_02     premium      client2      500.0     1000           50/s\r\n' +
              'jcli : '
            );
          } else if (cmd === 'group -l') {
            socket.write(
              '#Group id\r\n' +
              '#default\r\n' +
              '#premium\r\n' +
              'jcli : '
            );
          } else if (cmd === 'httpccm -l') {
            socket.write(
              '#Httpcc id   Type      Method  Url\r\n' +
              '#hook_01     HttpCC    POST    https://api.example.com/sms/callback\r\n' +
              'jcli : '
            );
          } else if (cmd === 'group -a') {
            socket.write('jcli (group-add) : ');
          } else if (cmd.startsWith('gid ')) {
            socket.write('jcli (group-add) : ');
          } else if (cmd === 'ok') {
            socket.write('Successfully added group\r\njcli : ');
          } else {
            socket.write('Unknown command\r\njcli : ');
          }
        }
      });
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => {
        const addr = mockServer.address() as net.AddressInfo;
        mockPort = addr.port;
        resolve();
      });
    });
  });

  after(() => {
    mockServer.close();
  });

  test('successfully connects and authenticates to jCLI', async () => {
    const client = new JCliClient({
      host: '127.0.0.1',
      port: mockPort,
      username: 'jcliadmin',
      password: 'jclipwd'
    });

    await client.connect();
    const res = await client.executeCommand('help');
    assert.match(res, /Unknown command/);
    client.disconnect();
  });

  test('rejects connection immediately on bad credentials', async () => {
    const client = new JCliClient({
      host: '127.0.0.1',
      port: mockPort,
      username: 'jcliadmin',
      password: 'wrongpwd'
    });

    await assert.rejects(
      async () => {
        await client.connect();
      },
      /Authentication failed/
    );
    client.disconnect();
  });

  test('parses user list into structured JSON objects', async () => {
    const client = new JCliClient({
      host: '127.0.0.1',
      port: mockPort,
      username: 'jcliadmin',
      password: 'jclipwd'
    });

    const users = await client.getUsers();
    assert.equal(users.length, 2);
    assert.equal(users[0]?.uid, 'user_01');
    assert.equal(users[0]?.gid, 'default');
    assert.equal(users[0]?.username, 'client1');
    assert.equal(users[0]?.balance, 100.5);
    assert.equal(users[1]?.uid, 'user_02');
    assert.equal(users[1]?.balance, 500);
    client.disconnect();
  });

  test('parses group list into structured JSON objects', async () => {
    const client = new JCliClient({
      host: '127.0.0.1',
      port: mockPort,
      username: 'jcliadmin',
      password: 'jclipwd'
    });

    const groups = await client.getGroups();
    assert.equal(groups.length, 2);
    assert.equal(groups[0]?.gid, 'default');
    assert.equal(groups[1]?.gid, 'premium');
    client.disconnect();
  });

  test('parses HTTP connectors list correctly', async () => {
    const client = new JCliClient({
      host: '127.0.0.1',
      port: mockPort,
      username: 'jcliadmin',
      password: 'jclipwd'
    });

    const connectors = await client.getHttpConnectors();
    assert.equal(connectors.length, 1);
    assert.equal(connectors[0]?.cid, 'hook_01');
    assert.equal(connectors[0]?.method, 'POST');
    assert.equal(connectors[0]?.url, 'https://api.example.com/sms/callback');
    client.disconnect();
  });

  test('creates new group via interactive jCLI commands', async () => {
    const client = new JCliClient({
      host: '127.0.0.1',
      port: mockPort,
      username: 'jcliadmin',
      password: 'jclipwd'
    });

    const success = await client.createGroup('enterprise');
    assert.equal(success, true);
    client.disconnect();
  });
});
