import * as net from 'net';
import {
  JasminUser,
  JasminGroup,
  JasminHttpConnector,
  JasminSmppConnector,
  JasminMoRoute,
  JasminMtRoute,
  JasminHttpApiStats,
  JasminSmppsApiStats
} from './types.js';

export interface JCliConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
}

export class JCliClient {
  private config: JCliConfig;
  private socket: net.Socket | null = null;
  private isConnected = false;
  private commandQueue: Array<{
    cmd: string;
    resolve: (res: string) => void;
    reject: (err: Error) => void;
  }> = [];
  private isProcessing = false;
  private buffer = '';

  constructor(config: JCliConfig) {
    this.config = config;
  }

  public async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      this.socket = socket;

      let authStage = 0;
      let initTimeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Connection to jCLI at ${this.config.host}:${this.config.port} timed out.`));
      }, 8000);

      socket.connect(this.config.port, this.config.host, () => {
        // Connected at TCP level, awaiting telnet banner
      });

      socket.on('data', (data) => {
        const text = data.toString('utf-8');
        this.buffer += text;

        if (authStage === 0 && (text.includes('Authentication required') || text.includes('Username:'))) {
          authStage = 1;
          socket.write(`${this.config.username}\n`);
          this.buffer = '';
        } else if (authStage === 1 && text.includes('Password:')) {
          authStage = 2;
          socket.write(`${this.config.password || ''}\n`);
          this.buffer = '';
        } else if (authStage === 2 && (text.includes('Welcome to Jasmin') || text.includes('jcli :'))) {
          authStage = 3;
          this.isConnected = true;
          clearTimeout(initTimeout);
          this.buffer = '';
          resolve();
        }
      });

      socket.on('error', (err) => {
        clearTimeout(initTimeout);
        this.isConnected = false;
        reject(err);
      });

      socket.on('close', () => {
        this.isConnected = false;
        this.socket = null;
      });
    });
  }

  public async executeCommand(command: string): Promise<string> {
    if (!this.isConnected || !this.socket) {
      await this.connect();
    }

    return new Promise((resolve, reject) => {
      this.commandQueue.push({ cmd: command, resolve, reject });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.commandQueue.length === 0) return;
    this.isProcessing = true;

    const current = this.commandQueue.shift()!;
    try {
      const output = await this.sendSingleCommand(current.cmd);
      current.resolve(output);
    } catch (err: any) {
      current.reject(err);
    } finally {
      this.isProcessing = false;
      this.processQueue();
    }
  }

  private sendSingleCommand(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('Socket not connected'));

      let collected = '';
      const onData = (chunk: Buffer) => {
        collected += chunk.toString('utf-8');
        // Check if command finished and prompt returned
        if (collected.includes('jcli :') || collected.includes('> ')) {
          this.socket?.removeListener('data', onData);
          resolve(collected);
        }
      };

      this.socket.on('data', onData);
      this.socket.write(`${command}\n`);

      setTimeout(() => {
        this.socket?.removeListener('data', onData);
        resolve(collected);
      }, 3500);
    });
  }

  // --- High Level API Methods ---

  public async getUsers(): Promise<JasminUser[]> {
    const output = await this.executeCommand('user -l');
    const users: JasminUser[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('#') || trimmed.startsWith('#User id')) continue;
      // Example: #user_01 customer_group client1 50.0 ND ND/ND
      const parts = trimmed.substring(1).trim().split(/\s+/);
      if (parts.length >= 4) {
        users.push({
          uid: parts[0],
          gid: parts[1],
          username: parts[2],
          balance: isNaN(Number(parts[3])) ? parts[3] : Number(parts[3]),
          mtSmsQuota: parts[4] || 'ND',
          throughput: parts[5] || 'ND'
        });
      }
    }
    return users;
  }

  public async getGroups(): Promise<JasminGroup[]> {
    const output = await this.executeCommand('group -l');
    const groups: JasminGroup[] = [];
    const lines = output.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('#') || trimmed.startsWith('#Group id')) continue;
      const gid = trimmed.substring(1).trim();
      if (gid) groups.push({ gid });
    }
    return groups;
  }

  public async createGroup(gid: string): Promise<boolean> {
    await this.executeCommand('group -a');
    await this.executeCommand(`gid ${gid}`);
    const res = await this.executeCommand('ok');
    return res.includes('Successfully added');
  }

  public async createUser(user: {
    uid: string;
    gid: string;
    username: string;
    password: string;
    balance?: number;
    httpThroughput?: number;
  }): Promise<boolean> {
    await this.executeCommand('user -a');
    await this.executeCommand(`uid ${user.uid}`);
    await this.executeCommand(`gid ${user.gid}`);
    await this.executeCommand(`username ${user.username}`);
    await this.executeCommand(`password ${user.password}`);
    await this.executeCommand('mt_messaging_cred authorization http_send 1');
    await this.executeCommand('mt_messaging_cred authorization http_balance 1');
    await this.executeCommand('mt_messaging_cred authorization smpps_send 1');
    if (user.balance !== undefined) {
      await this.executeCommand(`mt_messaging_cred quota balance ${user.balance}`);
    }
    if (user.httpThroughput !== undefined) {
      await this.executeCommand(`mt_messaging_cred quota http_throughput ${user.httpThroughput}`);
    }
    const res = await this.executeCommand('ok');
    return res.includes('Successfully added');
  }

  public async deleteUser(uid: string): Promise<boolean> {
    const res = await this.executeCommand(`user -r ${uid}`);
    return res.includes('Successfully removed') || !res.includes('Error');
  }

  public async getHttpConnectors(): Promise<JasminHttpConnector[]> {
    const output = await this.executeCommand('httpccm -l');
    const connectors: JasminHttpConnector[] = [];
    const lines = output.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('#') || trimmed.startsWith('#Httpcc id')) continue;
      const parts = trimmed.substring(1).trim().split(/\s+/);
      if (parts.length >= 4) {
        connectors.push({
          cid: parts[0],
          type: parts[1],
          method: parts[2],
          url: parts.slice(3).join(' ')
        });
      }
    }
    return connectors;
  }

  public async createHttpConnector(cid: string, url: string, method = 'POST'): Promise<boolean> {
    await this.executeCommand('httpccm -a');
    await this.executeCommand(`cid ${cid}`);
    await this.executeCommand(`url ${url}`);
    await this.executeCommand(`method ${method.toUpperCase()}`);
    const res = await this.executeCommand('ok');
    return res.includes('Successfully added');
  }

  public async getMoRoutes(): Promise<JasminMoRoute[]> {
    const output = await this.executeCommand('morouter -l');
    const routes: JasminMoRoute[] = [];
    const lines = output.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('#') || trimmed.startsWith('#Order')) continue;
      const parts = trimmed.substring(1).trim().split(/\s+/);
      if (parts.length >= 3) {
        routes.push({
          order: parseInt(parts[0], 10),
          type: parts[1],
          connector: parts[2],
          filters: parts.slice(3)
        });
      }
    }
    return routes;
  }

  public async createMoRoute(type: string, connector: string, order = 0): Promise<boolean> {
    await this.executeCommand('morouter -a');
    await this.executeCommand(`type ${type}`);
    if (type !== 'DefaultRoute') {
      await this.executeCommand(`order ${order}`);
    }
    await this.executeCommand(`connector ${connector}`);
    const res = await this.executeCommand('ok');
    return res.includes('Successfully added');
  }

  public async getMtRoutes(): Promise<JasminMtRoute[]> {
    const output = await this.executeCommand('mtrouter -l');
    const routes: JasminMtRoute[] = [];
    const lines = output.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('#') || trimmed.startsWith('#Order')) continue;
      const parts = trimmed.substring(1).trim().split(/\s+/);
      if (parts.length >= 4) {
        routes.push({
          order: parseInt(parts[0], 10),
          type: parts[1],
          rate: parseFloat(parts[2]),
          connector: parts[3],
          filters: parts.slice(4)
        });
      }
    }
    return routes;
  }

  public async getStats(): Promise<{
    httpApi: JasminHttpApiStats;
    smppsApi: JasminSmppsApiStats;
  }> {
    const httpOutput = await this.executeCommand('stats --httpapi');
    const smppOutput = await this.executeCommand('stats --smppsapi');

    const parseKeyValue = (out: string): Record<string, string> => {
      const map: Record<string, string> = {};
      for (const line of out.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#') && !trimmed.startsWith('#Item')) {
          const [k, ...v] = trimmed.substring(1).split(/\s+/);
          if (k) map[k] = v.join(' ');
        }
      }
      return map;
    };

    const hMap = parseKeyValue(httpOutput);
    const sMap = parseKeyValue(smppOutput);

    return {
      httpApi: {
        createdAt: hMap['created_at'] || 'ND',
        requestCount: parseInt(hMap['request_count'] || '0', 10),
        lastRequestAt: hMap['last_request_at'] || 'ND',
        authErrorCount: parseInt(hMap['auth_error_count'] || '0', 10),
        routeErrorCount: parseInt(hMap['route_error_count'] || '0', 10),
        interceptorErrorCount: parseInt(hMap['interceptor_error_count'] || '0', 10),
        throughputErrorCount: parseInt(hMap['throughput_error_count'] || '0', 10),
        chargingErrorCount: parseInt(hMap['charging_error_count'] || '0', 10),
        serverErrorCount: parseInt(hMap['server_error_count'] || '0', 10),
        successCount: parseInt(hMap['success_count'] || '0', 10),
        lastSuccessAt: hMap['last_success_at'] || 'ND'
      },
      smppsApi: {
        createdAt: sMap['created_at'] || 'ND',
        connectedCount: parseInt(sMap['connected_count'] || '0', 10),
        boundTrxCount: parseInt(sMap['bound_trx_count'] || '0', 10),
        boundRxCount: parseInt(sMap['bound_rx_count'] || '0', 10),
        boundTxCount: parseInt(sMap['bound_tx_count'] || '0', 10),
        submitSmCount: parseInt(sMap['submit_sm_count'] || '0', 10),
        deliverSmCount: parseInt(sMap['deliver_sm_count'] || '0', 10),
        throttlingErrorCount: parseInt(sMap['throttling_error_count'] || '0', 10),
        otherSubmitErrorCount: parseInt(sMap['other_submit_error_count'] || '0', 10)
      }
    };
  }

  public async persist(): Promise<string> {
    return await this.executeCommand('persist');
  }

  public async load(): Promise<string> {
    return await this.executeCommand('load');
  }

  public disconnect(): void {
    if (this.socket) {
      this.socket.end();
      this.socket.destroy();
      this.socket = null;
      this.isConnected = false;
    }
  }
}
