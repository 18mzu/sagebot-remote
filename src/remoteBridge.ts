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
  // Variable header: Protocol Name "MQTT", Level 4 (3.1.1), CleanSession (0x02), KeepAlive 60s
  const vh = new Uint8Array([0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x04, 0x02, 0x00, 0x3c]);
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

function buildSubscribePacket(topic: string, packetId = 1): Uint8Array {
  const pid = new Uint8Array([(packetId >> 8) & 0xff, packetId & 0xff]);
  const tb = encodeMqttString(topic);
  const qos = new Uint8Array([0x00]);
  const remLen = pid.length + tb.length + qos.length;
  const varLen = encodeVarLen(remLen);
  const out = new Uint8Array(1 + varLen.length + remLen);
  out[0] = 0x82;
  out.set(varLen, 1);
  out.set(pid, 1 + varLen.length);
  out.set(tb, 1 + varLen.length + pid.length);
  out.set(qos, 1 + varLen.length + pid.length + tb.length);
  return out;
}

function buildPublishPacket(topic: string, payloadStr: string, retain = false): Uint8Array {
  const tb = encodeMqttString(topic);
  const pb = encodeUtf8(payloadStr);
  const remLen = tb.length + pb.length;
  const varLen = encodeVarLen(remLen);
  const out = new Uint8Array(1 + varLen.length + remLen);
  out[0] = retain ? 0x31 : 0x30;
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
  onMessage: (data: any) => void;
  onError?: (err: string) => void;
}

interface ChunkBuffer {
  parts: (string | undefined)[];
  received: number;
  total: number;
  createdAt: number;
}

export class RemoteBridge {
  private subTopic: string;
  private pubTopic: string;
  private callbacks: BridgeCallbacks;
  private sockets: WebSocket[] = [];
  private readyCount = 0;
  private destroyed = false;
  private seenMessageIds = new Set<string>();
  private seenOrder: string[] = [];
  private chunkBuffers = new Map<string, ChunkBuffer>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimers: ReturnType<typeof setTimeout>[] = [];

  constructor(
    roomCode: string,
    role: "pc" | "mobile",
    callbacks: BridgeCallbacks
  ) {
    const cleanRoom = roomCode.trim().toLowerCase();
    this.subTopic =
      role === "pc"
        ? `sagebot/v2/${cleanRoom}/to_pc`
        : `sagebot/v2/${cleanRoom}/to_mobile`;
    this.pubTopic =
      role === "pc"
        ? `sagebot/v2/${cleanRoom}/to_mobile`
        : `sagebot/v2/${cleanRoom}/to_pc`;
    this.callbacks = callbacks;

    this.connectAll();
    this.pingTimer = setInterval(() => this.sendPing(), 20000);
  }

  private connectAll() {
    BROKERS.forEach((url, idx) => {
      this.connectBroker(url, idx);
    });
  }

  private connectBroker(url: string, idx: number) {
    if (this.destroyed) return;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url, "mqtt");
    } catch {
      this.scheduleReconnect(url, idx);
      return;
    }

    ws.binaryType = "arraybuffer";
    this.sockets[idx] = ws;
    let isBrokerReady = false;
    let rxBuffer = new Uint8Array(0);

    ws.onopen = () => {
      if (this.destroyed) {
        ws.close();
        return;
      }
      const clientId = randomId("sb");
      ws.send(buildConnectPacket(clientId).buffer as ArrayBuffer);
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (this.destroyed || !(ev.data instanceof ArrayBuffer)) return;
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
          // Wait for more bytes
          break;
        }

        const packetEnd = i + remLen;
        const packetType = header & 0xf0;

        if (packetType === 0x20) {
          // CONNACK -> Subscribe immediately
          ws.send(buildSubscribePacket(this.subTopic, idx + 1).buffer as ArrayBuffer);
        } else if (packetType === 0x90) {
          // SUBACK -> Ready!
          if (!isBrokerReady) {
            isBrokerReady = true;
            this.readyCount += 1;
            if (this.readyCount === 1 && this.callbacks.onBrokerReady) {
              this.callbacks.onBrokerReady();
            }
          }
        } else if (packetType === 0x30) {
          // PUBLISH
          let pIdx = i;
          const topicLen = (rxBuffer[pIdx] << 8) | rxBuffer[pIdx + 1];
          pIdx += 2 + topicLen;
          const qos = (header & 0x06) >> 1;
          if (qos > 0) {
            pIdx += 2; // Packet Identifier
          }
          if (pIdx <= packetEnd) {
            const payloadBytes = rxBuffer.subarray(pIdx, packetEnd);
            const rawStr = decodeUtf8(payloadBytes);
            this.handleIncomingRaw(rawStr);
          }
        }

        offset = packetEnd;
      }

      if (offset > 0) {
        rxBuffer = rxBuffer.slice(offset);
      }
    };

    ws.onclose = () => {
      if (isBrokerReady) {
        isBrokerReady = false;
        this.readyCount = Math.max(0, this.readyCount - 1);
      }
      this.scheduleReconnect(url, idx);
    };

    ws.onerror = () => {
      // Handled by onclose
    };
  }

  private scheduleReconnect(url: string, idx: number) {
    if (this.destroyed) return;
    const t = setTimeout(() => {
      this.connectBroker(url, idx);
    }, 2500);
    this.reconnectTimers.push(t);
  }

  private sendPing() {
    for (const ws of this.sockets) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(PINGREQ_PACKET.buffer as ArrayBuffer);
        } catch {
          // Ignore
        }
      }
    }
  }

  private markSeen(mid: string): boolean {
    if (this.seenMessageIds.has(mid)) return false;
    this.seenMessageIds.add(mid);
    this.seenOrder.push(mid);
    if (this.seenOrder.length > 300) {
      const oldest = this.seenOrder.shift();
      if (oldest) this.seenMessageIds.delete(oldest);
    }
    return true;
  }

  private handleIncomingRaw(rawStr: string) {
    try {
      const parsed = JSON.parse(rawStr);
      if (!parsed || typeof parsed !== "object") return;

      if (parsed._mid && !this.markSeen(parsed._mid)) {
        return; // Duplicate from secondary broker
      }

      if (parsed._chunk) {
        const { id, idx, total, part } = parsed;
        if (typeof id !== "string" || typeof idx !== "number" || typeof total !== "number") return;
        let buf = this.chunkBuffers.get(id);
        if (!buf) {
          buf = {
            parts: new Array(total),
            received: 0,
            total,
            createdAt: Date.now(),
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
          this.callbacks.onMessage(fullObj);
        }
        return;
      }

      this.callbacks.onMessage(parsed);
    } catch {
      // Ignore malformed JSON
    }
  }

  public send(data: Record<string, any>, retain = false) {
    if (this.destroyed) return;
    const msgWithId = { ...data, _mid: randomId("m") };
    const fullStr = JSON.stringify(msgWithId);

    if (fullStr.length <= CHUNK_SIZE) {
      this.publishRaw(fullStr, retain);
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
        this.publishRaw(chunkMsg, false);
      }
    }
  }

  private publishRaw(payloadStr: string, retain: boolean) {
    const packet = buildPublishPacket(this.pubTopic, payloadStr, retain);
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
    for (const t of this.reconnectTimers) clearTimeout(t);
    for (const ws of this.sockets) {
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
