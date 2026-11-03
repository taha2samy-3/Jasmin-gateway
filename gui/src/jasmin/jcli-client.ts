import * as net from 'net';
import {
  JasminUser,
  JasminGroup,
  JasminHttpConnector,
  JasminSmppConnector,
  JasminMoRoute,
  JasminMtRoute,
  JasminHttpApiStats,
  JasminSmppsApiStats,
  JasminFilter,
  JasminInterceptor
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
        } else if (text.includes('Incorrect') || text.includes('Authentication failed')) {
          clearTimeout(initTimeout);
          socket.destroy();
          reject(new Error('jCLI Authentication failed: Incorrect Username or Password'));
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
        if (collected.includes('jcli :') || collected.includes('jcli (') || collected.includes('> ')) {
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
    mtSmsQuota?: number;
  }): Promise<boolean> {
    await this.executeCommand('user -a');
    await this.executeCommand(`uid ${user.uid}`);
    await this.executeCommand(`gid ${user.gid}`);
    await this.executeCommand(`username ${user.username}`);
    await this.executeCommand(`password ${user.password}`);
    await this.executeCommand('mt_messaging_cred authorization http_send 1');
    await this.executeCommand('mt_messaging_cred authorization http_balance 1');
    await this.executeCommand('mt_messaging_cred authorization smpps_send 1');
    await this.executeCommand('smpps_cred authorization bind 1');
    if (user.balance !== undefined) {
      await this.executeCommand(`mt_messaging_cred quota balance ${user.balance}`);
    }
    if (user.mtSmsQuota !== undefined) {
      await this.executeCommand(`mt_messaging_cred quota sms_count ${user.mtSmsQuota}`);
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

  public async deleteHttpConnector(cid: string): Promise<boolean> {
    const res = await this.executeCommand(`httpccm -r ${cid}`);
    return res.includes('Successfully removed');
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

  public async createMoRoute(type: string, connector: string, order = 0, filters: string[] = []): Promise<boolean> {
    await this.executeCommand('morouter -a');
    await this.executeCommand(`type ${type}`);
    if (type !== 'DefaultRoute') {
      const assignedOrder = order > 0 ? order : 10;
      await this.executeCommand(`order ${assignedOrder}`);
    }
    await this.executeCommand(`connector ${connector}`);
    if (type !== 'DefaultRoute' && filters && filters.length > 0) {
      await this.executeCommand(`filters ${filters.join(';')}`);
    }
    const res = await this.executeCommand('ok');
    if (!res.includes('Successfully added')) {
      await this.executeCommand('ko');
      return false;
    }
    return true;
  }

  public async deleteMoRoute(order: number): Promise<boolean> {
    const res = await this.executeCommand(`morouter -r ${order}`);
    return res.includes('Successfully removed');
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

  public async getSmppConnectors(): Promise<any[]> {
    const output = await this.executeCommand('smppccm -l');
    const connectors: any[] = [];
    const lines = output.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('#') || trimmed.startsWith('#Connector id')) continue;
      const parts = trimmed.substring(1).trim().split(/\s+/);
      if (parts.length >= 5) {
        connectors.push({
          cid: parts[0],
          service: parts[1],
          session: parts[2],
          starts: parseInt(parts[3], 10),
          stops: parseInt(parts[4], 10)
        });
      }
    }
    return connectors;
  }

  public async createSmppConnector(conn: {
    cid: string;
    host: string;
    port: number;
    username: string;
    password: string;
    systemType?: string;
    bind?: string;
  }): Promise<boolean> {
    await this.executeCommand('smppccm -a');
    await this.executeCommand(`cid ${conn.cid}`);
    await this.executeCommand(`host ${conn.host}`);
    await this.executeCommand(`port ${conn.port}`);
    await this.executeCommand(`username ${conn.username}`);
    await this.executeCommand(`password ${conn.password}`);
    if (conn.systemType) {
      await this.executeCommand(`system_type ${conn.systemType}`);
    }
    if (conn.bind) {
      await this.executeCommand(`bind ${conn.bind}`);
    }
    const res = await this.executeCommand('ok');
    return res.includes('Successfully added');
  }

  public async startSmppConnector(cid: string): Promise<boolean> {
    const res = await this.executeCommand(`smppccm -1 ${cid}`);
    return !res.includes('Error');
  }

  public async stopSmppConnector(cid: string): Promise<boolean> {
    const res = await this.executeCommand(`smppccm -0 ${cid}`);
    return !res.includes('Error');
  }

  public async deleteSmppConnector(cid: string): Promise<boolean> {
    const res = await this.executeCommand(`smppccm -r ${cid}`);
    return res.includes('Successfully removed');
  }

  public async createMtRoute(type: string, rate: number, connector: string, order = 0, filters: string[] = []): Promise<boolean> {
    await this.executeCommand('mtrouter -a');
    await this.executeCommand(`type ${type}`);
    await this.executeCommand(`rate ${rate}`);
    if (type !== 'DefaultRoute') {
      const assignedOrder = order > 0 ? order : 10;
      await this.executeCommand(`order ${assignedOrder}`);
    }
    await this.executeCommand(`connector ${connector}`);
    if (type !== 'DefaultRoute' && filters && filters.length > 0) {
      await this.executeCommand(`filters ${filters.join(';')}`);
    }
    const res = await this.executeCommand('ok');
    if (!res.includes('Successfully added')) {
      await this.executeCommand('ko');
      return false;
    }
    return true;
  }

  public async deleteMtRoute(order: number): Promise<boolean> {
    const res = await this.executeCommand(`mtrouter -r ${order}`);
    return res.includes('Successfully removed');
  }

  // --- Filters Management (filtersm) ---

  public async getFilters(): Promise<JasminFilter[]> {
    const output = await this.executeCommand('filter -l');
    const filters: JasminFilter[] = [];
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('#') || trimmed.startsWith('#Filter id')) continue;
      const parts = trimmed.substring(1).trim().split(/\s+/);
      if (parts.length >= 2) {
        const fid = parts[0];
        const type = parts[1];
        let routes = '';
        let descIdx = 2;
        if (parts[2] === 'MO' && parts[3] === 'MT') {
          routes = 'MO MT';
          descIdx = 4;
        } else if (parts[2] === 'MO' || parts[2] === 'MT') {
          routes = parts[2];
          descIdx = 3;
        }
        const description = parts.slice(descIdx).join(' ');
        filters.push({ fid, type, routes, description });
      }
    }
    return filters;
  }

  public async createFilter(fid: string, type: string, paramKey: string, paramValue: string): Promise<boolean> {
    await this.executeCommand('filter -a');
    await this.executeCommand(`fid ${fid}`);
    await this.executeCommand(`type ${type}`);
    if (paramKey && paramValue) {
      await this.executeCommand(`${paramKey} ${paramValue}`);
    }
    const res = await this.executeCommand('ok');
    return res.includes('Successfully added');
  }

  public async deleteFilter(fid: string): Promise<boolean> {
    const res = await this.executeCommand(`filter -r ${fid}`);
    return res.includes('Successfully removed');
  }

  // --- Interceptors Management (interceptorm) ---

  public async getMtInterceptors(): Promise<JasminInterceptor[]> {
    const output = await this.executeCommand('mtinterceptor -l');
    return this.parseInterceptors(output);
  }

  public async getMoInterceptors(): Promise<JasminInterceptor[]> {
    const output = await this.executeCommand('mointerceptor -l');
    return this.parseInterceptors(output);
  }

  private parseInterceptors(output: string): JasminInterceptor[] {
    const interceptors: JasminInterceptor[] = [];
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('#') || trimmed.startsWith('#Order')) continue;
      const parts = trimmed.substring(1).trim().split(/\s+/);
      if (parts.length >= 3) {
        interceptors.push({
          order: parseInt(parts[0], 10),
          type: parts[1],
          script: parts[2],
          filters: parts.slice(3)
        });
      }
    }
    return interceptors;
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
