/**
 * Minimal RFC 6455 WebSocket client over node:net.
 *
 * Why this exists: the device matrix drives a real Chromium over the Chrome
 * DevTools Protocol, which is a WebSocket. This project has no dependencies
 * (see docs/adr/0002), and `globalThis.WebSocket` is only reliably present
 * from Node 21 onward. ~200 lines of framing buys the whole runner a Node 18
 * floor and no install step.
 *
 * Scope is deliberately narrow — client side, no extensions, no compression,
 * localhost only. It handles exactly what CDP needs: large fragmented text
 * frames (a full-page screenshot arrives as multi-megabyte base64), ping/pong
 * keepalive, and clean close.
 */

import net from "node:net";
import { randomBytes, createHash } from "node:crypto";
import { EventEmitter } from "node:events";

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * @typedef {object} WsEvents
 * @property {(data: string) => void} message
 * @property {(err: Error) => void} error
 * @property {() => void} open
 * @property {(code: number, reason: string) => void} close
 */

export class MiniWebSocket extends EventEmitter {
  /**
   * @param {string} url ws://host:port/path
   * @param {{ maxPayloadBytes?: number; handshakeTimeoutMs?: number }} [opts]
   */
  constructor(url, opts = {}) {
    super();
    const parsed = new URL(url);
    if (parsed.protocol !== "ws:") {
      throw new Error(`MiniWebSocket only speaks ws: (got ${parsed.protocol}); CDP is always local`);
    }
    this.url = url;
    this.maxPayloadBytes = opts.maxPayloadBytes ?? 256 * 1024 * 1024;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 15000;

    this.readyState = /** @type {"connecting"|"open"|"closing"|"closed"} */ ("connecting");

    /** @type {Buffer[]} */
    this._chunks = [];
    this._total = 0;
    this._handshakeDone = false;
    /** Accumulated fragments of a message split across frames. */
    /** @type {Buffer[]} */
    this._fragments = [];
    this._fragmentOpcode = 0;

    this._key = randomBytes(16).toString("base64");
    this._expectedAccept = createHash("sha1").update(this._key + GUID).digest("base64");

    const port = Number(parsed.port || 80);
    this._socket = net.connect({ host: parsed.hostname, port }, () => {
      this._socket.setNoDelay(true);
      const path = `${parsed.pathname}${parsed.search}`;
      this._socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: ${parsed.host}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Key: ${this._key}\r\n` +
          "Sec-WebSocket-Version: 13\r\n" +
          "\r\n",
      );
    });

    this._handshakeTimer = setTimeout(() => {
      if (!this._handshakeDone) this._fail(new Error(`websocket handshake to ${url} timed out`));
    }, this.handshakeTimeoutMs);

    this._socket.on("data", (chunk) => this._onData(chunk));
    this._socket.on("error", (err) => this._fail(err));
    this._socket.on("close", () => {
      clearTimeout(this._handshakeTimer);
      if (this.readyState !== "closed") {
        this.readyState = "closed";
        this.emit("close", 1006, "socket closed");
      }
    });
  }

  /** @param {string} url @param {{ handshakeTimeoutMs?: number }} [opts] */
  static connect(url, opts) {
    return new Promise((resolve, reject) => {
      const ws = new MiniWebSocket(url, opts);
      const onOpen = () => {
        ws.off("error", onError);
        resolve(ws);
      };
      /** @param {Error} err */
      const onError = (err) => {
        ws.off("open", onOpen);
        reject(err);
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
    });
  }

  /** @param {string} text */
  send(text) {
    if (this.readyState !== "open") throw new Error(`websocket is ${this.readyState}, cannot send`);
    this._socket.write(encodeFrame(OP_TEXT, Buffer.from(text, "utf8")));
  }

  /** @param {number} [code] @param {string} [reason] */
  close(code = 1000, reason = "") {
    if (this.readyState === "closed" || this.readyState === "closing") return;
    this.readyState = "closing";
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    try {
      this._socket.write(encodeFrame(OP_CLOSE, payload));
    } catch {
      /* socket already gone */
    }
    // Do not wait forever for a courteous close handshake.
    setTimeout(() => this._socket.destroy(), 500).unref?.();
  }

  destroy() {
    this.readyState = "closed";
    this._socket.destroy();
  }

  /** @param {Error} err */
  _fail(err) {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    clearTimeout(this._handshakeTimer);
    this._socket.destroy();
    this.emit("error", err);
  }

  /** @param {Buffer} chunk */
  _onData(chunk) {
    this._chunks.push(chunk);
    this._total += chunk.length;
    if (!this._handshakeDone) {
      if (!this._tryHandshake()) return;
    }
    this._drainFrames();
  }

  /** @returns {boolean} true once the HTTP upgrade response has been consumed */
  _tryHandshake() {
    const buf = this._flatten();
    const idx = buf.indexOf("\r\n\r\n");
    if (idx < 0) {
      this._restore(buf);
      return false;
    }
    const head = buf.subarray(0, idx).toString("latin1");
    const statusLine = head.split("\r\n")[0] ?? "";
    if (!/^HTTP\/1\.1 101/.test(statusLine)) {
      this._fail(new Error(`websocket upgrade rejected: ${statusLine || "<no status line>"}`));
      return false;
    }
    const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1];
    if (accept && accept !== this._expectedAccept) {
      this._fail(new Error("websocket Sec-WebSocket-Accept mismatch"));
      return false;
    }
    this._handshakeDone = true;
    clearTimeout(this._handshakeTimer);
    this._restore(buf.subarray(idx + 4));
    this.readyState = "open";
    this.emit("open");
    return true;
  }

  _drainFrames() {
    for (;;) {
      const frame = this._tryReadFrame();
      if (!frame) return;
      this._handleFrame(frame);
      if (this.readyState === "closed") return;
    }
  }

  /**
   * Reads one frame if a complete one is buffered. Reads the header without
   * concatenating, so waiting on a multi-megabyte payload does not re-copy the
   * buffer on every TCP chunk.
   *
   * @returns {{ fin: boolean; opcode: number; payload: Buffer } | null}
   */
  _tryReadFrame() {
    if (this._total < 2) return null;
    const b0 = this._byteAt(0);
    const b1 = this._byteAt(1);
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (this._total < 4) return null;
      len = (this._byteAt(2) << 8) | this._byteAt(3);
      offset = 4;
    } else if (len === 127) {
      if (this._total < 10) return null;
      let big = 0n;
      for (let i = 2; i < 10; i++) big = (big << 8n) | BigInt(this._byteAt(i));
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        this._fail(new Error("websocket frame length exceeds Number.MAX_SAFE_INTEGER"));
        return null;
      }
      len = Number(big);
      offset = 10;
    }
    if (len > this.maxPayloadBytes) {
      this._fail(new Error(`websocket frame of ${len} bytes exceeds the ${this.maxPayloadBytes} byte cap`));
      return null;
    }
    // A conforming server never masks; handle it anyway rather than corrupting.
    const maskLen = masked ? 4 : 0;
    const totalNeeded = offset + maskLen + len;
    if (this._total < totalNeeded) return null;

    const buf = this._flatten();
    let payload = buf.subarray(offset + maskLen, totalNeeded);
    if (masked) {
      const mask = buf.subarray(offset, offset + 4);
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    } else {
      payload = Buffer.from(payload);
    }
    this._restore(buf.subarray(totalNeeded));
    return { fin, opcode, payload };
  }

  /** @param {{ fin: boolean; opcode: number; payload: Buffer }} frame */
  _handleFrame(frame) {
    const { fin, opcode, payload } = frame;
    switch (opcode) {
      case OP_PING:
        if (this.readyState === "open") this._socket.write(encodeFrame(OP_PONG, payload));
        return;
      case OP_PONG:
        return;
      case OP_CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
        if (this.readyState === "open") {
          this.readyState = "closing";
          try {
            this._socket.write(encodeFrame(OP_CLOSE, payload));
          } catch {
            /* ignore */
          }
        }
        this.readyState = "closed";
        this._socket.destroy();
        this.emit("close", code, reason);
        return;
      }
      case OP_CONTINUATION:
        this._fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(this._fragments);
          const op = this._fragmentOpcode;
          this._fragments = [];
          this._fragmentOpcode = 0;
          this._emitMessage(op, full);
        }
        return;
      case OP_TEXT:
      case OP_BINARY:
        if (fin) {
          this._emitMessage(opcode, payload);
        } else {
          this._fragmentOpcode = opcode;
          this._fragments = [payload];
        }
        return;
      default:
        this._fail(new Error(`unsupported websocket opcode 0x${opcode.toString(16)}`));
    }
  }

  /** @param {number} opcode @param {Buffer} payload */
  _emitMessage(opcode, payload) {
    if (opcode === OP_TEXT) this.emit("message", payload.toString("utf8"));
    else this.emit("binary", payload);
  }

  /** @param {number} i */
  _byteAt(i) {
    let idx = i;
    for (const chunk of this._chunks) {
      if (idx < chunk.length) return chunk[idx];
      idx -= chunk.length;
    }
    throw new RangeError(`byteAt(${i}) out of range`);
  }

  /** @returns {Buffer} */
  _flatten() {
    const buf = this._chunks.length === 1 ? this._chunks[0] : Buffer.concat(this._chunks, this._total);
    this._chunks = [];
    this._total = 0;
    return buf;
  }

  /** @param {Buffer} rest */
  _restore(rest) {
    if (rest.length) {
      this._chunks = [rest];
      this._total = rest.length;
    } else {
      this._chunks = [];
      this._total = 0;
    }
  }
}

/**
 * Client frames must be masked (RFC 6455 §5.3).
 *
 * @param {number} opcode
 * @param {Buffer} payload
 * @returns {Buffer}
 */
export function encodeFrame(opcode, payload) {
  const len = payload.length;
  let headerLen = 2 + 4;
  if (len >= 65536) headerLen += 8;
  else if (len > 125) headerLen += 2;

  const frame = Buffer.allocUnsafe(headerLen + len);
  frame[0] = 0x80 | opcode; // FIN + opcode
  let offset = 2;
  if (len >= 65536) {
    frame[1] = 0x80 | 127;
    frame.writeUInt32BE(0, 2);
    frame.writeUInt32BE(len, 6);
    offset = 10;
  } else if (len > 125) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(len, 2);
    offset = 4;
  } else {
    frame[1] = 0x80 | len;
  }
  const mask = randomBytes(4);
  mask.copy(frame, offset);
  offset += 4;
  for (let i = 0; i < len; i++) frame[offset + i] = payload[i] ^ mask[i & 3];
  return frame;
}
