/**
 * SageBot Remote (phone) side of the protocol (v3).
 *
 * 1. If a saved per-device session exists for this code (and no fresh QR token
 *    was scanned), resumes directly over the encrypted private channel.
 * 2. Otherwise performs the ECDH + HMAC pairing handshake on PBKDF2-derived
 *    topics, verifies the PC's proof (and QR MAC if scanned), unseals the
 *    private channel ID, and transitions to the AES-256-GCM session channel.
 */

import { RemoteBridge } from "./remoteBridge";
import {
  channelTopics,
  derivePairSecrets,
  deriveSessionKey,
  generateEcdhKeyPair,
  importTokenKey,
  isSecureCryptoAvailable,
  normalizeCode,
  open,
  seal,
  signProof,
  verifyProof,
} from "./secureChannel";

export interface SavedSession {
  cid: string;
  code: string;
  channel: string;
  key: string;
  name: string;
}

const SESSION_STORAGE_KEY = "sagebot_remote_session_v3";

export function loadSavedSession(code: string): SavedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedSession;
    if (
      parsed &&
      typeof parsed.cid === "string" &&
      typeof parsed.code === "string" &&
      typeof parsed.channel === "string" &&
      typeof parsed.key === "string" &&
      normalizeCode(parsed.code) === normalizeCode(code)
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function clearSavedSession() {
  localStorage.removeItem(SESSION_STORAGE_KEY);
}

function saveSession(session: SavedSession) {
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

export interface RemoteClientOptions {
  cid: string;
  code: string;
  qrToken?: string;
  deviceName: string;
  onPendingApproval: (fingerprint: string) => void;
  onConnected: (deviceName: string) => void;
  onError: (reason: string, fatal?: boolean) => void;
  onRevoked: (reason: string) => void;
  onMessage: (data: Record<string, any>) => void;
}

export class RemoteClient {
  private opts: RemoteClientOptions;
  private bridge: RemoteBridge | null = null;
  private session: SavedSession | null = null;
  private pairTimer: ReturnType<typeof setInterval> | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private connected = false;
  private waitingApproval = false;

  constructor(opts: RemoteClientOptions) {
    this.opts = opts;
    this.start();
  }

  private async start() {
    if (!isSecureCryptoAvailable()) {
      this.opts.onError("Secure WebCrypto requires HTTPS or localhost.", true);
      return;
    }

    const cleanCode = normalizeCode(this.opts.code);
    const saved = !this.opts.qrToken ? loadSavedSession(cleanCode) : null;
    if (saved && saved.cid === this.opts.cid) {
      this.startResumeOrPair(saved);
    } else {
      await this.startPairing();
    }
  }

  private startResumeOrPair(saved: SavedSession) {
    const topics = channelTopics(saved.channel);
    let fellBackToPair = false;

    const bridge = new RemoteBridge([topics.toMobile], {
      onBrokerReady: () => {
        if (this.destroyed || fellBackToPair) return;
        seal(saved.key, "pc", saved.cid, { action: "hello", type: "request_sync" })
          .then((env) => bridge.publish(topics.toPc, env))
          .catch(() => {});
      },
      onMessage: async (_topic, env) => {
        if (this.destroyed || fellBackToPair) return;
        if (!env || env.cid !== saved.cid) return;
        const data = await open(saved.key, "m", env);
        if (!data || this.destroyed) return;

        if (!this.connected) {
          this.clearStartupTimers();
          this.session = saved;
          this.connected = true;
          this.startHeartbeat();
          this.opts.onConnected(saved.name);
        }
        this.handleIncomingData(data);
      },
    });

    this.bridge = bridge;

    // If the PC doesn't answer on the saved session within 3.5s (e.g. device was removed), fall back to pairing.
    this.timeoutTimer = setTimeout(() => {
      if (this.destroyed || this.connected) return;
      fellBackToPair = true;
      clearSavedSession();
      bridge.destroy();
      this.bridge = null;
      this.startPairing();
    }, 3500);
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
            "Unique Control is active on SageBot PC: only one device can be paired at a time.",
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
          const { fingerprint } = await deriveSessionKey(keyPair.privateKey, msg.pub, msg.pub, mobilePub, cid);
          if (!this.destroyed) this.opts.onPendingApproval(fingerprint);
          return;
        }

        if (msg.type === "pair_ok") {
          if (typeof msg.pub !== "string" || !msg.box) return;
          if (!(await verifyProof(pair.proofKey, `pc|${cid}|${msg.pub}|${mobilePub}`, msg.proof))) return;
          if (tokenKey) {
            if (!(await verifyProof(tokenKey, `qr-pc|${cid}|${msg.pub}|${mobilePub}`, msg.mac))) return;
          }

          const { key } = await deriveSessionKey(keyPair.privateKey, msg.pub, msg.pub, mobilePub, cid);
          const unsealed = await open(key, "m", msg.box);
          if (!unsealed || typeof unsealed.channel !== "string") return;

          const newSession: SavedSession = {
            cid,
            code: cleanCode,
            channel: unsealed.channel,
            key,
            name: String(unsealed.name || this.opts.deviceName),
          };
          saveSession(newSession);
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
        this.opts.onError("Code is invalid or SageBot PC is not running.");
      }
    }, 10000);
  }

  private activateChannel(session: SavedSession) {
    this.session = session;
    this.connected = true;
    this.waitingApproval = false;
    const topics = channelTopics(session.channel);

    const chBridge = new RemoteBridge([topics.toMobile], {
      onBrokerReady: () => {
        this.send({ action: "request_sync", type: "request_sync" });
      },
      onMessage: async (_topic, env) => {
        if (this.destroyed || !env || env.cid !== session.cid) return;
        const data = await open(session.key, "m", env);
        if (!data || this.destroyed) return;
        this.handleIncomingData(data);
      },
    });

    this.bridge = chBridge;
    this.startHeartbeat();
    this.opts.onConnected(session.name);
  }

  private handleIncomingData(data: Record<string, any>) {
    if (data.type === "revoked") {
      clearSavedSession();
      this.destroy();
      this.opts.onRevoked("This device was removed on SageBot PC.");
      return;
    }
    if (data.type === "force_logout") {
      clearSavedSession();
      this.destroy();
      this.opts.onRevoked("Host reset remote pairing code. Please enter the new code.");
      return;
    }
    this.opts.onMessage(data);
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
    if (this.destroyed || !this.connected || !this.session || !this.bridge) return;
    const topics = channelTopics(this.session.channel);
    try {
      const env = await seal(this.session.key, "pc", this.session.cid, data);
      this.bridge.publish(topics.toPc, env);
    } catch {
      // Ignore
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
    this.clearStartupTimers();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.bridge?.destroy();
    this.bridge = null;
  }
}

