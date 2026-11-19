/**
 * SageBot Remote secure channel (protocol v4).
 *
 * This file is shared byte-for-byte between SageBot PC and SageBot Remote.
 *
 * The MQTT brokers are public, so everything published there must be assumed
 * readable by strangers. The rules are:
 *   1. The 8-character pairing code is never published. Topics and proofs are
 *      derived from it with PBKDF2, and PC only listens while the 3-minute
 *      pairing window is explicitly open.
 *   2. Secrets are never published. Pairing uses ECDH P-256 to agree on a
 *      256-bit master secret. Phone keeps only non-extractable WebCrypto
 *      HMAC + HKDF handles (in IndexedDB); PC stores the secret encrypted
 *      with Windows DPAPI.
 *   3. Every reconnect performs a signed nonce challenge-response (`auth_hello`
 *      -> `auth_ok`) to derive a fresh per-connection AES-256-GCM key via HKDF.
 *   4. Every session message is AES-256-GCM encrypted with strict AAD, 2-minute
 *      timestamp window, and IV replay protection.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

const PROTOCOL = "sb/v4";
const PAIR_SALT = "sagebot-remote/pair/v4";
const PAIR_ITERATIONS = 150_000;
const MAX_CLOCK_SKEW_MS = 2 * 60 * 1000;
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // 32 chars -> unbiased with & 31

export type Direction = "pc" | "m";

export interface Envelope {
  type: "sec";
  cid: string;
  iv: string;
  ct: string;
}

export interface PairSecrets {
  toPc: string;
  toMobile: string;
  proofKey: CryptoKey;
}

export interface MasterKeyBundle {
  hmacKey: CryptoKey;
  hkdfKey: CryptoKey;
}

export interface DerivedPairResult {
  keyB64: string;
  pairBoxKey: CryptoKey;
  bundle: MasterKeyBundle;
  fingerprint: string;
}

export function isSecureCryptoAvailable(): boolean {
  return typeof crypto !== "undefined" && !!crypto.subtle;
}

export function isTimestampFresh(ts: unknown): boolean {
  return typeof ts === "number" && Number.isFinite(ts) && Math.abs(Date.now() - ts) <= MAX_CLOCK_SKEW_MS;
}

export function toB64(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function fromB64(str: string): Uint8Array<ArrayBuffer> {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toHex(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomHex(byteLength: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export function normalizeCode(code: string): string {
  return code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

export function formatCodeDisplay(code: string): string {
  const clean = normalizeCode(code).slice(0, 8);
  return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

export function generatePairCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => CODE_ALPHABET[b & 31]).join("");
}

/** Pairing topics and the code-proof key, derived from the code with PBKDF2. */
export async function derivePairSecrets(code: string): Promise<PairSecrets> {
  const base = await crypto.subtle.importKey("raw", enc.encode(normalizeCode(code)), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(PAIR_SALT), iterations: PAIR_ITERATIONS },
      base,
      384
    )
  );
  const topicId = toHex(bits.slice(0, 16));
  const proofKey = await crypto.subtle.importKey("raw", bits.slice(16), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return {
    toPc: `${PROTOCOL}/p/${topicId}/pc`,
    toMobile: `${PROTOCOL}/p/${topicId}/m`,
    proofKey,
  };
}

export function channelTopics(channelId: string): { toPc: string; toMobile: string } {
  return {
    toPc: `${PROTOCOL}/c/${channelId}/pc`,
    toMobile: `${PROTOCOL}/c/${channelId}/m`,
  };
}

async function hmacHex(key: CryptoKey, message: string): Promise<string> {
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

/** Constant-time string comparison. */
function safeEqual(a: unknown, b: string): boolean {
  if (typeof a !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signProof(key: CryptoKey, message: string): Promise<string> {
  return hmacHex(key, message);
}

export async function verifyProof(key: CryptoKey, message: string, proof: unknown): Promise<boolean> {
  return safeEqual(proof, await hmacHex(key, message));
}

export async function importTokenKey(token: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function importMasterKeysFromBytes(raw: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<MasterKeyBundle> {
  const [hmacKey, hkdfKey] = await Promise.all([
    crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]),
  ]);
  return { hmacKey, hkdfKey };
}

export async function importMasterKeysFromB64(keyB64: string): Promise<MasterKeyBundle> {
  return importMasterKeysFromBytes(fromB64(keyB64));
}

export async function generateEcdhKeyPair(): Promise<{ keyPair: CryptoKeyPair; pub: string }> {
  const keyPair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const pub = toB64(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  return { keyPair, pub };
}

/**
 * Derives the per-device 256-bit master secret, non-extractable WebCrypto
 * handles, one-time pairing box key, and a 6-digit visual fingerprint.
 */
export async function derivePairResult(
  privateKey: CryptoKey,
  peerPub: string,
  pcPub: string,
  mobilePub: string,
  cid: string
): Promise<DerivedPairResult> {
  const peer = await crypto.subtle.importKey("raw", fromB64(peerPub), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, privateKey, 256);
  const hkdf = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const transcript = enc.encode(`${pcPub}|${mobilePub}`);
  const salt = await crypto.subtle.digest("SHA-256", transcript);
  const masterBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode(`sagebot-remote/master/v4/${cid}`) },
    hkdf,
    256
  );

  const [pairBoxKey, bundle, fpHashBuf] = await Promise.all([
    crypto.subtle.importKey("raw", masterBits, "AES-GCM", false, ["encrypt", "decrypt"]),
    importMasterKeysFromBytes(masterBits),
    crypto.subtle.digest("SHA-256", enc.encode(`fp|${pcPub}|${mobilePub}`)),
  ]);

  const fpHash = new Uint8Array(fpHashBuf);
  const fpNum = ((fpHash[0] << 24) | (fpHash[1] << 16) | (fpHash[2] << 8) | fpHash[3]) >>> 0;
  const digits = String(fpNum % 1_000_000).padStart(6, "0");

  return {
    keyB64: toB64(masterBits),
    pairBoxKey,
    bundle,
    fingerprint: `${digits.slice(0, 3)} ${digits.slice(3)}`,
  };
}

/**
 * Derives a fresh non-extractable AES-256-GCM key for a single authenticated
 * WebSocket session from the master HKDF key + both handshake nonces.
 */
export async function deriveConnectionKey(
  hkdfKey: CryptoKey,
  cid: string,
  clientNonce: string,
  pcNonce: string
): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode(`conn|${clientNonce}|${pcNonce}`),
      info: enc.encode(`sagebot-remote/conn/v4/${cid}`),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

const seenIvs = new Map<string, number>();

function rememberIv(iv: string, now: number): boolean {
  if (seenIvs.has(iv)) return false;
  seenIvs.set(iv, now);
  if (seenIvs.size > 2000) {
    for (const [k, t] of seenIvs) {
      if (now - t > MAX_CLOCK_SKEW_MS * 2) seenIvs.delete(k);
    }
  }
  return true;
}

export async function seal(aesKey: CryptoKey, dir: Direction, cid: string, data: Record<string, any>): Promise<Envelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = enc.encode(JSON.stringify({ ...data, _ts: Date.now() }));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(`sb4|${dir}|${cid}`) },
    aesKey,
    plaintext
  );
  return { type: "sec", cid, iv: toB64(iv), ct: toB64(ct) };
}

/** Returns the decrypted message, or null if it is forged, tampered, stale or replayed. */
export async function open(aesKey: CryptoKey, dir: Direction, env: any): Promise<Record<string, any> | null> {
  if (!env || env.type !== "sec" || typeof env.cid !== "string" || typeof env.iv !== "string" || typeof env.ct !== "string") {
    return null;
  }
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(env.iv), additionalData: enc.encode(`sb4|${dir}|${env.cid}`) },
      aesKey,
      fromB64(env.ct)
    );
    const data = JSON.parse(dec.decode(plain));
    const now = Date.now();
    if (!data || !isTimestampFresh(data._ts)) return null;
    if (!rememberIv(env.iv, now)) return null;
    delete data._ts;
    return data;
  } catch {
    return null;
  }
}
