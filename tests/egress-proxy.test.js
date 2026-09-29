import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { PassThrough } from "node:stream";
import { authorizeEgressConnect, startEgressProxy } from "../apps/control-plane/src/egress-proxy.js";

const allow = ["https://stage.example.test"];

test("CONNECT authorization requires an exact HTTPS origin and returns the checked address", async () => {
  let lookups = 0;
  const result = await authorizeEgressConnect("stage.example.test:443", allow, {
    lookupAll: async (hostname) => { lookups += 1; assert.equal(hostname, "stage.example.test"); return ["93.184.216.34"]; },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.address, "93.184.216.34");
  assert.deepEqual(result.addresses, ["93.184.216.34"]);
  assert.equal(lookups, 1);
});

test("CONNECT authorization rejects malformed, non-HTTPS, alternate-port and unlisted authorities before DNS", async () => {
  for (const authority of [
    "other.example.test:443",
    "stage.example.test:8443",
    "stage.example.test",
    "stage.example.test:",
    "stage.example.test:443/",
    "user@stage.example.test:443",
    "stage.example.test:443?token=x",
  ]) {
    let lookedUp = false;
    const result = await authorizeEgressConnect(authority, allow, { lookupAll: async () => { lookedUp = true; return ["93.184.216.34"]; } });
    assert.equal(result.allowed, false, authority);
    assert.equal(lookedUp, false, authority);
  }
});

test("one private answer in a mixed DNS response refuses the whole CONNECT", async () => {
  const result = await authorizeEgressConnect("stage.example.test:443", allow, {
    lookupAll: async () => ["93.184.216.34", "169.254.169.254"],
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /refused/);
  assert.deepEqual(result.addresses, ["93.184.216.34", "169.254.169.254"]);
});

test("proxy dials the numeric address it checked and exposes only CONNECT", async (t) => {
  let dialed;
  let upstream;
  const proxy = await startEgressProxy({
    allowedOrigins: allow,
    lookupAll: async () => ["93.184.216.34"],
    dial: (address, port) => {
      dialed = { address, port };
      upstream = new PassThrough();
      queueMicrotask(() => upstream.emit("connect"));
      return upstream;
    },
  });
  t.after(async () => proxy.close());

  const response = await new Promise((resolve, reject) => {
    const client = net.connect(proxy.port, proxy.host);
    let data = "";
    const timer = setTimeout(() => { client.destroy(); reject(new Error("proxy response timed out")); }, 2000);
    client.once("error", (error) => { clearTimeout(timer); reject(error); });
    client.on("data", (chunk) => {
      data += chunk.toString();
      if (data.includes("\r\n\r\n")) {
        clearTimeout(timer);
        client.destroy();
        resolve(data);
      }
    });
    client.once("connect", () => client.write("CONNECT stage.example.test:443 HTTP/1.1\r\nHost: stage.example.test:443\r\n\r\n"));
  });
  assert.match(response, /^HTTP\/1\.1 200 Connection Established/);
  assert.deepEqual(dialed, { address: "93.184.216.34", port: 443 });
  upstream?.destroy();
});

test("proxy refuses plain HTTP requests", async (t) => {
  const proxy = await startEgressProxy({ allowedOrigins: allow, lookupAll: async () => ["93.184.216.34"] });
  t.after(async () => proxy.close());
  const response = await new Promise((resolve, reject) => {
    const client = net.connect(proxy.port, proxy.host);
    let data = "";
    client.once("error", reject);
    client.on("data", (chunk) => { data += chunk.toString(); });
    client.once("end", () => resolve(data));
    client.once("connect", () => client.write("GET http://stage.example.test/ HTTP/1.1\r\nHost: stage.example.test\r\nConnection: close\r\n\r\n"));
  });
  assert.match(response, /^HTTP\/1\.1 403/);
});

test("optional boundary diagnostics report only allow/deny booleans, never authorities", async (t) => {
  const decisions = [];
  const proxy = await startEgressProxy({
    allowedOrigins: allow,
    lookupAll: async () => ["93.184.216.34"],
    dial: () => {
      const upstream = new PassThrough();
      queueMicrotask(() => upstream.emit("connect"));
      return upstream;
    },
    onDecision: (allowed) => decisions.push(allowed),
  });
  t.after(async () => proxy.close());
  const request = (authority) => new Promise((resolve, reject) => {
    const client = net.connect(proxy.port, proxy.host);
    let response = "";
    const timer = setTimeout(() => { client.destroy(); reject(new Error("proxy decision timed out")); }, 2000);
    client.once("error", (error) => { clearTimeout(timer); reject(error); });
    client.on("data", (chunk) => {
      response += chunk.toString("latin1");
      if (response.includes("\r\n\r\n")) { clearTimeout(timer); client.destroy(); resolve(response); }
    });
    client.once("connect", () => client.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
  });
  assert.match(await request("stage.example.test:443"), /^HTTP\/1\.1 200/);
  assert.match(await request("metadata.internal:443"), /^HTTP\/1\.1 403/);
  assert.deepEqual(decisions, [true, false]);
  assert.equal(JSON.stringify(decisions).includes("metadata.internal"), false);
});

test("per-job tunnel limit returns 503 while an earlier tunnel is active", async (t) => {
  const proxy = await startEgressProxy({
    allowedOrigins: allow,
    maxTunnels: 1,
    lookupAll: async () => ["93.184.216.34"],
    dial: () => {
      const socket = new PassThrough();
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    },
  });
  t.after(async () => proxy.close());

  const first = net.connect(proxy.port, proxy.host);
  t.after(() => first.destroy());
  await new Promise((resolve, reject) => {
    first.once("error", reject);
    first.once("connect", () => {
      first.write("CONNECT stage.example.test:443 HTTP/1.1\r\nHost: stage.example.test:443\r\n\r\n");
      first.once("data", (chunk) => chunk.toString().includes("200 Connection Established") ? resolve() : reject(new Error("first tunnel was not established")));
    });
  });

  const secondResponse = await new Promise((resolve, reject) => {
    const second = net.connect(proxy.port, proxy.host);
    let data = "";
    second.once("error", reject);
    second.on("data", (chunk) => { data += chunk.toString(); });
    second.once("end", () => resolve(data));
    second.once("connect", () => second.write("CONNECT stage.example.test:443 HTTP/1.1\r\nHost: stage.example.test:443\r\n\r\n"));
  });
  assert.match(secondResponse, /^HTTP\/1\.1 503 Service Unavailable/);
});
