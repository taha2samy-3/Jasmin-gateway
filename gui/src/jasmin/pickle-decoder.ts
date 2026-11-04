/**
 * Safe decoder for the Python pickles Jasmin publishes on RabbitMQ (protocols 2-5).
 *
 * Nothing is ever executed: GLOBAL/REDUCE/NEWOBJ only resolve a small whitelist of callables that
 * Jasmin actually uses for data (`_codecs.encode` for bytes, smpp.pdu enums, `re._compile`).
 * Every other object becomes an inert `{ __class__, ...state }` record.
 */
import { SMPP_ENUMS } from './smpp-enums.js';

const MARK = Symbol('mark');

interface ClassRef {
  __global__: string;
}
export interface PickledObject {
  __class__: string;
  [key: string]: unknown;
}

const isClassRef = (v: unknown): v is ClassRef => !!v && typeof v === 'object' && '__global__' in (v as object);

/** Apply a whitelisted callable; unknown callables yield an inert record. */
function reduce(fn: unknown, args: unknown[]): unknown {
  const name = isClassRef(fn) ? fn.__global__ : String(fn);
  if (name === '_codecs.encode') return String(args[0] ?? ''); // bytes pickled as encode(str, 'latin1')
  if (name === 're._compile') return String(args[0] ?? '');
  const enumName = name.startsWith('smpp.pdu.pdu_types.') ? name.slice('smpp.pdu.pdu_types.'.length) : '';
  if (enumName && SMPP_ENUMS[enumName] && typeof args[0] === 'number') return SMPP_ENUMS[enumName][args[0]] ?? `${enumName}(${args[0]})`;
  if (/^(builtins|__builtin__)\.(bytes|bytearray|str)$/.test(name)) return String(args[0] ?? '');
  return { __class__: name, args } as PickledObject;
}

function build(obj: unknown, state: unknown): unknown {
  if (!obj || typeof obj !== 'object') return obj;
  // State may be a dict or a (dict, slotstate) tuple.
  const dict = Array.isArray(state) ? state[0] : state;
  const slots = Array.isArray(state) ? state[1] : null;
  if (dict && typeof dict === 'object') Object.assign(obj, dict);
  if (slots && typeof slots === 'object') Object.assign(obj, slots);
  return obj;
}

export function decodePickle(buf: Buffer): any {
  if (!buf || buf.length < 2 || buf[0] !== 0x80) throw new Error('Not a binary pickle');
  let pos = 0;
  let stack: unknown[] = [];
  const metastack: unknown[][] = [];
  const memo = new Map<number, unknown>();

  const need = (n: number) => {
    if (pos + n > buf.length) throw new Error('Truncated pickle');
  };
  const u8 = () => (need(1), buf[pos++]);
  const u16 = () => (need(2), (pos += 2), buf.readUInt16LE(pos - 2));
  const u32 = () => (need(4), (pos += 4), buf.readUInt32LE(pos - 4));
  const i32 = () => (need(4), (pos += 4), buf.readInt32LE(pos - 4));
  const u64 = () => {
    need(8);
    const v = buf.readBigUInt64LE(pos);
    pos += 8;
    if (v > BigInt(buf.length)) throw new Error('Pickle length out of range');
    return Number(v);
  };
  const bytes = (n: number) => {
    need(n);
    pos += n;
    return buf.subarray(pos - n, pos);
  };
  const line = () => {
    const end = buf.indexOf(0x0a, pos);
    if (end === -1) throw new Error('Truncated pickle');
    const s = buf.toString('latin1', pos, end);
    pos = end + 1;
    return s;
  };
  const pop = () => {
    if (!stack.length) throw new Error('Pickle stack underflow');
    return stack.pop();
  };
  const popMark = () => {
    const items = stack;
    stack = metastack.pop() ?? [];
    return items;
  };
  const top = () => stack[stack.length - 1];

  while (pos < buf.length) {
    const op = buf[pos++];
    switch (op) {
      case 0x80: // PROTO
        u8();
        break;
      case 0x95: // FRAME
        u64();
        break;
      case 0x2e: // STOP
        return pop();
      case 0x28: // MARK
        metastack.push(stack);
        stack = [];
        break;
      case 0x30: // POP
        pop();
        break;
      case 0x31: // POP_MARK
        popMark();
        break;
      case 0x32: // DUP
        stack.push(top());
        break;

      case 0x4e: // NONE
        stack.push(null);
        break;
      case 0x88: // NEWTRUE
        stack.push(true);
        break;
      case 0x89: // NEWFALSE
        stack.push(false);
        break;
      case 0x4b: // BININT1
        stack.push(u8());
        break;
      case 0x4d: // BININT2
        stack.push(u16());
        break;
      case 0x4a: // BININT
        stack.push(i32());
        break;
      case 0x8a: // LONG1
      case 0x8b: {
        // LONG4
        const n = op === 0x8a ? u8() : u32();
        const b = bytes(n);
        let v = 0n;
        for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
        if (n && b[n - 1] & 0x80) v -= 1n << BigInt(n * 8);
        stack.push(Number(v));
        break;
      }
      case 0x47: // BINFLOAT (big-endian double)
        need(8);
        stack.push(buf.readDoubleBE(pos));
        pos += 8;
        break;

      case 0x8c: // SHORT_BINUNICODE
        stack.push(bytes(u8()).toString('utf8'));
        break;
      case 0x58: // BINUNICODE
        stack.push(bytes(u32()).toString('utf8'));
        break;
      case 0x8d: // BINUNICODE8
        stack.push(bytes(u64()).toString('utf8'));
        break;
      case 0x55: // SHORT_BINSTRING
        stack.push(bytes(u8()).toString('latin1'));
        break;
      case 0x54: // BINSTRING
        stack.push(bytes(u32()).toString('latin1'));
        break;
      case 0x43: // SHORT_BINBYTES
        stack.push(bytes(u8()).toString('latin1'));
        break;
      case 0x42: // BINBYTES
        stack.push(bytes(u32()).toString('latin1'));
        break;
      case 0x8e: // BINBYTES8
      case 0x96: // BYTEARRAY8
        stack.push(bytes(u64()).toString('latin1'));
        break;

      case 0x29: // EMPTY_TUPLE
        stack.push([]);
        break;
      case 0x85: // TUPLE1
        stack.push([pop()]);
        break;
      case 0x86: {
        // TUPLE2
        const b = pop();
        const a = pop();
        stack.push([a, b]);
        break;
      }
      case 0x87: {
        // TUPLE3
        const c = pop();
        const b = pop();
        const a = pop();
        stack.push([a, b, c]);
        break;
      }
      case 0x74: // TUPLE
      case 0x6c: // LIST
        stack.push(popMark());
        break;
      case 0x5d: // EMPTY_LIST
        stack.push([]);
        break;
      case 0x7d: // EMPTY_DICT
        stack.push({});
        break;
      case 0x8f: // EMPTY_SET
        stack.push([]);
        break;
      case 0x64: {
        // DICT
        const items = popMark();
        const d: Record<string, unknown> = {};
        for (let i = 0; i + 1 < items.length; i += 2) d[String(items[i])] = items[i + 1];
        stack.push(d);
        break;
      }
      case 0x90: // ADDITEMS
      case 0x65: {
        // APPENDS
        const items = popMark();
        const list = top();
        if (Array.isArray(list)) list.push(...items);
        break;
      }
      case 0x91: // FROZENSET
        stack.push(popMark());
        break;
      case 0x61: {
        // APPEND
        const v = pop();
        const list = top();
        if (Array.isArray(list)) list.push(v);
        break;
      }
      case 0x73: {
        // SETITEM
        const v = pop();
        const k = pop();
        const d = top();
        if (d && typeof d === 'object') (d as Record<string, unknown>)[String(k)] = v;
        break;
      }
      case 0x75: {
        // SETITEMS
        const items = popMark();
        const d = top();
        if (d && typeof d === 'object') for (let i = 0; i + 1 < items.length; i += 2) (d as Record<string, unknown>)[String(items[i])] = items[i + 1];
        break;
      }

      case 0x63: {
        // GLOBAL "module\nname\n"
        const module = line();
        const name = line();
        stack.push({ __global__: `${module}.${name}` } as ClassRef);
        break;
      }
      case 0x93: {
        // STACK_GLOBAL
        const name = pop();
        const module = pop();
        stack.push({ __global__: `${module}.${name}` } as ClassRef);
        break;
      }
      case 0x52: {
        // REDUCE
        const args = pop();
        const fn = pop();
        stack.push(reduce(fn, Array.isArray(args) ? args : []));
        break;
      }
      case 0x81: {
        // NEWOBJ
        const args = pop();
        const cls = pop();
        const name = isClassRef(cls) ? cls.__global__ : 'object';
        stack.push(name.startsWith('smpp.pdu.pdu_types.') ? reduce(cls, Array.isArray(args) ? args : []) : ({ __class__: name } as PickledObject));
        break;
      }
      case 0x92: {
        // NEWOBJ_EX
        pop();
        pop();
        const cls = pop();
        stack.push({ __class__: isClassRef(cls) ? cls.__global__ : 'object' } as PickledObject);
        break;
      }
      case 0x62: {
        // BUILD
        const state = pop();
        stack.push(build(pop(), state));
        break;
      }

      case 0x70: // PUT (text index)
        memo.set(parseInt(line(), 10), top());
        break;
      case 0x71: // BINPUT
        memo.set(u8(), top());
        break;
      case 0x72: // LONG_BINPUT
        memo.set(u32(), top());
        break;
      case 0x94: // MEMOIZE
        memo.set(memo.size, top());
        break;
      case 0x67: // GET (text index)
        stack.push(memo.get(parseInt(line(), 10)));
        break;
      case 0x68: // BINGET
        stack.push(memo.get(u8()));
        break;
      case 0x6a: // LONG_BINGET
        stack.push(memo.get(u32()));
        break;

      default:
        throw new Error(`Unsupported pickle opcode 0x${op.toString(16)} at ${pos - 1}`);
    }
  }
  throw new Error('Pickle has no STOP opcode');
}
