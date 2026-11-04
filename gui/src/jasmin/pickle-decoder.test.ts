import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { decodePickle } from './pickle-decoder.js';
import { PICKLES_0_11_1 } from './__fixtures__/jasmin-0.11.1.js';

const b64 = (s: string) => Buffer.from(s, 'base64');

describe('PickleDecoder', () => {
  it('decodes a protocol 4 dictionary', () => {
    const hex = '80049561000000000000007d94288c0b736f757263655f61646472948c0b2b31323334353637383930948c1064657374696e6174696f6e5f61646472948c0b2b30393837363534333231948c0d73686f72745f6d657373616765948c0c48656c6c6f204a61736d696e94752e';
    const d = decodePickle(Buffer.from(hex, 'hex'));
    assert.equal(d.source_addr, '+1234567890');
    assert.equal(d.short_message, 'Hello Jasmin');
  });

  it('decodes a real SubmitSM published by Jasmin 0.11.1 (bytes via _codecs.encode, enums by value)', () => {
    const pdu = decodePickle(b64(PICKLES_0_11_1.submitSmLoop));
    assert.equal(pdu.__class__, 'smpp.pdu.operations.SubmitSM');
    assert.equal(pdu.id, 'submit_sm');
    assert.equal(pdu.params.source_addr, 'ACME');
    assert.equal(pdu.params.destination_addr, '201012345678');
    assert.equal(pdu.params.dest_addr_ton, 'INTERNATIONAL');
    assert.equal(pdu.params.priority_flag, 'LEVEL_0');
  });

  it('decodes a real SubmitSMResp: CommandStatus value 1 is ESME_ROK', () => {
    const resp = decodePickle(b64(PICKLES_0_11_1.submitSmResp));
    assert.equal(resp.__class__, 'smpp.pdu.operations.SubmitSMResp');
    assert.equal(resp.status, 'ESME_ROK');
    assert.match(resp.params.message_id, /^[0-9a-f-]{36}$/);
  });

  it('never executes code: unknown callables become inert records', () => {
    // GLOBAL pipes.system + REDUCE: a code-execution gadget in a real unpickler
    const evil = Buffer.from('80026370697065730a73797374656d0a71005805000000656368206f8571015271022e', 'hex');
    const out = decodePickle(evil);
    assert.equal(typeof out, 'object');
    assert.equal(out.__class__, 'pipes.system');
  });

  it('rejects empty, truncated or non-pickle input', () => {
    assert.throws(() => decodePickle(Buffer.alloc(0)));
    assert.throws(() => decodePickle(Buffer.from('80027d', 'hex')));
    assert.throws(() => decodePickle(Buffer.from('hello')));
  });
});
