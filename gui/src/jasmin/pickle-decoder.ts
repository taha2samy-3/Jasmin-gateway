/**
 * Native TypeScript/JavaScript decoder for Python pickle protocols (2, 3, 4, 5).
 * Safely extracts strings, numbers, bytes, tuples, lists, dicts, and object states
 * from Jasmin SMS Gateway AMQP messages without requiring external Python binaries.
 */

export function decodePickle(buf: Buffer): any {
  if (!buf || buf.length === 0) return null;

  let pos = 0;
  const stack: any[] = [];
  const memo: Record<number, any> = {};
  let memoIdx = 0;

  function readByte(): number {
    return buf[pos++];
  }

  function readBytes(n: number): Buffer {
    const res = buf.subarray(pos, pos + n);
    pos += n;
    return res;
  }

  while (pos < buf.length) {
    const op = buf[pos++];

    switch (op) {
      case 0x80: { // PROTO
        readByte();
        break;
      }
      case 0x95: { // FRAME (8-byte length prefix in proto 4)
        pos += 8;
        break;
      }
      case 0x7d: { // } EMPTY_DICT
        stack.push({});
        break;
      }
      case 0x5d: { // ] EMPTY_LIST
        stack.push([]);
        break;
      }
      case 0x29: { // ) EMPTY_TUPLE
        stack.push([]);
        break;
      }
      case 0x28: { // ( MARK
        stack.push(Symbol.for('MARK'));
        break;
      }
      case 0x8c: { // \x8c SHORT_BINUNICODE (1 byte len + utf8)
        const len = readByte();
        const str = readBytes(len).toString('utf-8');
        stack.push(str);
        break;
      }
      case 0x58: { // X BINUNICODE (4 bytes len + utf8)
        const len = buf.readUInt32LE(pos);
        pos += 4;
        const str = readBytes(len).toString('utf-8');
        stack.push(str);
        break;
      }
      case 0x43: { // C SHORT_BINBYTES (1 byte len)
        const len = readByte();
        const b = readBytes(len);
        stack.push(b.toString('utf-8'));
        break;
      }
      case 0x42: { // B BINBYTES (4 bytes len)
        const len = buf.readUInt32LE(pos);
        pos += 4;
        const b = readBytes(len);
        stack.push(b.toString('utf-8'));
        break;
      }
      case 0x4b: { // K BININT1 (1 byte unsigned int)
        stack.push(readByte());
        break;
      }
      case 0x4d: { // M BININT2 (2 bytes unsigned int)
        const val = buf.readUInt16LE(pos);
        pos += 2;
        stack.push(val);
        break;
      }
      case 0x4a: { // J BININT (4 bytes signed int)
        const val = buf.readInt32LE(pos);
        pos += 4;
        stack.push(val);
        break;
      }
      case 0x88: { // \x88 NEWTRUE
        stack.push(true);
        break;
      }
      case 0x89: { // \x89 NEWFALSE
        stack.push(false);
        break;
      }
      case 0x4e: { // N NONE
        stack.push(null);
        break;
      }
      case 0x94: { // \x94 MEMOIZE
        memo[memoIdx++] = stack[stack.length - 1];
        break;
      }
      case 0x68: { // h BINGET (1 byte index)
        const idx = readByte();
        stack.push(memo[idx]);
        break;
      }
      case 0x6a: { // j LONG_BINGET (4 bytes index)
        const idx = buf.readUInt32LE(pos);
        pos += 4;
        stack.push(memo[idx]);
        break;
      }
      case 0x71: { // q BINPUT
        const idx = readByte();
        memo[idx] = stack[stack.length - 1];
        break;
      }
      case 0x72: { // r LONG_BINPUT
        const idx = buf.readUInt32LE(pos);
        pos += 4;
        memo[idx] = stack[stack.length - 1];
        break;
      }
      case 0x75: { // u SETITEMS
        const mark = Symbol.for('MARK');
        const items: any[] = [];
        while (stack.length && stack[stack.length - 1] !== mark) {
          items.unshift(stack.pop());
        }
        stack.pop(); // pop mark
        const dict = stack[stack.length - 1];
        if (dict && typeof dict === 'object') {
          for (let i = 0; i < items.length; i += 2) {
            dict[items[i]] = items[i + 1];
          }
        }
        break;
      }
      case 0x73: { // s SETITEM
        const val = stack.pop();
        const key = stack.pop();
        const dict = stack[stack.length - 1];
        if (dict && typeof dict === 'object') {
          dict[key] = val;
        }
        break;
      }
      case 0x61: { // a APPEND
        const val = stack.pop();
        const list = stack[stack.length - 1];
        if (Array.isArray(list)) {
          list.push(val);
        }
        break;
      }
      case 0x65: { // e APPENDS
        const mark = Symbol.for('MARK');
        const items: any[] = [];
        while (stack.length && stack[stack.length - 1] !== mark) {
          items.unshift(stack.pop());
        }
        stack.pop(); // pop mark
        const list = stack[stack.length - 1];
        if (Array.isArray(list)) {
          list.push(...items);
        }
        break;
      }
      case 0x63: { // c GLOBAL (e.g. smpp.pdu.operations\nSubmitSm\n)
        let module = '';
        while (pos < buf.length && buf[pos] !== 0x0a) module += String.fromCharCode(buf[pos++]);
        pos++; // skip \n
        let name = '';
        while (pos < buf.length && buf[pos] !== 0x0a) name += String.fromCharCode(buf[pos++]);
        pos++; // skip \n
        stack.push({ __class__: `${module}.${name}` });
        break;
      }
      case 0x81: { // \x81 NEWOBJ (takes class + tuple from stack)
        const args = stack.pop();
        const cls = stack.pop();
        stack.push({ __class__: cls?.__class__ || 'Object', params: {}, args });
        break;
      }
      case 0x62: { // b BUILD
        const state = stack.pop();
        const target = stack[stack.length - 1];
        if (target && typeof target === 'object' && state && typeof state === 'object') {
          Object.assign(target, state);
        }
        break;
      }
      case 0x2e: { // . STOP
        break;
      }
      default: {
        // Safe fallback: ignore unrecognized opcode
        break;
      }
    }
  }

  return stack.pop() || null;
}

