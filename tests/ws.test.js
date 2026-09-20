/**
 * The hand-written WebSocket client.
 *
 * This is the riskiest module in the repo. It is ~350 lines of RFC 6455 written
 * to avoid a dependency (ADR-0002), it sits underneath every CDP call, and its
 * failure mode is not an exception — it is a hang, or a silently truncated
 * message that surfaces three layers up as "Chrome didn't respond". So it is
 * tested against a real socket rather than by inspecting the code.
 *
 * The server side below is deliberately minimal and written from the RFC, not
 * from the client under test: a test that reuses the implementation's own
 * framing would agree with any bug it contains.
 */

import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createHash } from "node:crypto";
import { once } from "node:events";

import { MiniWebSocket, encodeFrame } from "../src/runner/ws.js";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Server→client frames are never masked (RFC 6455 §5.1). */
function serverFrame(opcode, payload = Buffer.alloc(0), fin = true) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, payload]);
}

/** Incremental client→server frame parser. Client frames are always masked. */
function parseFrames(buf) {
  const frames = [];
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let headerLen = 2;
    if (len === 126) {
      if (buf.length - off < 4) break;
      len = buf.readUInt16BE(off + 2);
      headerLen = 4;
    } else if (len === 127) {
      if (buf.length - off < 10) break;
      len = Number(buf.readBigUInt64BE(off + 2));
      headerLen = 10;
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length - off < headerLen + maskLen + len) break;
    const mask = buf.subarray(off + headerLen, off + headerLen + maskLen);
    const raw = Buffer.from(buf.subarray(off + headerLen + maskLen, off + headerLen + maskLen + len));
    if (masked) for (let i = 0; i < raw.length; i++) raw[i] ^= mask[i & 3];
    frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, masked, payload: raw });
    off += headerLen + maskLen + len;
  }
  return { frames, rest: buf.subarray(off) };
}

/**
 * A one-connection WebSocket server.
 * @param {(api: {send: (b: Buffer) => void; frames: any[]; socket: net.Socket}) => void} [onOpen]
 * @param {{ badAccept?: boolean; status?: string }} [opts]
 */
async function startServer(onOpen, opts = {}) {
  /** @type {any[]} */
  const received = [];
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    let upgraded = false;
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const idx = buf.indexOf("\r\n\r\n");
        if (idx < 0) return;
        const head = buf.subarray(0, idx).toString("latin1");
        buf = buf.subarray(idx + 4);
        upgraded = true;

        if (opts.status) {
          socket.write(`${opts.status}\r\n\r\n`);
          return;
        }
        const key = /sec-websocket-key:\s*(\S+)/i.exec(head)?.[1] ?? "";
        const accept = opts.badAccept
          ? "obviously-wrong"
          : createHash("sha1").update(key + GUID).digest("base64");
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        onOpen?.({ send: (b) => socket.write(b), frames: received, socket });
        return;
      }
      const { frames, rest } = parseFrames(buf);
      buf = rest;
      received.push(...frames);
    });
    socket.on("error", () => {});
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = /** @type {any} */ (server.address()).port;
  return {
    port,
    url: `ws://127.0.0.1:${port}/devtools/test`,
    received,
    close: () => new Promise((r) => server.close(() => r(undefined))),
  };
}

/* ── frame encoding ───────────────────────────────────────────────────────── */

test("encodeFrame sets FIN, the opcode, and the mask bit", () => {
  const frame = encodeFrame(0x1, Buffer.from("hi"));
  assert.equal(frame[0], 0x81, "FIN + text opcode");
  assert.equal(frame[1] & 0x80, 0x80, "client frames MUST be masked");
  assert.equal(frame[1] & 0x7f, 2, "payload length");
  assert.equal(frame.length, 2 + 4 + 2);
});

test("encodeFrame picks the shortest legal length form", () => {
  assert.equal(encodeFrame(0x1, Buffer.alloc(125))[1] & 0x7f, 125, "7-bit form up to 125");
  const medium = encodeFrame(0x1, Buffer.alloc(126));
  assert.equal(medium[1] & 0x7f, 126, "16-bit form from 126");
  assert.equal(medium.readUInt16BE(2), 126);
  const large = encodeFrame(0x1, Buffer.alloc(65536));
  assert.equal(large[1] & 0x7f, 127, "64-bit form from 65536");
  assert.equal(large.readBigUInt64BE(2), 65536n);
});

test("the mask is applied correctly and is not a fixed key", () => {
  const payload = Buffer.from("the quick brown fox");
  const frame = encodeFrame(0x1, payload);
  const mask = frame.subarray(2, 6);
  const body = Buffer.from(frame.subarray(6));
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  assert.ok(body.equals(payload), "unmasking must recover the payload exactly");

  // A constant mask would still round-trip, and would still be a spec violation
  // with real security consequences for intermediaries.
  const masks = new Set(Array.from({ length: 8 }, () => encodeFrame(0x1, payload).subarray(2, 6).toString("hex")));
  assert.ok(masks.size > 1, "the masking key must be random per frame");
});

test("an empty payload still produces a well-formed frame", () => {
  const frame = encodeFrame(0x9, Buffer.alloc(0));
  assert.equal(frame.length, 6);
  assert.equal(frame[0] & 0x0f, 0x9);
});

/* ── handshake ────────────────────────────────────────────────────────────── */

test("only ws: is accepted — CDP is always local", () => {
  // wss: would need TLS the client does not implement; failing at construction
  // is far better than failing inside the handshake with a parse error.
  assert.throws(() => new MiniWebSocket("wss://example.com/x"), /ws:/);
  assert.throws(() => new MiniWebSocket("http://example.com/x"), /ws:/);
});

test("a full handshake opens the socket", async () => {
  const server = await startServer();
  const ws = new MiniWebSocket(server.url);
  await once(ws, "open");
  assert.equal(ws.readyState, "open");
  ws.close();
  await server.close();
});

test("a wrong Sec-WebSocket-Accept is rejected", async () => {
  // The one check that proves the peer actually spoke WebSocket rather than
  // being some other server that happened to answer 101.
  const server = await startServer(undefined, { badAccept: true });
  const ws = new MiniWebSocket(server.url);
  const [err] = await once(ws, "error");
  assert.match(err.message, /Accept mismatch/);
  await server.close();
});

test("a non-101 response fails with the status line, not a timeout", async () => {
  const server = await startServer(undefined, { status: "HTTP/1.1 403 Forbidden" });
  const ws = new MiniWebSocket(server.url);
  const [err] = await once(ws, "error");
  assert.match(err.message, /403/);
  await server.close();
});

/* ── messages ─────────────────────────────────────────────────────────────── */

test("a text message round-trips in both directions", async () => {
  const server = await startServer(({ send }) => send(serverFrame(0x1, Buffer.from('{"id":1,"result":{}}'))));
  const ws = new MiniWebSocket(server.url);
  const [msg] = await once(ws, "message");
  assert.equal(msg, '{"id":1,"result":{}}');

  ws.send('{"id":2,"method":"Page.enable"}');
  // Let the write land before asserting on what the server parsed.
  await new Promise((r) => setTimeout(r, 50));
  const text = server.received.filter((f) => f.opcode === 0x1);
  assert.equal(text.length, 1);
  assert.equal(text[0].masked, true, "the client must mask every frame it sends");
  assert.equal(text[0].payload.toString("utf8"), '{"id":2,"method":"Page.enable"}');
  ws.close();
  await server.close();
});

test("a fragmented message is reassembled", async () => {
  // CDP sends large screenshot responses fragmented. Dropping continuation
  // frames would truncate base64 image data — which decodes to a corrupt PNG
  // rather than to an error, and would have quietly poisoned every diff.
  const server = await startServer(({ send }) => {
    send(serverFrame(0x1, Buffer.from('{"id":1,"res'), false));
    send(serverFrame(0x0, Buffer.from('ult":{"data":"AA'), false));
    send(serverFrame(0x0, Buffer.from('AA"}}'), true));
  });
  const ws = new MiniWebSocket(server.url);
  const [msg] = await once(ws, "message");
  assert.equal(msg, '{"id":1,"result":{"data":"AAAA"}}');
  ws.close();
  await server.close();
});

test("a payload over 64 KiB round-trips through the 64-bit length form", async () => {
  const big = JSON.stringify({ id: 1, result: { data: "x".repeat(200_000) } });
  const server = await startServer(({ send }) => send(serverFrame(0x1, Buffer.from(big))));
  const ws = new MiniWebSocket(server.url);
  const [msg] = await once(ws, "message");
  assert.equal(msg.length, big.length);
  assert.equal(msg, big);
  ws.close();
  await server.close();
});

test("a payload arriving in many TCP chunks is still one message", async () => {
  // TCP does not preserve write boundaries. This is the bug that only appears
  // under load, which is exactly when the matrix runner is running.
  const body = Buffer.from(JSON.stringify({ id: 7, result: { data: "y".repeat(5000) } }));
  const server = await startServer(({ send }) => {
    const frame = serverFrame(0x1, body);
    for (let i = 0; i < frame.length; i += 97) send(frame.subarray(i, i + 97));
  });
  const ws = new MiniWebSocket(server.url);
  const [msg] = await once(ws, "message");
  assert.equal(msg, body.toString("utf8"));
  ws.close();
  await server.close();
});

test("two frames delivered in one chunk produce two messages", async () => {
  const server = await startServer(({ send }) => {
    send(Buffer.concat([serverFrame(0x1, Buffer.from("one")), serverFrame(0x1, Buffer.from("two"))]));
  });
  const ws = new MiniWebSocket(server.url);
  /** @type {string[]} */
  const seen = [];
  ws.on("message", (m) => seen.push(m));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(seen, ["one", "two"]);
  ws.close();
  await server.close();
});

/* ── control frames ───────────────────────────────────────────────────────── */

test("a ping is answered with a pong carrying the same payload", async () => {
  const server = await startServer(({ send }) => send(serverFrame(0x9, Buffer.from("keepalive"))));
  const ws = new MiniWebSocket(server.url);
  await once(ws, "open");
  await new Promise((r) => setTimeout(r, 100));
  const pongs = server.received.filter((f) => f.opcode === 0xa);
  assert.equal(pongs.length, 1, "an unanswered ping gets the connection killed by the peer");
  assert.equal(pongs[0].payload.toString("utf8"), "keepalive");
  ws.close();
  await server.close();
});

test("a close frame surfaces its code and reason", async () => {
  const payload = Buffer.alloc(2 + 7);
  payload.writeUInt16BE(1001, 0);
  payload.write("going", 2);
  const server = await startServer(({ send }) => send(serverFrame(0x8, payload)));
  const ws = new MiniWebSocket(server.url);
  const [code, reason] = await once(ws, "close");
  assert.equal(code, 1001);
  assert.equal(reason, "going");
  assert.equal(ws.readyState, "closed");
  await server.close();
});

test("a close with no payload reports 1005, not a crash", async () => {
  const server = await startServer(({ send }) => send(serverFrame(0x8)));
  const ws = new MiniWebSocket(server.url);
  const [code] = await once(ws, "close");
  assert.equal(code, 1005);
  await server.close();
});

test("an oversized frame is refused rather than buffered", async () => {
  // Without the cap, a malformed length field is an out-of-memory crash that
  // takes the whole matrix run with it.
  const server = await startServer(({ send }) => {
    const header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(64n * 1024n * 1024n, 2);
    send(header);
  });
  const ws = new MiniWebSocket(server.url, { maxPayloadBytes: 1024 });
  const [err] = await once(ws, "error");
  assert.match(err.message, /exceeds/);
  await server.close();
});

test("a socket that dies mid-session reports a close, not a hang", async () => {
  const server = await startServer(({ socket }) => socket.destroy());
  const ws = new MiniWebSocket(server.url);
  const [code] = await once(ws, "close");
  assert.equal(code, 1006);
  await server.close();
});

test("the handshake times out instead of waiting forever", async () => {
  // A server that accepts the TCP connection and then says nothing is exactly
  // what a half-started Chrome looks like.
  const server = net.createServer(() => {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = /** @type {any} */ (server.address()).port;

  const ws = new MiniWebSocket(`ws://127.0.0.1:${port}/x`, { handshakeTimeoutMs: 120 });
  const [err] = await once(ws, "error");
  assert.match(err.message, /handshake|timed out|timeout/i);
  await new Promise((r) => server.close(() => r(undefined)));
});
