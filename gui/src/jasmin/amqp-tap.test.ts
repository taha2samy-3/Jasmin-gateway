import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { AmqpTap, JasminTrafficMessage } from './amqp-tap.js';

describe('AmqpTap Unit Tests', () => {
  it('should initialize and manage in-memory ring buffer with search and filtering', () => {
    const tap = new AmqpTap({
      host: '127.0.0.1',
      port: 5672,
      username: 'guest',
      maxBufferSize: 3
    });

    // Directly test buffer manipulation through internal mock dispatch
    (tap as any).addMessage({
      msgid: 'msg-1',
      routingKey: 'submit.sm.smpp1',
      timestamp: 1000,
      sourceAddr: '+1111',
      destAddr: '+2222',
      shortMessage: 'Test SMS 1',
      connector: 'http',
      routedCid: 'smpp1',
      status: 'SUBMITTED'
    });

    (tap as any).addMessage({
      msgid: 'msg-2',
      routingKey: 'submit.sm.smpp2',
      timestamp: 2000,
      sourceAddr: '+3333',
      destAddr: '+4444',
      shortMessage: 'Urgent Alert',
      connector: 'smpp',
      routedCid: 'smpp2',
      status: 'ESME_ROK'
    });

    assert.strictEqual(tap.getMessages().length, 2);
    assert.strictEqual(tap.getMessages(10, 'Alert').length, 1);
    assert.strictEqual(tap.getMessages(10, '', 'ESME_ROK').length, 1);

    // Buffer overflow eviction check
    (tap as any).addMessage({ msgid: 'msg-3', status: 'SUBMITTED' });
    (tap as any).addMessage({ msgid: 'msg-4', status: 'SUBMITTED' });

    assert.strictEqual(tap.getMessages().length, 3);
    assert.strictEqual(tap.getMessageById('msg-1'), undefined); // Evicted
    assert.strictEqual(tap.getMessageById('msg-4')?.msgid, 'msg-4');

    const stats = tap.getStats();
    assert.strictEqual(stats.total, 3);
  });
});

