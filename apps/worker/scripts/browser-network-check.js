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
  await page.send("Network.enable", {}, 5000);
  const tracked = new Map();
  page.on("Network.requestWillBeSent", ({ requestId, request }) => {
    let parsed;
    try { parsed = new URL(request.url); } catch { return; }
    if (["169.254.169.254", "93.184.216.3", "blocked.example.test"].includes(parsed.hostname)) {
      tracked.set(requestId, { host: parsed.hostname, path: parsed.pathname, failed: false });
    }
  });
  page.on("Network.loadingFailed", ({ requestId }) => {
    const request = tracked.get(requestId);
    if (request) request.failed = true;
  });
  process.stdout.write("worker browser page domain enabled\n");
  const loaded = page.once("Page.loadEventFired", { timeoutMs: 15_000 });
  await page.send("Page.navigate", { url: "https://fixture.example.test/" });
  await loaded;
  const text = await page.evaluate("document.body.innerText");
  assert.match(text, /Controlled worker network fixture/);
  const probeResults = await page.evaluate(`(async () => {
    const attempt = async (url) => { try { await fetch(url, { mode: "no-cors", cache: "no-store" }); return "unexpectedly-fulfilled"; } catch { return "blocked"; } };
    const image = new Image();
    const imageResult = new Promise((resolve) => { image.onload = () => resolve("unexpectedly-loaded"); image.onerror = () => resolve("blocked"); setTimeout(() => resolve("timed-out"), 8000); });
    image.src = "https://169.254.169.254/image-probe";
    document.body.append(image);
    const frame = document.createElement("iframe");
    const frameResult = new Promise((resolve) => { frame.onload = () => resolve("navigation-finished"); setTimeout(() => resolve("timed-out"), 8000); });
    frame.src = "/redirect-frame";
    document.body.append(frame);
    const webSocketResult = new Promise((resolve) => {
      const socket = new WebSocket("wss://169.254.169.254/websocket-probe");
      const timer = setTimeout(() => resolve("timed-out"), 8000);
      socket.onopen = () => { clearTimeout(timer); socket.close(); resolve("unexpectedly-opened"); };
      socket.onerror = () => { clearTimeout(timer); resolve("blocked"); };
    });
    const serviceWorkerResult = navigator.serviceWorker.register("/sw.js").then(() => "registered").catch(() => "blocked");
    const webrtcResult = (async () => {
      const peer = new RTCPeerConnection({ iceServers: [{ urls: "stun:${proxyUrl.hostname}:3478" }] });
      peer.createDataChannel("atlas-boundary-probe");
      const candidates = [];
      peer.onicecandidate = (event) => { if (event.candidate) candidates.push(event.candidate.type); };
      await peer.setLocalDescription(await peer.createOffer());
      await new Promise((resolve) => {
        if (peer.iceGatheringState === "complete") return resolve();
        peer.onicegatheringstatechange = () => { if (peer.iceGatheringState === "complete") resolve(); };
        setTimeout(resolve, 7000);
      });
      peer.close();
      return { serverReflexiveCandidates: candidates.filter((type) => type === "srflx").length };
    })();
    const outcomes = await Promise.all([
      attempt("https://169.254.169.254/fetch-probe"),
      attempt("https://93.184.216.3/unlisted-ip-probe"),
      attempt("https://blocked.example.test/unlisted-host-probe"),
      attempt("/redirect"), imageResult, frameResult, webSocketResult, serviceWorkerResult,
    ]);
    outcomes.push(await webrtcResult);
    return outcomes;
  })()`, { awaitPromise: true, timeoutMs: 15_000 });
  assert.deepEqual(probeResults.slice(0, 8), ["blocked", "blocked", "blocked", "blocked", "blocked", "navigation-finished", "blocked", "registered"]);
  assert.deepEqual(probeResults[8], { serverReflexiveCandidates: 0 }, "browser must not establish a server-reflexive WebRTC route");
  await new Promise((resolve) => setTimeout(resolve, 400));
  const failedForbiddenRequests = [...tracked.values()].filter((request) => request.failed).length;
  assert.ok(failedForbiddenRequests >= 5, `expected failed browser requests to forbidden destinations, observed ${failedForbiddenRequests}`);
  const deniedRequests = [...tracked.values()].filter((request) => request.failed);
  const blockedMetadataRedirect = deniedRequests.some((request) => request.host === "169.254.169.254" && request.path === "/metadata-probe");
  assert.ok(blockedMetadataRedirect, "browser must show the cross-origin redirect to metadata failed at the connection boundary");
  process.stdout.write(`browser adversarial probes blocked: ${JSON.stringify({ fetches: probeResults.slice(0, 4), image: probeResults[4], redirectFrame: probeResults[5], webSocket: probeResults[6], serviceWorker: probeResults[7], webRtcServerReflexiveCandidates: probeResults[8].serverReflexiveCandidates, failedForbiddenRequests, blockedMetadataRedirect })}\n`);
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
