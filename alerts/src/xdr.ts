/**
 * Minimal XDR encoding/decoding for Soroban simulateTransaction.
 *
 * Encodes just enough to build invoke-contract transactions and decode results.
 * Uses raw XDR byte manipulation to avoid pulling in the full Stellar SDK.
 */

// ── Base32 (Stellar StrKey) ──────────────────────────────────────────────────

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Uint8Array {
  const cleaned = input.toUpperCase().replace(/=+$/, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(c);
    if (idx === -1) throw new Error(`Invalid base32 char: ${c}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** Decode a Stellar address (G... or C...) to its 32-byte public key / contract hash. */
function decodeStrKey(address: string): Uint8Array {
  const decoded = base32Decode(address);
  // Format: 1 byte version + 32 bytes payload + 2 bytes checksum
  return decoded.slice(1, 33);
}

// ── Base64 ───────────────────────────────────────────────────────────────────

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ── XDR primitives ───────────────────────────────────────────────────────────

class XdrWriter {
  private buf: number[] = [];

  writeUint32(v: number) {
    this.buf.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  }

  writeInt32(v: number) { this.writeUint32(v >>> 0); }

  writeInt64(v: bigint) {
    const hi = Number((v >> 32n) & 0xFFFFFFFFn);
    const lo = Number(v & 0xFFFFFFFFn);
    this.writeUint32(hi >>> 0);
    this.writeUint32(lo >>> 0);
  }

  writeUint64(v: bigint) { this.writeInt64(v); }

  writeOpaque(data: Uint8Array) {
    for (const b of data) this.buf.push(b);
    // Pad to 4-byte boundary
    const pad = (4 - (data.length % 4)) % 4;
    for (let i = 0; i < pad; i++) this.buf.push(0);
  }

  writeVarOpaque(data: Uint8Array) {
    this.writeUint32(data.length);
    this.writeOpaque(data);
  }

  writeBool(v: boolean) { this.writeUint32(v ? 1 : 0); }

  toBytes(): Uint8Array { return new Uint8Array(this.buf); }
}

// ── ScVal encoding ───────────────────────────────────────────────────────────

// ScVal type codes per the Stellar XDR spec (Stellar-contract.x, SCValType).
const SCV_SYMBOL = 15;
const SCV_VEC    = 16;
const SCV_ADDRESS = 18;
const SCV_U32    = 3;

interface ScArg {
  type: "address" | "symbol" | "u32" | "vec";
  value: any;
}

function writeScVal(w: XdrWriter, arg: ScArg) {
  switch (arg.type) {
    case "address": {
      w.writeInt32(SCV_ADDRESS);
      const addr = arg.value as string;
      if (addr.startsWith("G")) {
        w.writeInt32(0); // SC_ADDRESS_TYPE_ACCOUNT
        w.writeOpaque(decodeStrKey(addr));
      } else {
        w.writeInt32(1); // SC_ADDRESS_TYPE_CONTRACT
        w.writeOpaque(decodeStrKey(addr));
      }
      break;
    }
    case "symbol": {
      w.writeInt32(SCV_SYMBOL);
      const bytes = new TextEncoder().encode(arg.value as string);
      w.writeUint32(bytes.length);
      w.writeOpaque(bytes);
      break;
    }
    case "u32": {
      w.writeInt32(SCV_U32);
      w.writeUint32(arg.value as number);
      break;
    }
    case "vec": {
      w.writeInt32(SCV_VEC);
      w.writeUint32(1); // optional: present
      const items = arg.value as ScArg[];
      w.writeUint32(items.length);
      for (const item of items) writeScVal(w, item);
      break;
    }
  }
}

// ── Transaction envelope encoding ────────────────────────────────────────────

/**
 * Build a minimal Soroban invoke-contract transaction XDR (base64).
 * This is a read-only simulation transaction using the null account.
 */
export function encodeInvokeTransaction(
  sourceAccount: string,
  networkPassphrase: string,
  contractId: string,
  method: string,
  args: ScArg[],
): string {
  const w = new XdrWriter();

  // TransactionEnvelope discriminant: ENVELOPE_TYPE_TX = 2
  w.writeInt32(2);

  // Transaction
  // - sourceAccount: MuxedAccount (KEY_TYPE_ED25519 = 0)
  w.writeInt32(0);
  w.writeOpaque(decodeStrKey(sourceAccount));

  // - fee (uint32)
  w.writeUint32(100);

  // - seqNum (int64)
  w.writeInt64(1n);

  // - timeBounds (optional: present)
  w.writeUint32(1); // preconditions: PRECOND_TIME = 1
  w.writeUint64(0n); // minTime
  w.writeUint64(BigInt(Math.floor(Date.now() / 1000) + 30)); // maxTime

  // - memo: MEMO_NONE = 0
  w.writeInt32(0);

  // - operations: array of 1
  w.writeUint32(1);

  // Operation
  // - sourceAccount (optional: none)
  w.writeBool(false);

  // - body discriminant: INVOKE_HOST_FUNCTION = 24
  w.writeInt32(24);

  // InvokeHostFunctionOp
  // - hostFunction discriminant: HOST_FUNCTION_TYPE_INVOKE_CONTRACT = 0
  w.writeInt32(0);

  // InvokeContractArgs
  // - contractAddress (ScAddress::Contract)
  w.writeInt32(1); // SC_ADDRESS_TYPE_CONTRACT
  w.writeOpaque(decodeStrKey(contractId));

  // - functionName (SCSymbol = string)
  const fnNameBytes = new TextEncoder().encode(method);
  w.writeUint32(fnNameBytes.length);
  w.writeOpaque(fnNameBytes);

  // - args (SCVec)
  w.writeUint32(args.length);
  for (const arg of args) writeScVal(w, arg);

  // - auth (vec<SorobanAuthorizationEntry>): empty
  w.writeUint32(0);

  // Transaction ext: 0 (for v0)
  // Soroban transactions need ext v1 with SorobanTransactionData, but for simulation
  // the RPC server fills this in. We use ext = 0.
  w.writeInt32(0);

  // Signatures: empty (DecoratedSignature<>)
  w.writeUint32(0);

  return toBase64(w.toBytes());
}

// ── Simulation result decoding ───────────────────────────────────────────────

/**
 * Decode the XDR result from simulateTransaction.
 * Returns a JS object with the decoded ScVal.
 *
 * Since full XDR decoding is complex, we use a pragmatic approach:
 * parse the base64 XDR into the soroban-rpc JSON representation.
 */
export function decodeSimResult(xdrBase64: string): any {
  const bytes = fromBase64(xdrBase64);
  return decodeScVal(bytes, { offset: 0 });
}

interface Cursor { offset: number }

function readUint32(data: Uint8Array, c: Cursor): number {
  const v = (data[c.offset] << 24 | data[c.offset + 1] << 16 | data[c.offset + 2] << 8 | data[c.offset + 3]) >>> 0;
  c.offset += 4;
  return v;
}

function readInt32(data: Uint8Array, c: Cursor): number {
  const v = readUint32(data, c);
  return v > 0x7FFFFFFF ? v - 0x100000000 : v;
}

function readInt64(data: Uint8Array, c: Cursor): bigint {
  const hi = BigInt(readUint32(data, c));
  const lo = BigInt(readUint32(data, c));
  return (hi << 32n) | lo;
}

function readUint64(data: Uint8Array, c: Cursor): bigint {
  const hi = BigInt(readUint32(data, c));
  const lo = BigInt(readUint32(data, c));
  return (hi << 32n) | lo;
}

function readInt128(data: Uint8Array, c: Cursor): bigint {
  const hi = readInt64(data, c);
  const lo = readUint64(data, c);
  return (hi << 64n) | lo;
}

function readOpaque(data: Uint8Array, c: Cursor, len: number): Uint8Array {
  const slice = data.slice(c.offset, c.offset + len);
  c.offset += len;
  // Skip padding
  const pad = (4 - (len % 4)) % 4;
  c.offset += pad;
  return slice;
}

function readString(data: Uint8Array, c: Cursor): string {
  const len = readUint32(data, c);
  const bytes = readOpaque(data, c, len);
  return new TextDecoder().decode(bytes);
}

// ScVal type discriminants per the Stellar XDR spec (SCValType in Stellar-contract.x):
//   0 BOOL, 1 VOID, 2 ERROR, 3 U32, 4 I32, 5 U64, 6 I64, 7 TIMEPOINT,
//   8 DURATION, 9 U128, 10 I128, 11 U256, 12 I256, 13 BYTES, 14 STRING,
//   15 SYMBOL, 16 VEC, 17 MAP, 18 ADDRESS, 19 CONTRACT_INSTANCE,
//   20 LEDGER_KEY_CONTRACT_INSTANCE, 21 LEDGER_KEY_NONCE

export function decodeScVal(data: Uint8Array, c: Cursor): any {
  if (c.offset >= data.length) return null;
  const type = readInt32(data, c);

  switch (type) {
    case 0: { // SCV_BOOL — payload is a 4-byte bool
      return readUint32(data, c) !== 0;
    }
    case 1: { // SCV_VOID
      return null;
    }
    case 2: { // SCV_ERROR — SCError: type (int32) + code (int32)
      const errType = readInt32(data, c);
      const errCode = readInt32(data, c);
      return { error: errType, code: errCode };
    }
    case 3: { // SCV_U32
      return readUint32(data, c);
    }
    case 4: { // SCV_I32
      return readInt32(data, c);
    }
    case 5: { // SCV_U64
      return readUint64(data, c).toString();
    }
    case 6: { // SCV_I64
      return readInt64(data, c).toString();
    }
    case 7: // SCV_TIMEPOINT
    case 8: { // SCV_DURATION
      return readUint64(data, c).toString();
    }
    case 9: { // SCV_U128 — UInt128Parts { hi: u64, lo: u64 }
      const hi = readUint64(data, c);
      const lo = readUint64(data, c);
      return ((hi << 64n) | lo).toString();
    }
    case 10: { // SCV_I128 — Int128Parts { hi: i64, lo: u64 }
      const hi = readInt64(data, c);
      const lo = readUint64(data, c);
      return ((hi << 64n) | lo).toString();
    }
    case 11: // SCV_U256 — 4 × u64 parts
    case 12: { // SCV_I256
      const p0 = type === 12 ? readInt64(data, c) : readUint64(data, c);
      const p1 = readUint64(data, c);
      const p2 = readUint64(data, c);
      const p3 = readUint64(data, c);
      return ((p0 << 192n) | (p1 << 128n) | (p2 << 64n) | p3).toString();
    }
    case 13: { // SCV_BYTES
      const len = readUint32(data, c);
      const bytes = readOpaque(data, c, len);
      return toBase64(bytes);
    }
    case 14: { // SCV_STRING
      return readString(data, c);
    }
    case 15: { // SCV_SYMBOL
      return readString(data, c);
    }
    case 16: { // SCV_VEC
      const present = readUint32(data, c);
      if (!present) return [];
      const len = readUint32(data, c);
      const arr: any[] = [];
      for (let i = 0; i < len; i++) arr.push(decodeScVal(data, c));
      return arr;
    }
    case 17: { // SCV_MAP
      const present = readUint32(data, c);
      if (!present) return {};
      const len = readUint32(data, c);
      const obj: Record<string, any> = {};
      for (let i = 0; i < len; i++) {
        const key = decodeScVal(data, c);
        const val = decodeScVal(data, c);
        if (typeof key === "string") obj[key] = val;
        else obj[String(key)] = val;
      }
      return obj;
    }
    case 18: { // SCV_ADDRESS
      const addrType = readInt32(data, c);
      // SC_ADDRESS_TYPE_ACCOUNT wraps a PublicKey union (extra 4-byte key type);
      // SC_ADDRESS_TYPE_CONTRACT is a raw 32-byte hash.
      if (addrType === 0) readInt32(data, c);
      readOpaque(data, c, 32);
      return `<address:${addrType}>`;
    }
    default: {
      // For types we don't handle, try to skip gracefully
      console.warn(`Unknown ScVal type: ${type} at offset ${c.offset}`);
      return null;
    }
  }
}

export function decodeXdrValue(xdrBase64: string): any {
  return decodeSimResult(xdrBase64);
}
