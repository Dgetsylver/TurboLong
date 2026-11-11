/**
 * TurboLong's session key for a Nido account's grant: a P-256 key made with
 * WebCrypto as non-extractable, so its private half can sign but never be read
 * out of this browser, kept in this origin's IndexedDB (one per account).
 *
 * Nido's grant page takes an app key as a P-256 public key (`pubkey=`) and the
 * account checks it with its WebAuthn verifier. That verifier checks the
 * challenge, the `webauthn.get` type, the user-present and user-verified flag
 * bits, and the P-256 signature over `authenticatorData ‖ sha256(clientData)`;
 * it checks no relying party or origin. So this key assembles the assertion
 * itself and signs with no device prompt. It is a hot key by design: the
 * grant's rules (contracts, functions, recipient, cap, expiry) are what limit
 * it, and the account enforces them on every call.
 */
import { type WebAuthnAssertion, concat, sha256, toBase64url, toHex } from "./grant";

/** WebAuthn authenticator flags: user present (UP) and user verified (UV). */
const FLAGS_UP_UV = 0x05;
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const ALGORITHM: EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };

export interface SessionKey {
  /** The 65-byte uncompressed point (`04‖X‖Y`), lowercase hex. */
  publicKeyHex: string;
  privateKey: CryptoKey;
}

/** A new non-extractable P-256 key. */
export async function generateSessionKey(subtle: SubtleCrypto = crypto.subtle): Promise<SessionKey> {
  const pair = (await subtle.generateKey(ALGORITHM, false, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("Unexpected P-256 public key format");
  return { publicKeyHex: toHex(raw), privateKey: pair.privateKey };
}

/** `r‖s` with `s` in the lower half of the curve order: the host refuses high-S. */
export function lowS(signature: Uint8Array): Uint8Array {
  if (signature.length !== 64) throw new Error("Expected a 64-byte P-256 signature");
  const s = BigInt(`0x${toHex(signature.slice(32))}`);
  if (s <= P256_N / 2n) return signature;
  const flipped = (P256_N - s).toString(16).padStart(64, "0");
  return concat(
    signature.slice(0, 32),
    Uint8Array.from(flipped.match(/../g)!, (b) => Number.parseInt(b, 16)),
  );
}

/** The assertion an authenticator would return for `challenge` on `origin`. */
export async function signAssertion(
  key: Pick<SessionKey, "privateKey">,
  challenge: Uint8Array,
  origin: string,
  subtle: SubtleCrypto = crypto.subtle,
): Promise<WebAuthnAssertion> {
  const { hostname } = new URL(origin);
  const authenticatorData = concat(sha256(new TextEncoder().encode(hostname)), Uint8Array.of(FLAGS_UP_UV, 0, 0, 0, 0));
  const clientDataJson = new TextEncoder().encode(
    JSON.stringify({ type: "webauthn.get", challenge: toBase64url(challenge), origin, crossOrigin: false }),
  );
  const message = concat(authenticatorData, sha256(clientDataJson));
  const signature = new Uint8Array(
    await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, new Uint8Array(message)),
  );
  return { authenticatorData, clientDataJson, signature: lowS(signature) };
}

// ── Storage (IndexedDB: a CryptoKey survives structured clone, still unexportable) ─

const DB = "turbolong-grants";
const STORE = "session-keys";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = op(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export const loadSessionKey = (account: string): Promise<SessionKey | undefined> =>
  run<SessionKey | undefined>("readonly", (s) => s.get(account));

export const saveSessionKey = (account: string, key: SessionKey): Promise<void> =>
  run<void>("readwrite", (s) => s.put(key, account));

export const deleteSessionKey = (account: string): Promise<void> => run<void>("readwrite", (s) => s.delete(account));

/** This browser's key for `account`, made on first use. */
export async function sessionKeyFor(account: string): Promise<SessionKey> {
  const stored = await loadSessionKey(account);
  if (stored) return stored;
  const key = await generateSessionKey();
  await saveSessionKey(account, key);
  return key;
}
