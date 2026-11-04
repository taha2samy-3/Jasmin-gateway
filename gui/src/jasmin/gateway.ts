import { JCliClient, JCliConfig } from './jcli-client.js';
import {
  JasminFilter,
  JasminGroup,
  JasminHttpApiStats,
  JasminHttpConnector,
  JasminInterceptor,
  JasminMoRoute,
  JasminMtRoute,
  JasminSmppConnector,
  JasminSmppsApiStats,
  JasminUser
} from './types.js';

export interface GatewaySnapshot {
  fetchedAt: string;
  users: JasminUser[];
  groups: JasminGroup[];
  smppConnectors: JasminSmppConnector[];
  httpConnectors: JasminHttpConnector[];
  filters: JasminFilter[];
  mtRoutes: JasminMtRoute[];
  moRoutes: JasminMoRoute[];
  mtInterceptors: JasminInterceptor[];
  moInterceptors: JasminInterceptor[];
  stats: { httpApi: JasminHttpApiStats; smppsApi: JasminSmppsApiStats };
}

/**
 * Access layer over Jasmin's jCLI.
 *
 * jCLI keeps filters and HTTP connectors per console session: a session only sees what was
 * persisted when it logged in, plus its own changes. Therefore:
 *  - reads use one long-lived session that is recycled periodically and after every change;
 *  - every change runs in a fresh session and is followed by `persist`, so other sessions
 *    (and the next fresh session) see it, and a stale session can never overwrite newer state.
 */
export class JasminGateway {
  private reader: JCliClient;
  private readerBornAt = 0;
  private cache: { at: number; value: Promise<GatewaySnapshot> } | null = null;
  private mutationChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: JCliConfig, private readonly options = { cacheMs: 2000, readerMaxAgeMs: 20000 }) {
    this.reader = new JCliClient(config);
  }

  get version(): string | null {
    return this.reader.version;
  }

  get connected(): boolean {
    return this.reader.isConnected;
  }

  get lastError(): string | null {
    return this.reader.lastError;
  }

  /** Reader session, recycled when old so changes persisted by other consoles become visible. */
  private async readSession(): Promise<JCliClient> {
    if (this.reader.isConnected && Date.now() - this.readerBornAt > this.options.readerMaxAgeMs) {
      this.reader.disconnect();
    }
    if (!this.reader.isConnected) {
      await this.reader.connect();
      this.readerBornAt = Date.now();
    }
    return this.reader;
  }

  async ping(): Promise<boolean> {
    try {
      await this.readSession();
      return true;
    } catch {
      return false;
    }
  }

  /** Full gateway state, cached for a short time so many browser tabs share one jCLI pass. */
  snapshot(force = false): Promise<GatewaySnapshot> {
    if (!force && this.cache && Date.now() - this.cache.at < this.options.cacheMs) return this.cache.value;
    const value = (async () => {
      const c = await this.readSession();
      // The client serialises commands, sequential awaits keep the order explicit.
      const users = await c.getUsers();
      const groups = await c.getGroups();
      const smppConnectors = await c.getSmppConnectors();
      const httpConnectors = await c.getHttpConnectors();
      const filters = await c.getFilters();
      const mtRoutes = await c.getMtRoutes();
      const moRoutes = await c.getMoRoutes();
      const mtInterceptors = await c.getMtInterceptors();
      const moInterceptors = await c.getMoInterceptors();
      const stats = await c.getStats();
      return {
        fetchedAt: new Date().toISOString(),
        users,
        groups,
        smppConnectors,
        httpConnectors,
        filters,
        mtRoutes,
        moRoutes,
        mtInterceptors,
        moInterceptors,
        stats
      };
    })();
    this.cache = { at: Date.now(), value };
    value.catch(() => {
      if (this.cache?.value === value) this.cache = null;
    });
    return value;
  }

  /** Lightweight stats read for the live telemetry loop. */
  async stats() {
    const c = await this.readSession();
    const stats = await c.getStats();
    const smppConnectors = await c.getSmppConnectors();
    return { ...stats, smppConnectors };
  }

  /**
   * Run a change in a fresh jCLI session, then persist. Changes are serialised.
   * The persist output is returned so the UI can show what was written.
   */
  mutate<T>(fn: (c: JCliClient) => Promise<T>): Promise<{ result: T; persisted: string }> {
    const run = async () => {
      const session = new JCliClient(this.config);
      try {
        await session.connect();
        let result: T;
        let failure: unknown = null;
        try {
          result = await fn(session);
        } catch (err) {
          failure = err;
          result = undefined as T;
        }
        // Persist even after a partial failure so disk matches what is live in the router.
        const persisted = await session.persist();
        if (failure) throw failure;
        return { result, persisted };
      } finally {
        session.disconnect();
        this.cache = null;
        this.reader.disconnect();
      }
    };
    const p = this.mutationChain.then(run, run);
    this.mutationChain = p.catch(() => undefined);
    return p;
  }

  /** Open a raw session (used by the web terminal proxy for status checks). */
  newSession(): JCliClient {
    return new JCliClient(this.config);
  }

  close() {
    this.reader.disconnect();
  }
}
