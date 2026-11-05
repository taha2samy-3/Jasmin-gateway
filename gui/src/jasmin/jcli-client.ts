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
  /** Per-command timeout in ms (default 6000). */
  commandTimeoutMs?: number;
  /** TCP connect + login timeout in ms (default 8000). */
  connectTimeoutMs?: number;
}

/** Error raised when jCLI rejects a command; `output` carries the raw console text. */
export class JCliError extends Error {
  constructor(message: string, public readonly output = '') {
    super(message);
    this.name = 'JCliError';
  }
}

// Main prompt `jcli : ` and interactive-session prompt `> ` (both appear at the end of output).
const PROMPT_RE = /(?:^|\n)(?:jcli : |> )$/;
// Telnet IAC negotiation and terminal control sequences sent by Jasmin's console on connect.
const IAC_RE = /\xff[\xfb-\xfe][\s\S]|\xff[\xf0-\xfa]|\x1b(?:\[[0-9;]*[a-zA-Z]|c)/g;
// Error lines observed from Jasmin 0.11.1 jCLI.
const ERROR_RE =
  /^(?:Unknown .*|Error:.*|Invalid .*|You must .*|This route order .*|\[IO\].*|Incorrect .*|.* cannot .*|.* is not a valid .*|.* must contain .*|.* must be .*|Right border .*|Failed .*)$/m;

/**
 * Normalise a raw jCLI response: strip telnet noise and `\r`, drop the echoed command line
 * (jCLI echoes input) and the trailing prompt.
 */
export function cleanOutput(raw: string, command?: string): string {
  const lines = raw
    .replace(IAC_RE, '')
    .replace(/\r/g, '')
    .split('\n');
  if (command !== undefined && lines.length > 0 && lines[0].trim() === command.trim()) lines.shift();
  return lines
    .filter((l) => l.trim() !== '' && !/^(?:jcli : |> )\s*$/.test(l))
    .join('\n')
    .replace(/(?:jcli : |> )$/, '')
    .trim();
}

/**
 * Parse a jCLI list table. Jasmin left-justifies every column, so the start offset of each column
 * is the position of its label in the `#Header` line. Labels are passed explicitly because several
 * contain spaces ("Connector ID(s)", "MT SMS") and columns are sometimes separated by one space.
 * Values may contain spaces (dates, filter descriptions); a value longer than its column pushes the
 * following cells right, which is handled by snapping to the next token boundary.
 * Returns one array of trimmed cells per data row; header and "Total ..." footer are excluded.
 */
export function parseTable(output: string, labels: string[]): string[][] {
  const lines = output.replace(/\r/g, '').split('\n');
  const headerIdx = lines.findIndex((l) => l.trim().startsWith(`#${labels[0]}`));
  if (headerIdx === -1) return [];
  const header = lines[headerIdx].replace(/^\s+/, '');

  const starts: number[] = [];
  let from = 0;
  for (const label of labels) {
    const at = header.indexOf(label, from);
    if (at === -1) break;
    starts.push(label === labels[0] ? 0 : at);
    from = at + label.length;
  }

  const rows: string[][] = [];
  for (let li = headerIdx + 1; li < lines.length; li++) {
    const line = lines[li].replace(/^\s+/, '').replace(/\s+$/, '');
    if (!line.startsWith('#')) continue;
    const cells: string[] = [];
    let cursor = 0;
    for (let c = 0; c < starts.length; c++) {
      let start = Math.max(starts[c], cursor);
      // Previous value overflowed into this column: skip to the next token.
      if (start > 0 && start < line.length && line[start - 1] !== ' ') {
        const sp = line.indexOf(' ', start);
        start = sp === -1 ? line.length : sp;
      }
      const isLast = c === starts.length - 1;
      let end = isLast ? line.length : Math.max(starts[c + 1], start);
      // This value overflows into the next column: extend to the end of its token.
      if (!isLast && end < line.length && end > start && line[end - 1] !== ' ' && line[end] !== ' ') {
        const sp = line.indexOf(' ', end);
        end = sp === -1 ? line.length : sp;
      }
      cells.push(line.slice(start, end).trim());
      cursor = end;
    }
    cells[0] = (cells[0] ?? '').replace(/^#/, '');
    rows.push(cells);
  }
  return rows;
}

/** Split a jCLI list cell like "smppc(a), smppc(b)" or "<T>, <DA (dst_addr=^1)>" into items. */
export function splitList(cell: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of cell) {
    if (ch === '(' || ch === '<') depth++;
    if (ch === ')' || ch === '>') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      if (current.trim()) items.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

/**
 * Extract the parameter value from a jCLI filter description.
 * Examples: "<DA (dst_addr=^2010)>" -> "^2010", "<TI (08:00:00,18:00:00)>" -> "08:00:00;18:00:00", "<T>" -> "".
 */
export function filterValueFromDescription(description: string): string {
  const kv = description.match(/^<\w+ \((\w+)=(.*)\)>$/);
  if (kv) return kv[2];
  const interval = description.match(/^<(?:TI|DI) \((.*),(.*)\)>$/);
  if (interval) return `${interval[1]};${interval[2]}`;
  return '';
}

/**
 * Parse `mtrouter -l` / `morouter -l` rows by their structure rather than by column offsets:
 * `#<order> <Type> [<rate>] <type(cid)>[, <type(cid)>...] [<filter repr>, ...]`.
 * Jasmin pads the connector column to 48 characters but does not truncate it, so a list of
 * connectors wider than the column shifts the filters right; column slicing then splits a
 * connector into the filter cell. Connector tokens and filter reprs are unambiguous instead.
 */
export function parseRouteRows(output: string, withRate: boolean) {
  const rows: { order: number; type: string; rate: number; connectors: string[]; filters: string[] }[] = [];
  const rate = withRate ? String.raw`(0 \(!\)|-?[\d.]+)\s+` : '';
  const re = new RegExp(String.raw`^#(\d+)\s+(\S+)\s+${rate}((?:\w+\([^()]*\))(?:,\s*\w+\([^()]*\))*)\s*(.*)$`);
  for (const raw of output.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    const m = re.exec(line);
    if (!m) continue;
    const [, order, type, ...rest] = m;
    const rateText = withRate ? rest.shift()! : '0';
    const [connectorText, filterText] = rest;
    rows.push({
      order: parseInt(order, 10),
      type,
      rate: toNumber(rateText.replace(/\s*\(!\)/, '')),
      connectors: splitList(connectorText),
      filters: splitList(filterText.trim())
    });
  }
  return rows;
}

function toNumber(v: string | undefined): number {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export class JCliClient {
  private config: JCliConfig;
  private socket: net.Socket | null = null;
  private connected = false;
  private connecting: Promise<void> | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  private pending: { buffer: string; resolve: (s: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  /** Version string from the console banner, e.g. "0.11.1". */
  public version: string | null = null;
  public lastError: string | null = null;

  constructor(config: JCliConfig) {
    this.config = config;
  }

  public get isConnected(): boolean {
    return this.connected;
  }

  public connect(): Promise<void> {
    if (this.connected && this.socket) return Promise.resolve();
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = new net.Socket();
      let stage: 'banner' | 'password' | 'wait' | 'ready' = 'banner';
      let buf = '';
      const fail = (err: Error) => {
        clearTimeout(timer);
        this.lastError = err.message;
        socket.destroy();
        reject(err);
      };
      const timer = setTimeout(
        () => fail(new Error(`Connection to jCLI at ${this.config.host}:${this.config.port} timed out`)),
        this.config.connectTimeoutMs ?? 8000
      );

      socket.on('data', (chunk) => {
        const text = chunk.toString('utf-8').replace(IAC_RE, '');
        if (stage === 'ready') {
          this.onData(text);
          return;
        }
        buf += text;
        const banner = buf.match(/Welcome to Jasmin ([\w.\-]+)/);
        if (banner) this.version = banner[1];

        if (/Incorrect|Authentication failed/i.test(buf)) {
          fail(new JCliError('jCLI authentication failed: incorrect username or password', buf));
        } else if (stage === 'banner' && /Authentication required|Username:\s*$/.test(buf)) {
          // Jasmin 0.11 prints "Authentication required." and then waits for the username without a prompt.
          stage = 'password';
          buf = '';
          socket.write(`${this.config.username}\r\n`);
        } else if (stage === 'password' && /Password:\s*$/.test(buf)) {
          stage = 'wait';
          buf = '';
          socket.write(`${this.config.password ?? ''}\r\n`);
        } else if (/jcli : $/.test(buf)) {
          stage = 'ready';
          clearTimeout(timer);
          this.socket = socket;
          this.connected = true;
          this.lastError = null;
          resolve();
        }
      });

      socket.on('error', (err) => fail(err));
      socket.on('close', () => {
        this.connected = false;
        this.socket = null;
        if (this.pending) {
          clearTimeout(this.pending.timer);
          this.pending.reject(new Error('jCLI connection closed'));
          this.pending = null;
        }
      });

      socket.connect(this.config.port, this.config.host);
    }).finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  private onData(text: string) {
    if (!this.pending) return;
    this.pending.buffer += text;
    if (PROMPT_RE.test(this.pending.buffer.replace(/\r/g, ''))) {
      const { buffer, resolve, timer } = this.pending;
      clearTimeout(timer);
      this.pending = null;
      resolve(buffer);
    }
  }

  /** Send one line and wait for the next prompt. Must be called while holding the lock. */
  private async send(command: string): Promise<string> {
    await this.connect();
    const socket = this.socket;
    if (!socket) throw new Error('jCLI socket not connected');
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        // The console state is unknown after a timeout: drop the session so the next call starts clean.
        this.disconnect();
        reject(new Error(`jCLI command timed out: ${command.split(' ')[0]}`));
      }, this.config.commandTimeoutMs ?? 6000);
      this.pending = { buffer: '', resolve, reject, timer };
      socket.write(`${command}\r\n`);
    });
  }

  /** Run `fn` with exclusive access to the console (multi-line sessions must not interleave). */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  /** Execute a single command and return its cleaned output. */
  public executeCommand(command: string): Promise<string> {
    return this.exclusive(async () => cleanOutput(await this.send(command), command));
  }

  /**
   * Run an interactive add session (`user -a`, `filter -a`, ...). Every line is checked for a jCLI
   * error; on failure the session is aborted with `ko` so the console returns to the main prompt.
   */
  private addSession(open: string, lines: string[], successText = 'Successfully added'): Promise<string> {
    return this.exclusive(async () => {
      const opened = cleanOutput(await this.send(open), open);
      if (ERROR_RE.test(opened)) throw new JCliError(this.firstError(opened), opened);
      try {
        for (const line of lines) {
          const out = cleanOutput(await this.send(line), line);
          if (out && ERROR_RE.test(out)) throw new JCliError(`${line.split(' ')[0]}: ${this.firstError(out)}`, out);
        }
        const done = cleanOutput(await this.send('ok'), 'ok');
        if (!done.includes(successText)) throw new JCliError(this.firstError(done) || 'jCLI rejected the entry', done);
        return done;
      } catch (err) {
        await this.send('ko').catch(() => undefined);
        throw err;
      }
    });
  }

  private firstError(out: string): string {
    const m = out.match(ERROR_RE);
    return (m ? m[0] : out.split('\n')[0] || '').trim();
  }

  private async removeEntity(command: string, what: string): Promise<void> {
    const out = await this.executeCommand(command);
    if (!/Successfully removed/i.test(out)) {
      throw new JCliError(`Could not remove ${what}: ${this.firstError(out) || out}`, out);
    }
  }

  // --- Users & groups -------------------------------------------------------

  public async getUsers(): Promise<JasminUser[]> {
    const rows = parseTable(await this.executeCommand('user -l'), ['User id', 'Group id', 'Username', 'Balance', 'MT SMS', 'Throughput']);
    return rows
      .filter((r) => r[0])
      .map((r) => {
        // "ND (!)" means "not defined" (unlimited); jCLI adds "(!)" as a warning marker.
        const nd = (v?: string) => (v ?? 'ND').replace(/\s*\(!\)\s*$/, '').trim() || 'ND';
        const balance = nd(r[3]);
        return {
          uid: r[0],
          gid: r[1] ?? '',
          username: r[2] ?? '',
          balance: balance !== 'ND' && !isNaN(Number(balance)) ? Number(balance) : balance,
          mtSmsQuota: nd(r[4]),
          throughput: nd(r[5])
        };
      });
  }

  public async getGroups(): Promise<JasminGroup[]> {
    const rows = parseTable(await this.executeCommand('group -l'), ['Group id']);
    return rows.filter((r) => r[0]).map((r) => ({ gid: r[0] }));
  }

  public async createGroup(gid: string): Promise<void> {
    await this.addSession('group -a', [`gid ${gid}`]);
  }

  public async deleteGroup(gid: string): Promise<void> {
    await this.removeEntity(`group -r ${gid}`, `group ${gid}`);
  }

  public async createUser(user: {
    uid: string;
    gid: string;
    username: string;
    password: string;
    balance?: number;
    httpThroughput?: number;
    mtSmsQuota?: number;
  }): Promise<void> {
    const lines = [`uid ${user.uid}`, `gid ${user.gid}`, `username ${user.username}`, `password ${user.password}`];
    if (user.balance !== undefined && Number.isFinite(user.balance)) lines.push(`mt_messaging_cred quota balance ${user.balance}`);
    if (user.mtSmsQuota !== undefined && Number.isFinite(user.mtSmsQuota)) lines.push(`mt_messaging_cred quota sms_count ${user.mtSmsQuota}`);
    if (user.httpThroughput !== undefined && Number.isFinite(user.httpThroughput)) {
      lines.push(`mt_messaging_cred quota http_throughput ${user.httpThroughput}`);
    }
    await this.addSession('user -a', lines);
  }

  /** Update an existing user with raw jCLI attribute lines (e.g. "mt_messaging_cred quota balance 10"). */
  public async updateUser(uid: string, lines: string[]): Promise<void> {
    await this.addSession(`user -u ${uid}`, lines, 'Successfully updated');
  }

  public async deleteUser(uid: string): Promise<void> {
    await this.removeEntity(`user -r ${uid}`, `user ${uid}`);
  }

  // --- Connectors -----------------------------------------------------------

  public async getHttpConnectors(): Promise<JasminHttpConnector[]> {
    const rows = parseTable(await this.executeCommand('httpccm -l'), ['Httpcc id', 'Type', 'Method', 'URL']);
    return rows
      .filter((r) => r[0])
      .map((r) => ({ cid: r[0], type: r[1] ?? '', method: r[2] ?? '', url: r.slice(3).join(' ').trim() }));
  }

  public async createHttpConnector(cid: string, url: string, method = 'POST'): Promise<void> {
    await this.addSession('httpccm -a', [`cid ${cid}`, `url ${url}`, `method ${method.toUpperCase()}`]);
  }

  public async deleteHttpConnector(cid: string): Promise<void> {
    await this.removeEntity(`httpccm -r ${cid}`, `HTTP connector ${cid}`);
  }

  /** SMPP client connectors merged with their per-connector counters (`stats --smppcs`). */
  public async getSmppConnectors(): Promise<JasminSmppConnector[]> {
    const listRows = parseTable(await this.executeCommand('smppccm -l'), ['Connector id', 'Service', 'Session', 'Starts', 'Stops']);
    let statRows: string[][] = [];
    try {
      statRows = parseTable(await this.executeCommand('stats --smppcs'), [
        'Connector id', 'Connected at', 'Bound at', 'Disconnected at', 'Submits', 'Delivers', 'QoS errs', 'Other errs'
      ]);
    } catch {
      statRows = [];
    }
    const stats = new Map(statRows.map((r) => [r[0], r]));

    return listRows
      .filter((r) => r[0])
      .map((r) => {
        const s = stats.get(r[0]) || [];
        const nd = (v?: string) => (v && v !== 'ND' ? v : '');
        return {
          cid: r[0],
          service: (r[1] ?? '').toLowerCase(),
          session: r[2] ?? '',
          starts: toNumber(r[3]),
          stops: toNumber(r[4]),
          connectedAt: nd(s[1]),
          boundAt: nd(s[2]),
          disconnectedAt: nd(s[3]),
          submits: s[4] ?? '0',
          delivers: s[5] ?? '0',
          qosErrors: toNumber(s[6]),
          otherErrors: toNumber(s[7])
        };
      });
  }

  public async createSmppConnector(conn: {
    cid: string;
    host: string;
    port: number;
    username: string;
    password: string;
    systemType?: string;
    bind?: string;
    /** Connector log file; '/dev/stdout' sends it to the container log. */
    logFile?: string;
  }): Promise<void> {
    const lines = [`cid ${conn.cid}`, `host ${conn.host}`, `port ${conn.port}`, `username ${conn.username}`, `password ${conn.password}`];
    if (conn.systemType) lines.push(`systype ${conn.systemType}`);
    if (conn.bind) lines.push(`bind ${conn.bind}`);
    if (conn.logFile) lines.push(`logfile ${conn.logFile}`);
    await this.addSession('smppccm -a', lines);
  }

  public async startSmppConnector(cid: string): Promise<void> {
    const out = await this.executeCommand(`smppccm -1 ${cid}`);
    if (!/Successfully started/i.test(out)) throw new JCliError(this.firstError(out) || out, out);
  }

  public async stopSmppConnector(cid: string): Promise<void> {
    const out = await this.executeCommand(`smppccm -0 ${cid}`);
    if (!/Successfully stopped/i.test(out)) throw new JCliError(this.firstError(out) || out, out);
  }

  public async deleteSmppConnector(cid: string): Promise<void> {
    await this.removeEntity(`smppccm -r ${cid}`, `SMPP connector ${cid}`);
  }

  // --- Routers ----------------------------------------------------------------

  public async getMoRoutes(): Promise<JasminMoRoute[]> {
    return parseRouteRows(await this.executeCommand('morouter -l'), false).map(({ order, type, connectors, filters }) => ({
      order,
      type,
      connector: connectors.join(';'),
      connectors,
      filters
    }));
  }

  public async getMtRoutes(): Promise<JasminMtRoute[]> {
    return parseRouteRows(await this.executeCommand('mtrouter -l'), true).map(({ order, type, rate, connectors, filters }) => ({
      order,
      type,
      rate,
      connector: connectors.join(';'),
      connectors,
      filters
    }));
  }

  private static typedConnector(c: string, fallbackType: 'smppc' | 'http'): string {
    const trimmed = c.trim();
    return /^(smppc|http|smpps)\(.+\)$/i.test(trimmed) ? trimmed : `${fallbackType}(${trimmed})`;
  }

  private static routeLines(
    type: string,
    order: number,
    connector: string | string[],
    filters: string[],
    fallbackType: 'smppc' | 'http'
  ): string[] {
    const lines = [`type ${type}`];
    if (type !== 'DefaultRoute') lines.push(`order ${order}`);
    const list = (Array.isArray(connector) ? connector : connector.split(/[;,]/)).map((c) => c.trim()).filter(Boolean);
    if (list.length === 0) throw new JCliError('A route needs at least one connector');
    const formatted = list.map((c) => JCliClient.typedConnector(c, fallbackType));
    if (/Failover|Roundrobin/i.test(type)) lines.push(`connectors ${formatted.join(';')}`);
    else lines.push(`connector ${formatted[0]}`);
    if (type !== 'DefaultRoute' && filters.length > 0) lines.push(`filters ${filters.join(';')}`);
    return lines;
  }

  public async createMoRoute(type: string, connector: string | string[], order = 0, filters: string[] = []): Promise<void> {
    await this.addSession('morouter -a', JCliClient.routeLines(type, order, connector, filters, 'http'));
  }

  public async deleteMoRoute(order: number): Promise<void> {
    await this.removeEntity(`morouter -r ${order}`, `MO route #${order}`);
  }

  public async createMtRoute(type: string, rate: number, connector: string | string[], order = 0, filters: string[] = []): Promise<void> {
    const lines = JCliClient.routeLines(type, order, connector, filters, 'smppc');
    lines.splice(1, 0, `rate ${Number.isFinite(rate) ? rate : 0}`);
    await this.addSession('mtrouter -a', lines);
  }

  public async deleteMtRoute(order: number): Promise<void> {
    await this.removeEntity(`mtrouter -r ${order}`, `MT route #${order}`);
  }

  // --- Filters ----------------------------------------------------------------

  public async getFilters(): Promise<JasminFilter[]> {
    const rows = parseTable(await this.executeCommand('filter -l'), ['Filter id', 'Type', 'Routes', 'Description']);
    return rows
      .filter((r) => r[0])
      .map((r) => {
        const description = (r[3] ?? '').trim();
        const key = description.match(/^<\w+ \((\w+)=/);
        return {
          fid: r[0],
          type: r[1] ?? '',
          routes: (r[2] ?? '').trim(),
          description,
          paramKey: key ? key[1] : '',
          value: filterValueFromDescription(description)
        };
      });
  }

  public async createFilter(fid: string, type: string, paramKey: string | null, paramValue: string): Promise<void> {
    const lines = [`fid ${fid}`, `type ${type}`];
    if (paramKey) lines.push(`${paramKey} ${paramValue}`);
    await this.addSession('filter -a', lines);
  }

  public async deleteFilter(fid: string): Promise<void> {
    await this.removeEntity(`filter -r ${fid}`, `filter ${fid}`);
  }

  // --- Interceptors -----------------------------------------------------------

  public async getMtInterceptors(): Promise<JasminInterceptor[]> {
    return this.parseInterceptors(await this.executeCommand('mtinterceptor -l'));
  }

  public async getMoInterceptors(): Promise<JasminInterceptor[]> {
    return this.parseInterceptors(await this.executeCommand('mointerceptor -l'));
  }

  private parseInterceptors(output: string): JasminInterceptor[] {
    return parseTable(output, ['Order', 'Type', 'Script', 'Filter(s)'])
      .filter((r) => r[0] !== '' && !isNaN(parseInt(r[0], 10)))
      .map((r) => ({ order: parseInt(r[0], 10), type: r[1] ?? '', script: r[2] ?? '', filters: splitList(r[3] ?? '') }));
  }

  // --- Statistics -------------------------------------------------------------

  public async getStats(): Promise<{ httpApi: JasminHttpApiStats; smppsApi: JasminSmppsApiStats }> {
    const kv = (out: string): Record<string, string> => {
      const map: Record<string, string> = {};
      for (const r of parseTable(out, ['Item', 'Value'])) if (r[0]) map[r[0]] = r[1] ?? '';
      return map;
    };
    const h = kv(await this.executeCommand('stats --httpapi'));
    const s = kv(await this.executeCommand('stats --smppsapi'));
    const int = (v?: string) => (v && /^-?\d+$/.test(v) ? parseInt(v, 10) : 0);

    return {
      httpApi: {
        createdAt: h['created_at'] || 'ND',
        requestCount: int(h['request_count']),
        lastRequestAt: h['last_request_at'] || 'ND',
        authErrorCount: int(h['auth_error_count']),
        routeErrorCount: int(h['route_error_count']),
        interceptorErrorCount: int(h['interceptor_error_count']),
        throughputErrorCount: int(h['throughput_error_count']),
        chargingErrorCount: int(h['charging_error_count']),
        serverErrorCount: int(h['server_error_count']),
        successCount: int(h['success_count']),
        lastSuccessAt: h['last_success_at'] || 'ND'
      },
      smppsApi: {
        createdAt: s['created_at'] || 'ND',
        connectedCount: int(s['connected_count']),
        boundTrxCount: int(s['bound_trx_count']),
        boundRxCount: int(s['bound_rx_count']),
        boundTxCount: int(s['bound_tx_count']),
        submitSmCount: int(s['submit_sm_count']),
        deliverSmCount: int(s['deliver_sm_count']),
        throttlingErrorCount: int(s['throttling_error_count']),
        otherSubmitErrorCount: int(s['other_submit_error_count'])
      }
    };
  }

  // --- Persistence --------------------------------------------------------------

  public async persist(): Promise<string> {
    return this.executeCommand('persist');
  }

  public async load(): Promise<string> {
    return this.executeCommand('load');
  }

  public disconnect(): void {
    this.connected = false;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
}
