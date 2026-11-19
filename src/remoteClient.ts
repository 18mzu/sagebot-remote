/**
 * SageBot Remote (phone) side of the protocol (v4).
 *
 * 1. If a non-extractable WebCrypto master session exists in IndexedDB, connects
 *    over the private channel using signed challenge-response (`auth_hello` ->
 *    `auth_ok`) to derive a fresh per-connection AES-256-GCM key.
 *    Never deletes the saved session on timeout (survives Wi-Fi <-> 5G switches).
 * 2. Otherwise performs the ECDH + HMAC pairing handshake while the PC's
 *    3-minute pairing window is open, saves non-extractable WebCrypto keys into
 *    IndexedDB, and immediately transitions into the authenticated session channel.
 */

import { RemoteBridge } from "./remoteBridge";
import {
  channelTopics,
  deriveConnectionKey,
  derivePairResult,
  derivePairSecrets,
  generateEcdhKeyPair,
  importTokenKey,
  isSecureCryptoAvailable,
  isTimestampFresh,
  normalizeCode,
  open,
  randomHex,
  seal,
  signProof,
  verifyProof,
} from "./secureChannel";

export interface SavedSecureSession {
  cid: string;
  code: string;
  channel: string;
  name: string;
  hmacKey: CryptoKey; // non-extractable
  hkdfKey: CryptoKey; // non-extractable
}

const IDB_NAME = "sagebot_remote_secure_v4";
const IDB_STORE = "sessions";
const IDB_KEY = "current";

let memorySessionFallback: SavedSecureSession | null = null;

function clearLegacyLocalStorage() {
  try {
    localStorage.removeItem("sagebot_remote_session_v3");
    localStorage.removeItem("sagebot_room_code");
    localStorage.removeItem("sagebot_secret_token");
  } catch {
    // Ignore
  }
}

function openSessionDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Failed to open IndexedDB"));
  });
}

function isValidSavedSession(val: any): val is SavedSecureSession {
  return (
    val &&
    typeof val.cid === "string" &&
    typeof val.code === "string" &&
    typeof val.channel === "string" &&
    typeof val.name === "string" &&
    val.hmacKey instanceof CryptoKey &&
    val.hkdfKey instanceof CryptoKey
  );
}

export async function loadSavedSession(): Promise<SavedSecureSession | null> {
  clearLegacyLocalStorage();
  try {
    const db = await openSessionDb();
    const record = await new Promise<any>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const store = tx.objectStore(IDB_STORE);
      const req = store.get(IDB_KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (isValidSavedSession(record)) {
      memorySessionFallback = record;
      return record;
    }
  } catch {
    // Fallback to in-memory copy if IndexedDB is restricted
  }
  return memorySessionFallback;
}

export async function saveSecureSession(session: SavedSecureSession): Promise<void> {
  memorySessionFallback = session;
  clearLegacyLocalStorage();
  try {
    const db = await openSessionDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      const req = store.put(session, IDB_KEY);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    db.close();
  } catch {
    // Keep memorySessionFallback if IndexedDB write fails
  }
}

export async function clearSavedSession(): Promise<void> {
  memorySessionFallback = null;
  clearLegacyLocalStorage();
  try {
    const db = await openSessionDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      const req = store.delete(IDB_KEY);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    db.close();
  } catch {
    // Ignore
  }
}

export interface RemoteClientOptions {
  cid: string;
  code: string;
  qrToken?: string;
  deviceName: string;
  resumeSession?: SavedSecureSession;
  onPendingApproval: (fingerprint: string) => void;
  onStatusChange?: (state: "connecting" | "reconnecting" | "pc_offline") => void;
  onConnected: (deviceName: string, session: SavedSecureSession) => void;
  onError: (reason: string, fatal?: boolean) => void;
  onRevoked: (reason: string) => void;
  onMessage: (data: Record<string, any>) => void;
}

export class RemoteClient {
  private opts: RemoteClientOptions;
  private bridge: RemoteBridge | null = null;
  private session: SavedSecureSession | null = null;
  private connKey: CryptoKey | null = null;
  private pendingAuthNonces = new Map<string, number>();

  private pairTimer: ReturnType<typeof setInterval> | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private authRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private offlineTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private authAttemptCount = 0;

  private destroyed = false;
  private connected = false;
  private waitingApproval = false;

  private onlineListener: (() => void) | null = null;
  private offlineListener: (() => void) | null = null;
  private visibilityListener: (() => void) | null = null;

  constructor(opts: RemoteClientOptions) {
    this.opts = opts;
    this.attachNetworkListeners();
    this.start();
  }

  private attachNetworkListeners() {
    if (typeof window !== "undefined") {
      this.onlineListener = () => {
        if (!this.destroyed && this.session) {
          this.nudgeReconnect();
        }
      };
      this.offlineListener = () => {
        if (!this.destroyed && this.session) {
          this.connected = false;
          this.connKey = null;
          this.opts.onStatusChange?.("reconnecting");
        }
      };
      window.addEventListener("online", this.onlineListener);
      window.addEventListener("offline", this.offlineListener);
    }

    if (typeof document !== "undefined") {
      this.visibilityListener = () => {
        if (document.visibilityState === "visible" && !this.destroyed && this.session) {
          this.nudgeReconnect();
        }
      };
      document.addEventListener("visibilitychange", this.visibilityListener);
    }
  }

  private detachNetworkListeners() {
    if (typeof window !== "undefined") {
      if (this.onlineListener) window.removeEventListener("online", this.onlineListener);
      if (this.offlineListener) window.removeEventListener("offline", this.offlineListener);
      this.onlineListener = null;
      this.offlineListener = null;
    }
    if (typeof document !== "undefined") {
      if (this.visibilityListener) document.removeEventListener("visibilitychange", this.visibilityListener);
      this.visibilityListener = null;
    }
  }

  private async start() {
    if (!isSecureCryptoAvailable()) {
      this.opts.onError("Secure WebCrypto requires HTTPS or localhost.", true);
      return;
    }

    if (this.opts.resumeSession) {
      this.activateChannel(this.opts.resumeSession);
    } else {
      await this.startPairing();
    }
  }

  private async startPairing() {
    if (this.destroyed) return;
    const cleanCode = normalizeCode(this.opts.code);
    const cid = this.opts.cid;

    const pair = await derivePairSecrets(cleanCode);
    const { keyPair, pub: mobilePub } = await generateEcdhKeyPair();
    if (this.destroyed) return;

    const proof = await signProof(pair.proofKey, `hello|${cid}|${mobilePub}`);
    let mac: string | undefined;
    const tokenKey = this.opts.qrToken ? await importTokenKey(this.opts.qrToken) : null;
    if (tokenKey) {
      mac = await signProof(tokenKey, `qr|${cid}|${mobilePub}`);
    }

    const sendHello = (b: RemoteBridge) => {
      if (this.destroyed || this.connected || this.waitingApproval) return;
      b.publish(pair.toPc, {
        type: "pair_hello",
        cid,
        name: this.opts.deviceName,
        pub: mobilePub,
        proof,
        ...(mac ? { mac } : {}),
      });
    };

    const pairBridge = new RemoteBridge([pair.toMobile], {
      onBrokerReady: () => {
        sendHello(pairBridge);
        if (!this.pairTimer) {
          this.pairTimer = setInterval(() => sendHello(pairBridge), 1800);
        }
      },
      onMessage: async (_topic, msg) => {
        if (this.destroyed || this.connected || !msg || msg.cid !== cid) return;

        if (msg.type === "pair_blocked") {
          if (!(await verifyProof(pair.proofKey, `blocked|${cid}|${mobilePub}`, msg.proof))) return;
          this.clearStartupTimers();
          pairBridge.destroy();
          this.bridge = null;
          this.opts.onError(
            "Unable to connect to this device.",
            true
          );
          return;
        }

        if (msg.type === "pair_denied") {
          if (!(await verifyProof(pair.proofKey, `denied|${cid}|${mobilePub}`, msg.proof))) return;
          this.clearStartupTimers();
          pairBridge.destroy();
          this.bridge = null;
          this.opts.onError("Pairing request was denied on SageBot PC.", true);
          return;
        }

        if (msg.type === "pair_pending") {
          if (typeof msg.pub !== "string") return;
          if (!(await verifyProof(pair.proofKey, `pc|${cid}|${msg.pub}|${mobilePub}`, msg.proof))) return;
          this.waitingApproval = true;
          this.clearStartupTimers();
          const derived = await derivePairResult(keyPair.privateKey, msg.pub, msg.pub, mobilePub, cid);
          if (!this.destroyed) this.opts.onPendingApproval(derived.fingerprint);
          return;
        }

        if (msg.type === "pair_ok") {
          if (typeof msg.pub !== "string" || !msg.box) return;
          if (!(await verifyProof(pair.proofKey, `pc|${cid}|${msg.pub}|${mobilePub}`, msg.proof))) return;
          if (tokenKey) {
            if (!(await verifyProof(tokenKey, `qr-pc|${cid}|${msg.pub}|${mobilePub}`, msg.mac))) return;
          }

          const derived = await derivePairResult(keyPair.privateKey, msg.pub, msg.pub, mobilePub, cid);
          const unsealed = await open(derived.pairBoxKey, "m", msg.box);
          if (!unsealed || typeof unsealed.channel !== "string") return;

          const newSession: SavedSecureSession = {
            cid,
            code: cleanCode,
            channel: unsealed.channel,
            name: String(unsealed.name || this.opts.deviceName),
            hmacKey: derived.bundle.hmacKey,
            hkdfKey: derived.bundle.hkdfKey,
          };
          await saveSecureSession(newSession);
          this.clearStartupTimers();
          pairBridge.destroy();
          if (!this.destroyed) {
            this.activateChannel(newSession);
          }
        }
      },
    });

    this.bridge = pairBridge;

    this.timeoutTimer = setTimeout(() => {
      if (!this.destroyed && !this.connected && !this.waitingApproval) {
        this.clearStartupTimers();
        pairBridge.destroy();
        this.bridge = null;
        this.opts.onError("Pairing window is closed, code is invalid, or SageBot PC is offline.");
      }
    }, 15000);
  }

  private activateChannel(session: SavedSecureSession) {
    this.session = session;
    this.connected = false;
    this.connKey = null;
    this.waitingApproval = false;
    this.authAttemptCount = 0;
    this.pendingAuthNonces.clear();
    this.clearAuthTimers();

    const topics = channelTopics(session.channel);
    this.opts.onStatusChange?.("connecting");

    const chBridge = new RemoteBridge([topics.toMobile], {
      onBrokerReady: () => {
        if (this.destroyed || this.connected) return;
        this.startAuthHandshake();
      },
      onBrokerReconnect: () => {
        if (this.destroyed) return;
        this.authAttemptCount = 0;
        if (!this.connected) {
          this.startAuthHandshake();
        } else {
          // Confirm live connection or request state sync quickly after broker recovery
          this.send({ action: "request_sync", type: "request_sync" });
        }
      },
      onMessage: async (_topic, msg) => {
        await this.handleChannelMessage(session, msg);
      },
    });

    this.bridge = chBridge;
    this.scheduleOfflineNotice();
  }

  private scheduleOfflineNotice() {
    if (this.offlineTimer) clearTimeout(this.offlineTimer);
    this.offlineTimer = setTimeout(() => {
      this.offlineTimer = null;
      if (!this.destroyed && !this.connected && this.session) {
        // Never wipe the saved session on timeout; keep retrying in background
        this.opts.onStatusChange?.("pc_offline");
      }
    }, 6000);
  }

  private startAuthHandshake() {
    if (this.authRetryTimer) {
      clearTimeout(this.authRetryTimer);
      this.authRetryTimer = null;
    }
    this.sendAuthHello().catch(() => { });
    const scheduleNext = () => {
      if (this.destroyed || this.connected || !this.session) return;
      const delay = this.authAttemptCount >= 5 ? 5000 : 2500;
      this.authRetryTimer = setTimeout(() => {
        this.authRetryTimer = null;
        if (this.destroyed || this.connected || !this.session) return;
        this.sendAuthHello().catch(() => { });
        scheduleNext();
      }, delay);
    };
    scheduleNext();
  }

  private async sendAuthHello() {
    if (this.destroyed || !this.bridge || !this.session) return;
    const session = this.session;
    const topics = channelTopics(session.channel);
    const nonce = randomHex(16);
    const ts = Date.now();
    this.authAttemptCount += 1;

    this.pendingAuthNonces.set(nonce, ts);
    if (this.pendingAuthNonces.size > 8) {
      const oldestKey = this.pendingAuthNonces.keys().next().value;
      if (oldestKey) this.pendingAuthNonces.delete(oldestKey);
    }

    const mac = await signProof(session.hmacKey, `auth-hello|${session.cid}|${nonce}|${ts}`);
    if (this.destroyed || !this.bridge) return;
    this.bridge.publish(topics.toPc, {
      type: "auth_hello",
      cid: session.cid,
      nonce,
      ts,
      mac,
    });
  }

  private async handleChannelMessage(session: SavedSecureSession, msg: any) {
    if (this.destroyed || !msg || msg.cid !== session.cid) return;

    if (msg.type === "auth_ok") {
      const { clientNonce, pcNonce, ts, mac } = msg;
      if (typeof clientNonce !== "string" || typeof pcNonce !== "string") return;
      if (!isTimestampFresh(ts) || !this.pendingAuthNonces.has(clientNonce)) return;
      if (!(await verifyProof(session.hmacKey, `auth-ok|${session.cid}|${clientNonce}|${pcNonce}|${ts}`, mac))) {
        return;
      }
      if (this.destroyed) return;

      this.pendingAuthNonces.clear();
      this.clearAuthTimers();
      this.connKey = await deriveConnectionKey(session.hkdfKey, session.cid, clientNonce, pcNonce);
      this.connected = true;
      this.startHeartbeat();
      this.send({ action: "request_sync", type: "request_sync" });
      this.opts.onConnected(session.name, session);
      return;
    }

    if (msg.type === "auth_rekey") {
      if (!isTimestampFresh(msg.ts)) return;
      if (!(await verifyProof(session.hmacKey, `auth-rekey|${session.cid}|${msg.ts}`, msg.mac))) return;
      if (this.destroyed) return;
      this.connected = false;
      this.connKey = null;
      this.authAttemptCount = 0;
      this.opts.onStatusChange?.("reconnecting");
      this.startAuthHandshake();
      this.scheduleOfflineNotice();
      return;
    }

    if (msg.type === "auth_revoked") {
      if (!isTimestampFresh(msg.ts)) return;
      if (!(await verifyProof(session.hmacKey, `auth-revoked|${session.cid}|${msg.ts}`, msg.mac))) return;
      await clearSavedSession();
      this.destroy();
      this.opts.onRevoked("This device was unpaired on SageBot PC.");
      return;
    }

    if (msg.type === "sec") {
      if (!this.connKey) {
        this.startAuthHandshake();
        return;
      }
      const data = await open(this.connKey, "m", msg);
      if (!data || this.destroyed) return;
      await this.handleIncomingData(data);
    }
  }

  private async handleIncomingData(data: Record<string, any>) {
    if (data.type === "revoked") {
      await clearSavedSession();
      this.destroy();
      this.opts.onRevoked("This device was unpaired on SageBot PC.");
      return;
    }
    if (data.type === "force_logout") {
      await clearSavedSession();
      this.destroy();
      this.opts.onRevoked("Host reset remote pairing. Please pair again.");
      return;
    }
    this.opts.onMessage(data);
  }

  public nudgeReconnect() {
    if (this.destroyed || !this.session) return;
    this.connected = false;
    this.connKey = null;
    this.authAttemptCount = 0;
    this.opts.onStatusChange?.("reconnecting");
    this.bridge?.reconnectNow();
    this.startAuthHandshake();
    this.scheduleOfflineNotice();
  }

  public async unpairAndLogout() {
    if (!this.destroyed && this.connected && this.connKey && this.session && this.bridge) {
      await this.send({ type: "action", action: "unpair" });
      await new Promise((r) => setTimeout(r, 180));
    }
    await clearSavedSession();
    this.destroy();
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.connected && !this.destroyed) {
        this.send({ action: "ping" });
      }
    }, 4500);
  }

  public async send(data: Record<string, any>) {
    if (this.destroyed || !this.connected || !this.session || !this.connKey || !this.bridge) return;
    const topics = channelTopics(this.session.channel);
    try {
      const env = await seal(this.connKey, "pc", this.session.cid, data);
      this.bridge.publish(topics.toPc, env);
    } catch {
      // Ignore
    }
  }

  private clearAuthTimers() {
    if (this.authRetryTimer) {
      clearTimeout(this.authRetryTimer);
      this.authRetryTimer = null;
    }
    if (this.offlineTimer) {
      clearTimeout(this.offlineTimer);
      this.offlineTimer = null;
    }
  }

  private clearStartupTimers() {
    if (this.pairTimer) {
      clearInterval(this.pairTimer);
      this.pairTimer = null;
    }
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  public destroy() {
    this.destroyed = true;
    this.connected = false;
    this.connKey = null;
    this.clearStartupTimers();
    this.clearAuthTimers();
    this.detachNetworkListeners();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.bridge?.destroy();
    this.bridge = null;
  }
}
