import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { decodePickle } from './pickle-decoder.js';

describe('PickleDecoder', () => {
  it('should decode protocol 4 dictionary with strings and bytes', () => {
    // b'\x80\x04\x95a\x00\x00\x00\x00\x00\x00\x00}\x94(\x8c\x0bsource_addr\x94\x8c\x0b+1234567890\x94\x8c\x10destination_addr\x94\x8c\x0b+0987654321\x94\x8c\rshort_message\x94\x8c\x0cHello Jasmin\x94u.'
    const hex = '80049561000000000000007d94288c0b736f757263655f61646472948c0b2b31323334353637383930948c1064657374696e6174696f6e5f61646472948c0b2b30393837363534333231948c0d73686f72745f6d657373616765948c0c48656c6c6f204a61736d696e94752e';
    const decoded = decodePickle(Buffer.from(hex, 'hex'));

    assert.strictEqual(decoded.source_addr, '+1234567890');
    assert.strictEqual(decoded.destination_addr, '+0987654321');
    assert.strictEqual(decoded.short_message, 'Hello Jasmin');
  });

  it('should handle empty or null buffers safely', () => {
    assert.strictEqual(decodePickle(Buffer.alloc(0)), null);
    assert.strictEqual(decodePickle(null as any), null);
  });
});

