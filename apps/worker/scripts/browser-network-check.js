import assert from "node:assert/strict";
import dns from "node:dns/promises";
import net from "node:net";
import { launchBrowser } from "../../../src/runner/cdp.js";

const fixtureAddress = "93.184.216.2";
const proxyUrl = new URL(process.env.ATLAS_EGRESS_PROXY ?? "");
assert.equal(proxyUrl.protocol, "http:");
assert.ok(net.isIP(proxyUrl.hostname), "proxy address must be numeric");
assert.equal(proxyUrl.port, "3128");

await assert.rejects(dns.lookup("fixture.example.test"), "worker DNS must be disabled");
await assertDirectSocketBlocked(fixtureAddress, 443, "fixture target direct-connect bypass");
await assertDirectSocketBlocked("1.1.1.1", 443, "public-IP direct-connect bypass");
await assertDirectSocketBlocked("169.254.169.254", 80, "metadata direct-connect bypass");
const refused = await proxyConnect("unlisted.example.test:443");
assert.match(refused, /^HTTP\/1\.1 403 Forbidden/);

const browser = await launchBrowser({ extraArgs: ["--ignore-certificate-errors"] });
try {
  process.stdout.write("worker browser connected to CDP\n");
  const page = await browser.connection.newPage();
  process.stdout.write("worker browser context created\n");
  await page.send("Page.enable", {}, 5000);
  process.stdout.write("worker browser page domain enabled\n");
  const loaded = page.once("Page.loadEventFired", { timeoutMs: 15_000 });
  await page.send("Page.navigate", { url: "https://fixture.example.test/" });
  await loaded;
  const text = await page.evaluate("document.body.innerText");
  assert.match(text, /Controlled worker network fixture/);
} finally {
  await browser.close();
}

process.stdout.write("worker boundary verified: direct DNS/public/private sockets blocked; allowlisted HTTPS reached only through the pinned proxy\n");

async function assertDirectSocketBlocked(host, port, label) {
  const outcome = await new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, family: net.isIP(host) });
    const timeout = setTimeout(() => { socket.destroy(); resolve("timeout"); }, 2500);
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.destroy();
      reject(new Error(`${label} unexpectedly connected`));
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      resolve(error.code ?? "socket-error");
    });
  });
  process.stdout.write(`${label}: blocked (${outcome})\n`);
}

function proxyConnect(authority) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(proxyUrl.port), proxyUrl.hostname);
    let response = "";
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error("proxy refusal check timed out")); }, 3000);
    socket.once("error", (error) => { clearTimeout(timeout); reject(error); });
    socket.on("data", (chunk) => {
      response += chunk.toString("latin1");
      if (response.includes("\r\n\r\n")) { clearTimeout(timeout); socket.destroy(); resolve(response); }
    });
    socket.once("connect", () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
  });
}
