import amqp, { Channel, ChannelModel } from 'amqplib';
import { decodePickle } from './pickle-decoder.js';

export interface JasminTrafficMessage {
  msgid: string;
  routingKey: string;
  timestamp: number;
  sourceAddr: string;
  destAddr: string;
  shortMessage: string;
  connector: string;
  routedCid: string;
  status: string; // 'SUBMITTED' | 'ESME_ROK' | 'ESME_ERR_*' | 'DELIVRD' | 'UNDELIV' | etc.
  smscId?: string;
  latencyMs?: number;
  pduCount?: number;
  rawPdu?: any;
}

export interface AmqpConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  vhost?: string;
  maxBufferSize?: number;
}

export class AmqpTap {
  private config: AmqpConfig;
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private isConnected = false;
  private stopped = false;
  public lastError: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  private buffer: JasminTrafficMessage[] = [];
  private indexById: Map<string, JasminTrafficMessage> = new Map();
  private maxBufferSize: number;

  private listeners: Array<(msg: JasminTrafficMessage, isUpdate: boolean) => void> = [];

  constructor(config: AmqpConfig) {
    this.config = config;
    this.maxBufferSize = config.maxBufferSize || 10000;
  }

  public get connected(): boolean {
    return this.isConnected;
  }

  public onMessage(cb: (msg: JasminTrafficMessage, isUpdate: boolean) => void) {
    this.listeners.push(cb);
  }

  private notify(msg: JasminTrafficMessage, isUpdate = false) {
    for (const listener of this.listeners) {
      try {
        listener(msg, isUpdate);
      } catch (err) {
        // Ignore listener exceptions
      }
    }
  }

  public async start(): Promise<void> {
    this.stopped = false;
    const vhost = this.config.vhost && this.config.vhost !== '/' ? this.config.vhost : '';
    const url = `amqp://${encodeURIComponent(this.config.username)}:${encodeURIComponent(this.config.password || '')}@${this.config.host}:${this.config.port}/${encodeURIComponent(vhost)}`;
    let conn: ChannelModel | null = null;

    try {
      conn = await amqp.connect(url);
      // Errors after setup are followed by 'close'; reconnect once from there.
      conn.on('error', () => undefined);
      conn.on('close', () => {
        if (this.connection === conn) {
          this.connection = null;
          this.channel = null;
          if (this.isConnected) console.warn('[AMQP Tap] Connection to RabbitMQ lost; reconnecting');
          this.scheduleReconnect();
        }
      });
      const ch = await conn.createChannel();
      ch.on('error', () => undefined);

      // The exchange is declared by Jasmin; it does not exist until jasmind has started once.
      const exchange = 'messaging';
      await ch.checkExchange(exchange);
      const q = await ch.assertQueue('', { exclusive: true, autoDelete: true });
      const bindings = ['submit.sm.*', 'submit.sm.resp.*', 'dlr_thrower.*'];
      for (const rk of bindings) await ch.bindQueue(q.queue, exchange, rk);

      await ch.consume(
        q.queue,
        (msg) => {
          if (!msg) return;
          try {
            this.handleMessage(msg);
          } catch (e: any) {
            console.error(`[AMQP Tap] Cannot process ${msg.fields.routingKey}: ${e.message}`);
          }
        },
        // The tap only observes: its private queue gets copies, so no acknowledgements are needed.
        { noAck: true }
      );

      this.connection = conn;
      this.channel = ch;
      this.isConnected = true;
      this.lastError = null;
      console.log(`[AMQP Tap] Subscribed to '${exchange}' (${bindings.join(', ')})`);
    } catch (err: any) {
      const reason = /NOT_FOUND - no exchange/.test(err.message) ? "exchange 'messaging' not declared yet (Jasmin still starting)" : err.message;
      if (this.lastError !== reason) console.warn(`[AMQP Tap] RabbitMQ not ready: ${reason}; retrying every 5s`);
      this.lastError = reason;
      this.isConnected = false;
      // Close the half-open connection so retries never leak sockets.
      if (conn && this.connection !== conn) await conn.close().catch(() => undefined);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    this.isConnected = false;
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.start().catch(() => {});
    }, 5000);
  }

  /**
   * Text of a decoded short_message. The pickle carries raw bytes (as latin1 code points).
   * Jasmin queues HTTP API content as UTF-8 even when data_coding is 8 (UCS-2) and transcodes later,
   * while SMPP clients may submit real UTF-16BE: try strict UTF-8 first, then UTF-16BE for UCS-2.
   */
  static messageText(params: any): string {
    const raw = typeof params?.short_message === 'string' ? params.short_message : '';
    const bytes = Buffer.from(raw, 'latin1');
    if (bytes.some((b) => b > 0x7f)) {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        /* not UTF-8 */
      }
    }
    const dc = params?.data_coding;
    const ucs2 = dc === 8 || (dc && typeof dc === 'object' && JSON.stringify(dc).includes('UCS2'));
    if (ucs2 && bytes.length % 2 === 0) return new TextDecoder('utf-16be').decode(bytes);
    return raw;
  }

  private handleMessage(msg: amqp.ConsumeMessage) {
    const routingKey = msg.fields.routingKey || '';
    const props = msg.properties || {};
    const headers = props.headers || {};
    const msgid = String(props.messageId || headers['message-id'] || '');
    const decode = () => {
      try {
        return decodePickle(msg.content);
      } catch {
        return null;
      }
    };

    // 1. Message queued for a connector: submit.sm.<cid>
    if (routingKey.startsWith('submit.sm.') && !routingKey.startsWith('submit.sm.resp.')) {
      const pdu = decode();
      const params = pdu?.params || {};
      const item: JasminTrafficMessage = {
        msgid: msgid || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        routingKey,
        timestamp: Date.now(),
        sourceAddr: String(params.source_addr ?? ''),
        destAddr: String(params.destination_addr ?? ''),
        shortMessage: AmqpTap.messageText(params),
        connector: String(headers['source_connector'] ?? ''),
        routedCid: routingKey.slice('submit.sm.'.length),
        status: 'SUBMITTED',
        rawPdu: params
      };
      const existing = this.indexById.get(item.msgid);
      if (existing) {
        Object.assign(existing, item, { timestamp: existing.timestamp });
        this.notify(existing, true);
      } else {
        this.addMessage(item);
        this.notify(item, false);
      }
      return;
    }

    // 2. Carrier response: submit.sm.resp.<cid>
    if (routingKey.startsWith('submit.sm.resp.')) {
      const pdu = decode();
      const status = typeof pdu?.status === 'string' ? pdu.status : 'UNKNOWN';
      const smscId = String(pdu?.params?.message_id ?? '');
      const existing = msgid ? this.indexById.get(msgid) : undefined;
      if (existing) {
        existing.status = status;
        if (smscId) existing.smscId = smscId;
        existing.latencyMs = Date.now() - existing.timestamp;
        this.notify(existing, true);
      } else if (msgid) {
        const item: JasminTrafficMessage = {
          msgid,
          routingKey,
          timestamp: Date.now(),
          sourceAddr: '',
          destAddr: '',
          shortMessage: '',
          connector: '',
          routedCid: routingKey.slice('submit.sm.resp.'.length),
          status,
          smscId
        };
        this.addMessage(item);
        this.notify(item, false);
      }
      return;
    }

    // 3. Delivery receipt forwarded to the client: dlr_thrower.http / dlr_thrower.smpps
    if (routingKey.startsWith('dlr_thrower.')) {
      const existing = msgid ? this.indexById.get(msgid) : undefined;
      const dlrStatus = String(headers['message_status'] ?? headers['stat'] ?? '').trim();
      if (existing && dlrStatus) {
        existing.status = dlrStatus;
        this.notify(existing, true);
      }
    }
  }

  private addMessage(msg: JasminTrafficMessage) {
    if (this.buffer.length >= this.maxBufferSize) {
      const removed = this.buffer.shift();
      if (removed) {
        this.indexById.delete(removed.msgid);
      }
    }
    this.buffer.push(msg);
    this.indexById.set(msg.msgid, msg);
  }

  public getMessages(limit = 100, query = '', status = ''): JasminTrafficMessage[] {
    let res = this.buffer.slice().reverse();

    if (query) {
      const q = query.toLowerCase();
      res = res.filter(
        (m) =>
          m.msgid.toLowerCase().includes(q) ||
          m.sourceAddr.toLowerCase().includes(q) ||
          m.destAddr.toLowerCase().includes(q) ||
          m.shortMessage.toLowerCase().includes(q) ||
          m.routedCid.toLowerCase().includes(q)
      );
    }

    if (status) {
      res = res.filter((m) => m.status.toUpperCase() === status.toUpperCase());
    }

    return res.slice(0, limit);
  }

  public getMessageById(msgid: string): JasminTrafficMessage | undefined {
    return this.indexById.get(msgid);
  }

  public clear() {
    this.buffer = [];
    this.indexById.clear();
  }

  public getStats() {
    let total = this.buffer.length;
    let submitted = 0;
    let esmeRok = 0;
    let errors = 0;
    let delivered = 0;

    for (const m of this.buffer) {
      if (m.status === 'SUBMITTED') submitted++;
      else if (m.status === 'ESME_ROK') esmeRok++;
      else if (m.status === 'DELIVRD') delivered++;
      else if (m.status !== 'ENROUTE' && m.status !== 'ACCEPTD') errors++;
    }

    return { total, submitted, esmeRok, delivered, errors };
  }

  public stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.isConnected = false;
    this.channel?.close().catch(() => {});
    this.connection?.close().catch(() => {});
  }
}
