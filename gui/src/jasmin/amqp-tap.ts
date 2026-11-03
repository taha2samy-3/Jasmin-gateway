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
  private reconnectTimer: NodeJS.Timeout | null = null;

  private buffer: JasminTrafficMessage[] = [];
  private indexById: Map<string, JasminTrafficMessage> = new Map();
  private maxBufferSize: number;

  private listeners: Array<(msg: JasminTrafficMessage, isUpdate: boolean) => void> = [];

  constructor(config: AmqpConfig) {
    this.config = config;
    this.maxBufferSize = config.maxBufferSize || 10000;
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
    const vhost = this.config.vhost && this.config.vhost !== '/' ? this.config.vhost : '';
    const url = `amqp://${encodeURIComponent(this.config.username)}:${encodeURIComponent(this.config.password || '')}@${this.config.host}:${this.config.port}/${encodeURIComponent(vhost)}`;

    try {
      const conn = await amqp.connect(url);
      const ch = await conn.createChannel();
      this.connection = conn;
      this.channel = ch;
      this.isConnected = true;

      conn.on('error', (err: any) => {
        console.error(`[AMQP Tap] Connection error: ${err.message}. Reconnecting...`);
        this.scheduleReconnect();
      });

      conn.on('close', () => {
        if (this.isConnected) {
          console.warn('[AMQP Tap] Connection closed. Reconnecting in 5s...');
          this.scheduleReconnect();
        }
      });

      const exchange = 'messaging';
      const q = await ch.assertQueue('', { exclusive: true, autoDelete: true });
      const bindings = ['submit.sm.*', 'submit.sm.resp.*', 'dlr_thrower.*'];

      for (const rk of bindings) {
        await ch.bindQueue(q.queue, exchange, rk);
      }

      console.log(`[AMQP Tap] Successfully subscribed to exchange '${exchange}' on ${bindings.join(', ')}`);

      await ch.consume(
        q.queue,
        (msg: any) => {
          if (!msg) return;
          try {
            this.handleMessage(msg);
            ch.ack(msg);
          } catch (e: any) {
            console.error(`[AMQP Tap] Error processing message: ${e.message}`);
            ch.ack(msg);
          }
        },
        { noAck: false }
      );
    } catch (err: any) {
      console.warn(`[AMQP Tap] RabbitMQ tap unavailable (${err.message}). Retrying in 5s...`);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    this.isConnected = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.start().catch(() => {});
    }, 5000);
  }

  private handleMessage(msg: amqp.ConsumeMessage) {
    const routingKey = msg.fields.routingKey || '';
    const props = msg.properties || {};
    const headers = props.headers || {};
    const msgid = (props.messageId || headers['message-id'] || '').toString();

    // 1. Initial Message Submission (submit.sm.*)
    if (routingKey.startsWith('submit.sm.') && !routingKey.startsWith('submit.sm.resp.')) {
      let decodedPdu: any = null;
      try {
        decodedPdu = decodePickle(msg.content);
      } catch (e) {
        // Pickle decoding failed or non-pickle payload
      }

      const params = decodedPdu?.params || decodedPdu || {};
      const sourceAddr = (params.source_addr || headers['source_addr'] || '').toString();
      const destAddr = (params.destination_addr || headers['destination_addr'] || '').toString();
      const shortMessage = (params.short_message || headers['short_message'] || '').toString();
      const routedCid = routingKey.length > 10 ? routingKey.substring(10) : '';
      const connector = (headers['source_connector'] || 'http').toString();

      const item: JasminTrafficMessage = {
        msgid: msgid || `msg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        routingKey,
        timestamp: Date.now(),
        sourceAddr,
        destAddr,
        shortMessage,
        connector,
        routedCid,
        status: 'SUBMITTED',
        rawPdu: params
      };

      this.addMessage(item);
      this.notify(item, false);
      return;
    }

    // 2. Upstream SMSC Response (submit.sm.resp.*)
    if (routingKey.startsWith('submit.sm.resp.')) {
      let existing = msgid ? this.indexById.get(msgid) : null;
      let decodedResp: any = null;
      try {
        decodedResp = decodePickle(msg.content);
      } catch (e) {}

      const params = decodedResp?.params || decodedResp || {};
      const commandStatus = params.command_status ?? 0;
      const smscId = (params.message_id || '').toString();

      const status = commandStatus === 0 ? 'ESME_ROK' : `ESME_ERR_${commandStatus}`;
      const now = Date.now();

      if (existing) {
        existing.status = status;
        existing.smscId = smscId;
        existing.latencyMs = now - existing.timestamp;
        this.notify(existing, true);
      } else if (msgid) {
        const item: JasminTrafficMessage = {
          msgid,
          routingKey,
          timestamp: now,
          sourceAddr: '',
          destAddr: '',
          shortMessage: '',
          connector: '',
          routedCid: routingKey.substring(15),
          status,
          smscId,
          rawPdu: params
        };
        this.addMessage(item);
        this.notify(item, false);
      }
      return;
    }

    // 3. Delivery Receipt (dlr_thrower.*)
    if (routingKey.startsWith('dlr_thrower.')) {
      const existing = msgid ? this.indexById.get(msgid) : null;
      const dlrStatus = (headers['message_status'] || headers['status'] || 'DELIVRD').toString();

      if (existing) {
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
      else if (m.status.includes('ERR') || m.status === 'UNDELIV' || m.status === 'REJECTD') errors++;
    }

    return { total, submitted, esmeRok, delivered, errors };
  }

  public stop() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.isConnected = false;
    this.channel?.close().catch(() => {});
    this.connection?.close().catch(() => {});
  }
}
