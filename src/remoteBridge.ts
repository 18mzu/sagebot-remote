/**
 * Dual-Broker MQTT-over-WebSocket (WSS) Bridge for SageBot Remote.
 *
 * Uses standard HTTPS/WSS ports (no WebRTC UDP hole-punching required),
 * so it connects reliably across 4G/5G cellular networks, CGNAT, home routers,
 * and internet cafe firewalls.
 */

const BROKERS = [
  "wss://broker.emqx.io:8084/mqtt",
  "wss://broker.hivemq.com:8884/mqtt",
];

const CHUNK_SIZE = 14000;
const CHUNK_PACE_MS = 25;
const PING_INTERVAL_MS = 15000;
const PONG_TIMEOUT_MS = 12000;

function encodeVarLen(len: number): number[] {
  const bytes: number[] = [];
  do {
    let enc = len % 128;
    len = Math.floor(len / 128);
    if (len > 0) enc |= 128;
    bytes.push(enc);
  } while (len > 0);
  return bytes;
}

function encodeUtf8(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function encodeMqttString(str: string): Uint8Array {
  const b = encodeUtf8(str);
  const out = new Uint8Array(2 + b.length);
  out[0] = (b.length >> 8) & 0xff;
  out[1] = b.length & 0xff;
  out.set(b, 2);
  return out;
}

function buildConnectPacket(clientId: string): Uint8Array {
  // Variable header: Protocol Name "MQTT", Level 4 (3.1.1), CleanSession (0x02), KeepAlive 45s
  const vh = new Uint8Array([0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x04, 0x02, 0x00, 0x2d]);
  const pl = encodeMqttString(clientId);
  const remLen = vh.length + pl.length;
  const varLen = encodeVarLen(remLen);
  const out = new Uint8Array(1 + varLen.length + remLen);
  out[0] = 0x10;
  out.set(varLen, 1);
  out.set(vh, 1 + varLen.length);
  out.set(pl, 1 + varLen.length + vh.length);
  return out;
}

function buildSubscribePacket(topics: string[], packetId = 1): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([(packetId >> 8) & 0xff, packetId & 0xff])];
  for (const topic of topics) {
    parts.push(encodeMqttString(topic), new Uint8Array([0x00]));
  }
  const remLen = parts.reduce((n, p) => n + p.length, 0);
  const varLen = encodeVarLen(remLen);
  const out = new Uint8Array(1 + varLen.length + remLen);
  out[0] = 0x82;
  out.set(varLen, 1);
  let offset = 1 + varLen.length;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function buildPublishPacket(topic: string, payloadStr: string): Uint8Array {
  const tb = encodeMqttString(topic);
  const pb = encodeUtf8(payloadStr);
  const remLen = tb.length + pb.length;
  const varLen = encodeVarLen(remLen);
  const out = new Uint8Array(1 + varLen.length + remLen);
  out[0] = 0x30;
  out.set(varLen, 1);
  out.set(tb, 1 + varLen.length);
  out.set(pb, 1 + varLen.length + tb.length);
  return out;
}

const PINGREQ_PACKET = new Uint8Array([0xc0, 0x00]);

function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

export interface BridgeCallbacks {
  onBrokerReady?: () => void;
  onBrokerReconnect?: () => void;
  onMessage: (topic: string, data: any) => void;
}

interface ChunkBuffer {
  parts: (string | undefined)[];
  received: number;
  total: number;
  createdAt: number;
}

/**
 * Pure transport: subscribes to a dynamic set of topics and publishes JSON.
 * It knows nothing about pairing or encryption (see secureChannel.ts).
 */
export class RemoteBridge {
  private subTopics: string[];
  private callbacks: BridgeCallbacks;
  private sockets: (WebSocket | null)[] = [];
  private socketGens: number[] = [];
  private readySockets = new Set<number>();
  private hasBeenReadyBefore = false;
  private awaitingPongAt: number[] = [];
  private nextPacketId = 10;
  private destroyed = false;
  private seenMessageIds = new Set<string>();
  private seenOrder: string[] = [];
  private chunkBuffers = new Map<string, ChunkBuffer>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimers: (ReturnType<typeof setTimeout> | null)[] = [];
  private reconnectNotifyTimer: ReturnType<typeof setTimeout> | null = null;
  private chunkTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(subTopics: string[], callbacks: BridgeCallbacks) {
    this.subTopics = [...subTopics];
    this.callbacks = callbacks;

    this.connectAll();
    this.pingTimer = setInterval(() => this.sendPing(), PING_INTERVAL_MS);
  }

  public isReady(): boolean {
    return this.readySockets.size > 0;
  }

  public addTopic(topic: string) {
    if (this.destroyed || !topic || this.subTopics.includes(topic)) return;
    this.subTopics.push(topic);
    const pkt = buildSubscribePacket([topic], this.nextPacketId++).buffer as ArrayBuffer;
    for (let i = 0; i < this.sockets.length; i++) {
      const ws = this.sockets[i];
      if (ws && ws.readyState === WebSocket.OPEN && this.readySockets.has(i)) {
        try {
          ws.send(pkt);
        } catch {
          // Ignore; next reconnect will subscribe to full list
        }
      }
    }
  }

  public removeTopic(topic: string) {
    this.subTopics = this.subTopics.filter((t) => t !== topic);
  }

  public reconnectNow() {
    if (this.destroyed) return;
    for (let i = 0; i < this.reconnectTimers.length; i++) {
      const t = this.reconnectTimers[i];
      if (t) clearTimeout(t);
      this.reconnectTimers[i] = null;
    }
    this.readySockets.clear();
    for (let i = 0; i < this.sockets.length; i++) {
      this.socketGens[i] = (this.socketGens[i] || 0) + 1;
      this.awaitingPongAt[i] = 0;
      const ws = this.sockets[i];
      if (ws) {
        try {
          ws.close();
        } catch {
          // Ignore
        }
      }
      this.sockets[i] = null;
    }
    this.connectAll();
  }

  private connectAll() {
    BROKERS.forEach((url, idx) => {
      this.connectBroker(url, idx);
    });
  }

  private connectBroker(url: string, idx: number) {
    if (this.destroyed) return;

    const gen = (this.socketGens[idx] || 0) + 1;
    this.socketGens[idx] = gen;
    this.awaitingPongAt[idx] = 0;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url, "mqtt");
    } catch {
      this.scheduleReconnect(url, idx, gen);
      return;
    }

    ws.binaryType = "arraybuffer";
    this.sockets[idx] = ws;
    let rxBuffer = new Uint8Array(0);

    ws.onopen = () => {
      if (this.destroyed || this.socketGens[idx] !== gen) {
        try { ws.close(); } catch {}
        return;
      }
      const clientId = randomId("sb");
      ws.send(buildConnectPacket(clientId).buffer as ArrayBuffer);
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (this.destroyed || this.socketGens[idx] !== gen || !(ev.data instanceof ArrayBuffer)) return;
      const incoming = new Uint8Array(ev.data);
      const merged = new Uint8Array(rxBuffer.length + incoming.length);
      merged.set(rxBuffer, 0);
      merged.set(incoming, rxBuffer.length);
      rxBuffer = merged;

      // Parse all complete MQTT packets in rxBuffer
      let offset = 0;
      while (offset < rxBuffer.length) {
        const header = rxBuffer[offset];
        let i = offset + 1;
        let mult = 1;
        let remLen = 0;
        let completeLen = false;

        while (i < rxBuffer.length) {
          const b = rxBuffer[i++];
          remLen += (b & 127) * mult;
          mult *= 128;
          if ((b & 128) === 0) {
            completeLen = true;
            break;
          }
        }

        if (!completeLen || i + remLen > rxBuffer.length) {
          break;
        }

        const packetEnd = i + remLen;
        const packetType = header & 0xf0;

        if (packetType === 0x20) {
          // CONNACK -> Subscribe immediately
          if (this.subTopics.length > 0) {
            ws.send(buildSubscribePacket(this.subTopics, idx + 1).buffer as ArrayBuffer);
          } else {
            this.markBrokerReady(idx);
          }
        } else if (packetType === 0x90) {
          // SUBACK -> Ready!
          this.markBrokerReady(idx);
        } else if (packetType === 0xd0) {
          // PINGRESP -> Connection confirmed alive
          this.awaitingPongAt[idx] = 0;
        } else if (packetType === 0x30) {
          // PUBLISH
          this.awaitingPongAt[idx] = 0;
          let pIdx = i;
          const topicLen = (rxBuffer[pIdx] << 8) | rxBuffer[pIdx + 1];
          const topic = decodeUtf8(rxBuffer.subarray(pIdx + 2, pIdx + 2 + topicLen));
          pIdx += 2 + topicLen;
          const qos = (header & 0x06) >> 1;
          if (qos > 0) {
            pIdx += 2;
          }
          if (pIdx <= packetEnd) {
            const payloadBytes = rxBuffer.subarray(pIdx, packetEnd);
            const rawStr = decodeUtf8(payloadBytes);
            this.handleIncomingRaw(topic, rawStr);
          }
        }

        offset = packetEnd;
      }

      if (offset > 0) {
        rxBuffer = rxBuffer.slice(offset);
      }
    };

    ws.onclose = () => {
      if (this.socketGens[idx] !== gen) return;
      this.readySockets.delete(idx);
      this.awaitingPongAt[idx] = 0;
      this.scheduleReconnect(url, idx, gen);
    };

    ws.onerror = () => {
      // Handled by onclose
    };
  }

  private markBrokerReady(idx: number) {
    const wasReady = this.readySockets.has(idx);
    this.readySockets.add(idx);
    if (!wasReady && this.readySockets.size === 1) {
      this.callbacks.onBrokerReady?.();
    }
    if (this.hasBeenReadyBefore && this.callbacks.onBrokerReconnect) {
      if (this.reconnectNotifyTimer) clearTimeout(this.reconnectNotifyTimer);
      this.reconnectNotifyTimer = setTimeout(() => {
        this.reconnectNotifyTimer = null;
        if (!this.destroyed) {
          this.callbacks.onBrokerReconnect?.();
        }
      }, 250);
    }
    this.hasBeenReadyBefore = true;
  }

  private scheduleReconnect(url: string, idx: number, expectedGen: number) {
    if (this.destroyed || this.socketGens[idx] !== expectedGen) return;
    if (this.reconnectTimers[idx]) {
      clearTimeout(this.reconnectTimers[idx]!);
    }
    this.reconnectTimers[idx] = setTimeout(() => {
      this.reconnectTimers[idx] = null;
      if (!this.destroyed && this.socketGens[idx] === expectedGen) {
        this.connectBroker(url, idx);
      }
    }, 2000);
  }

  private sendPing() {
    const now = Date.now();
    for (let i = 0; i < this.sockets.length; i++) {
      const ws = this.sockets[i];
      if (!ws || ws.readyState !== WebSocket.OPEN) continue;

      const lastPing = this.awaitingPongAt[i] || 0;
      if (lastPing > 0 && now - lastPing > PONG_TIMEOUT_MS) {
        // Silent half-open socket (common on mobile Wi-Fi <-> 5G transitions): force close -> immediate reconnect
        try {
          ws.close();
        } catch {
          // Ignore
        }
        continue;
      }

      try {
        ws.send(PINGREQ_PACKET.buffer as ArrayBuffer);
        if (lastPing === 0) {
          this.awaitingPongAt[i] = now;
        }
      } catch {
        // Ignore
      }
    }
  }

  private markSeen(mid: string): boolean {
    if (this.seenMessageIds.has(mid)) return false;
    this.seenMessageIds.add(mid);
    this.seenOrder.push(mid);
    if (this.seenOrder.length > 600) {
      const oldest = this.seenOrder.shift();
      if (oldest) this.seenMessageIds.delete(oldest);
    }
    return true;
  }

  private handleIncomingRaw(topic: string, rawStr: string) {
    if (!this.subTopics.includes(topic)) return;
    try {
      const parsed = JSON.parse(rawStr);
      if (!parsed || typeof parsed !== "object") return;

      if (parsed._mid && !this.markSeen(parsed._mid)) {
        return; // Duplicate from secondary broker
      }

      if (parsed._chunk) {
        const { id, idx, total, part } = parsed;
        if (typeof id !== "string" || typeof idx !== "number" || typeof total !== "number") return;
        if (total < 1 || total > 200 || idx < 0 || idx >= total) return;
        const now = Date.now();
        for (const [k, b] of this.chunkBuffers) {
          if (now - b.createdAt > 30000) this.chunkBuffers.delete(k);
        }
        let buf = this.chunkBuffers.get(id);
        if (!buf) {
          buf = {
            parts: new Array(total),
            received: 0,
            total,
            createdAt: now,
          };
          this.chunkBuffers.set(id, buf);
        }
        if (buf.parts[idx] === undefined) {
          buf.parts[idx] = part;
          buf.received += 1;
        }
        if (buf.received === buf.total) {
          this.chunkBuffers.delete(id);
          const fullJson = buf.parts.join("");
          const fullObj = JSON.parse(fullJson);
          this.callbacks.onMessage(topic, fullObj);
        }
        return;
      }

      this.callbacks.onMessage(topic, parsed);
    } catch {
      // Ignore malformed JSON
    }
  }

  public publish(topic: string, data: Record<string, any>) {
    if (this.destroyed) return;
    const msgWithId = { ...data, _mid: randomId("m") };
    const fullStr = JSON.stringify(msgWithId);

    if (fullStr.length <= CHUNK_SIZE) {
      this.publishRaw(topic, fullStr);
    } else {
      const chunkGroupId = randomId("cg");
      const total = Math.ceil(fullStr.length / CHUNK_SIZE);
      for (let i = 0; i < total; i++) {
        const part = fullStr.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        const chunkMsg = JSON.stringify({
          _mid: `${chunkGroupId}-${i}`,
          _chunk: true,
          id: chunkGroupId,
          idx: i,
          total,
          part,
        });
        if (i === 0) {
          this.publishRaw(topic, chunkMsg);
        } else {
          const t = setTimeout(() => {
            this.chunkTimers.delete(t);
            if (!this.destroyed) {
              this.publishRaw(topic, chunkMsg);
            }
          }, i * CHUNK_PACE_MS);
          this.chunkTimers.add(t);
        }
      }
    }
  }

  private publishRaw(topic: string, payloadStr: string) {
    const packet = buildPublishPacket(topic, payloadStr);
    for (const ws of this.sockets) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(packet.buffer as ArrayBuffer);
        } catch {
          // Ignore
        }
      }
    }
  }

  public destroy() {
    this.destroyed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectNotifyTimer) clearTimeout(this.reconnectNotifyTimer);
    for (const t of this.reconnectTimers) {
      if (t) clearTimeout(t);
    }
    this.reconnectTimers = [];
    for (const t of this.chunkTimers) {
      clearTimeout(t);
    }
    this.chunkTimers.clear();
    this.readySockets.clear();
    for (let i = 0; i < this.sockets.length; i++) {
      this.socketGens[i] = (this.socketGens[i] || 0) + 1;
      const ws = this.sockets[i];
      if (ws) {
        try {
          ws.close();
        } catch {
          // Ignore
        }
      }
    }
    this.sockets = [];
  }
}
