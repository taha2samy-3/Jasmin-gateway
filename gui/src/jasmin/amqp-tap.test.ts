import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { AmqpTap, JasminTrafficMessage } from './amqp-tap.js';
import { PICKLES_0_11_1 } from './__fixtures__/jasmin-0.11.1.js';

const msg = (routingKey: string, pickle: string, messageId: string, headers: Record<string, unknown> = {}) =>
  ({ fields: { routingKey }, properties: { messageId, headers }, content: Buffer.from(pickle, 'base64') }) as any;

describe('AmqpTap', () => {
  it('follows a real message from submit_sm to the carrier response', () => {
    const tap = new AmqpTap({ host: '127.0.0.1', port: 5672, username: 'guest' });
    const events: Array<[string, boolean]> = [];
    tap.onMessage((m, isUpdate) => events.push([m.status, isUpdate]));

    (tap as any).handleMessage(msg('submit.sm.carrier_a', PICKLES_0_11_1.submitSmUcs2, 'm-1', { source_connector: 'httpapi' }));
    const queued = tap.getMessageById('m-1')!;
    assert.equal(queued.status, 'SUBMITTED');
    assert.equal(queued.routedCid, 'carrier_a');
    assert.equal(queued.sourceAddr, 'ACME');
    assert.equal(queued.destAddr, '201012345678');
    // Arabic content submitted with coding=8 is queued as UTF-8 by Jasmin's HTTP API.
    assert.equal(queued.shortMessage, 'مرحبا Hello');

    (tap as any).handleMessage(msg('submit.sm.resp.carrier_a', PICKLES_0_11_1.submitSmResp, 'm-1'));
    const accepted = tap.getMessageById('m-1')!;
    assert.equal(accepted.status, 'ESME_ROK');
    assert.match(accepted.smscId!, /^[0-9a-f-]{36}$/);
    assert.equal(typeof accepted.latencyMs, 'number');

    (tap as any).handleMessage({ fields: { routingKey: 'dlr_thrower.http' }, properties: { messageId: 'm-1', headers: { message_status: 'DELIVRD' } }, content: Buffer.alloc(0) });
    assert.equal(tap.getMessageById('m-1')!.status, 'DELIVRD');
    assert.deepEqual(events, [['SUBMITTED', false], ['ESME_ROK', true], ['DELIVRD', true]]);
    assert.deepEqual(tap.getStats(), { total: 1, submitted: 0, esmeRok: 0, delivered: 1, errors: 0 });
  });

  it('decodes UTF-16BE content sent as UCS-2 by SMPP clients', () => {
    const text = AmqpTap.messageText({ short_message: Buffer.from([0x06, 0x45, 0x06, 0x31]).toString('latin1'), data_coding: 8 });
    assert.equal(text, 'مر');
  });

  it('keeps a bounded ring buffer with search and status filters', () => {
    const tap = new AmqpTap({ host: '127.0.0.1', port: 5672, username: 'guest', maxBufferSize: 3 });
    const base: JasminTrafficMessage = { msgid: '', routingKey: '', timestamp: 0, sourceAddr: '', destAddr: '', shortMessage: '', connector: '', routedCid: '', status: 'SUBMITTED' };
    (tap as any).addMessage({ ...base, msgid: 'a', shortMessage: 'Test SMS' });
    (tap as any).addMessage({ ...base, msgid: 'b', shortMessage: 'Urgent Alert', status: 'ESME_ROK' });
    (tap as any).addMessage({ ...base, msgid: 'c', status: 'ESME_RSUBMITFAIL' });
    (tap as any).addMessage({ ...base, msgid: 'd' });
    assert.equal(tap.getMessages().length, 3);
    assert.equal(tap.getMessageById('a'), undefined);
    assert.equal(tap.getMessages(10, 'alert').length, 1);
    assert.equal(tap.getMessages(10, '', 'ESME_ROK').length, 1);
    assert.equal(tap.getStats().errors, 1, 'any ESME_ error other than ESME_ROK counts as a failure');
  });
});
