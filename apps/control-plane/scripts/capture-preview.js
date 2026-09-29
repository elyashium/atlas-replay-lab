import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import net from "node:net";
import pg from "pg";
import { launchBrowser } from "../../../src/runner/cdp.js";
import { encodePng } from "../../../src/image/png.js";
import { buildApp } from "../src/server.js";

const output = path.resolve("../../artifacts");
await mkdir(output, { recursive: true });
const host = "127.0.0.1";
const port = await availablePort();
const origin = `http://${host}:${port}`;
const email = `preview-${randomUUID()}@example.test`;
const uploadFixture = path.join(output, "control-plane-synthetic-component.png");
const sourceFixture = path.join(output, "control-plane-synthetic-component.jsx");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = buildApp({
  pool, appOrigin: origin, secureCookies: false, closePool: false,
  groqApiKey: "preview-only-no-egress",
  visualReviewer: async () => ({
    provider: "groq", requestedModel: "synthetic-fixture", returnedModel: "synthetic-fixture",
    imageSha256: "a".repeat(64), referenceSha256: null, criteria: null,
    issues: [{ category: "hierarchy", kind: "subjective", severity: "minor", confidence: "medium", observation: "Illustrative fixture finding; no provider request was made.", recommendation: "This suggestion is test-only and is not a design assessment.", region: null }],
    verdictEffect: "none", source: "synthetic-fixture",
  }),
  codeProposer: async ({ fileName }) => ({
    provider: "groq", requestedModel: "synthetic-fixture", returnedModel: "synthetic-fixture",
    fileName, sourceSha256: "b".repeat(64), summary: "Illustrative diff; no provider request was made.",
    unifiedDiff: `--- a/${fileName}\n+++ b/${fileName}\n@@ -1 +1 @@\n-old visual treatment\n+new visual treatment`,
    status: "proposal", applied: false, testsRun: false, verdictEffect: "none",
  }),
});
const browser = await launchBrowser({ headless: true });
let organizationId;
let userId;
try {
  await writeFile(uploadFixture, encodePng({ width: 16, height: 16, data: Buffer.alloc(16 * 16 * 4, 180) }));
  await writeFile(sourceFixture, "export function PreviewButton(){ return <button>Preview</button>; }\n");
  await app.listen({ port, host });
  const registration = await fetch(`${origin}/v1/auth/register`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ email, password: "preview-only-password-2026", organizationName: "Preview Studio" }),
  });
  if (!registration.ok) throw new Error(`preview account setup failed (${registration.status})`);
  const account = await registration.json();
  organizationId = account.organization.id;
  userId = account.user.id;
  const cookie = registration.headers.get("set-cookie")?.match(/atlas_session=([^;]+)/)?.[1];
  if (!cookie) throw new Error("preview session cookie was not returned");
  const projectResponse = await fetch(`${origin}/v1/projects`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", cookie: `atlas_session=${cookie}`, "x-atlas-organization": organizationId },
    body: JSON.stringify({ name: "Owned Web3D staging" }),
  });
  if (!projectResponse.ok) throw new Error(`preview project setup failed (${projectResponse.status})`);
  const project = (await projectResponse.json()).project;
  const targetId = randomUUID();
  const verificationToken = "atlas-verify=preview-only-proof";
  const targetContract = {
    schemaVersion: 1, id: "preview-staging", name: "Owned Web3D staging", environment: "staging",
    authorization: { authorized: true, note: "Preview fixture only" },
    target: { url: "https://stage.example.test/", allowedOrigins: ["https://stage.example.test"], buildId: "a1b2c3d4" },
    journey: { steps: [{ type: "waitForVisible", selector: "[data-ready]", timeoutMs: 5000 }], success: { selector: "[data-ready]" }, fallback: { selector: "[data-fallback]", requiredOn: [] } },
    profiles: ["high-wifi"], budgets: { journeyTimeoutMs: 10000, stepTimeoutMs: 5000 }, mediaConsent: false,
    policy: { version: "1", criticalProfiles: ["high-wifi"], minimumScore: 50 }, screenshots: { consent: false, redactSelectors: [] },
  };
  await pool.query(
    "INSERT INTO targets(id,organization_id,project_id,base_url,hostname,verification_token,contract,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [targetId, organizationId, project.id, "https://stage.example.test/", "stage.example.test", verificationToken, targetContract, userId],
  );

  const page = await browser.connection.newPage();
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Network.enable");
  await page.send("Network.setCookie", { name: "atlas_session", value: cookie, url: origin, httpOnly: true, sameSite: "Strict" });
  const reports = [];
  for (const viewport of [
    { name: "desktop", width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false },
    { name: "mobile", width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
  ]) {
    await page.send("Emulation.setDeviceMetricsOverride", viewport);
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: viewport.mobile, maxTouchPoints: 5 });
    const loaded = page.once("Page.loadEventFired", { timeoutMs: 10000 });
    await page.send("Page.navigate", { url: origin });
    await loaded;
    await page.evaluate(`localStorage.setItem("atlas.org", ${JSON.stringify(organizationId)})`);
    const reloaded = page.once("Page.loadEventFired", { timeoutMs: 10000 });
    await page.send("Page.reload");
    await reloaded;
    const readyState = await page.evaluate("new Promise((resolve) => { const started=Date.now(); const check=() => { if (document.querySelector('.project-item')) resolve('ready'); else if (Date.now()-started>5000) resolve(JSON.stringify({body:document.body.innerText, org:localStorage.getItem('atlas.org'), workspaceHidden:document.querySelector('#workspace').hidden, authMessage:document.querySelector('#auth-message').textContent})); else setTimeout(check,25); }; check(); })", { awaitPromise: true });
    if (readyState !== "ready") throw new Error(`preview workspace did not load: ${JSON.stringify(readyState)}`);
    await page.evaluate("document.querySelector('.project-item').click()");
    await page.evaluate("new Promise((resolve) => { const check = () => document.querySelector('.target-form') ? resolve(true) : setTimeout(check, 25); check(); })", { awaitPromise: true });
    await page.evaluate("document.querySelector('.target-card').scrollIntoView({block:'start'})");
    await page.evaluate("document.querySelector('.verification-record').open = true");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const verificationScreenshot = await page.screenshot();
    await writeFile(path.join(output, `control-plane-verification-${viewport.name}.png`), verificationScreenshot);
    const verificationLayout = await page.evaluate("({innerWidth, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth})");
    reports.push({ viewport: viewport.name, state: "verification", ...verificationLayout, screenshot: `artifacts/control-plane-verification-${viewport.name}.png` });
    await page.evaluate("document.querySelector('.target-form').scrollIntoView({block:'start'})");
    await new Promise((resolve) => setTimeout(resolve, 250));
    const layout = await page.evaluate("({innerWidth, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth})");
    const screenshot = await page.screenshot();
    await writeFile(path.join(output, `control-plane-wizard-${viewport.name}.png`), screenshot);
    reports.push({ viewport: viewport.name, state: "wizard", ...layout, screenshot: `artifacts/control-plane-wizard-${viewport.name}.png` });
    await page.evaluate("document.querySelector('.visual-review-tool').scrollIntoView({block:'start'})");
    await page.send("DOM.enable");
    const documentNode = await page.send("DOM.getDocument", { depth: -1 });
    const fileInput = await page.send("DOM.querySelector", { nodeId: documentNode.root.nodeId, selector: ".visual-review-form input[name='image']" });
    await page.send("DOM.setFileInputFiles", { nodeId: fileInput.nodeId, files: [uploadFixture] });
    await page.evaluate("document.querySelector('.visual-review-form input[name=consent]').checked = true; document.querySelector('.visual-review-form input[name=consent]').dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('.visual-review-form').requestSubmit()");
    await page.evaluate("new Promise((resolve, reject) => { const started=Date.now(); const check=() => { if (document.querySelector('.visual-review-history .visual-review-result')) resolve(true); else if (Date.now()-started>8000) reject(new Error('synthetic review preview did not finish')); else setTimeout(check,25); }; check(); })", { awaitPromise: true });
    const previewState = await page.evaluate("({reviewCount:document.querySelectorAll('.visual-review-history .visual-review-result').length, fixtureLabel:document.body.innerText.includes('SYNTHETIC FIXTURE'), status:document.querySelector('.visual-review-status')?.innerText, scrollY})");
    reports.push({ viewport: viewport.name, state: "visual-review-result", ...previewState });
    const sourceInput = await page.send("DOM.querySelector", { nodeId: documentNode.root.nodeId, selector: ".code-proposal-form input[type=file]" });
    await page.send("DOM.setFileInputFiles", { nodeId: sourceInput.nodeId, files: [sourceFixture] });
    await page.evaluate("document.querySelector('.code-proposal-form input[type=checkbox]').checked = true; document.querySelector('.code-proposal-form input[type=checkbox]').dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('.code-proposal-form').requestSubmit()");
    await page.evaluate("new Promise((resolve, reject) => { const started=Date.now(); const check=() => { if (document.querySelector('.code-proposal-result')) resolve(true); else if (Date.now()-started>8000) reject(new Error('synthetic code proposal preview did not finish')); else setTimeout(check,25); }; check(); })", { awaitPromise: true });
    reports.push({ viewport: viewport.name, state: "code-proposal-result", proposalCount: await page.evaluate("document.querySelectorAll('.code-proposal-result').length"), unappliedLabel: await page.evaluate("document.body.innerText.includes('did not apply it, run it, or test it')") });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const visualLayout = await page.evaluate("({innerWidth, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth})");
    const clip = await page.evaluate("(() => { const target=document.querySelector('.visual-review-history'); const pageHeight=Math.max(document.documentElement.scrollHeight,document.body.scrollHeight); const height=Math.min(window.innerHeight,pageHeight); const top=target.getBoundingClientRect().top+window.scrollY-80; const y=Math.max(0,Math.min(top,pageHeight-height)); return {x:0,y,width:window.innerWidth,height,scale:1}; })()");
    const visualCapture = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip }, 60000);
    const visualScreenshot = Buffer.from(visualCapture.data, "base64");
    await writeFile(path.join(output, `control-plane-visual-review-${viewport.name}.png`), visualScreenshot);
    reports.push({ viewport: viewport.name, state: "visual-review", ...visualLayout, screenshot: `artifacts/control-plane-visual-review-${viewport.name}.png` });
    await page.evaluate("document.querySelector('.code-proposal-result').scrollIntoView({block:'center'})");
    await new Promise((resolve) => setTimeout(resolve, 150));
    await writeFile(path.join(output, `control-plane-code-proposal-${viewport.name}.png`), await page.screenshot());
    reports.push({ viewport: viewport.name, state: "code-proposal", screenshot: `artifacts/control-plane-code-proposal-${viewport.name}.png` });
  }
  console.log(JSON.stringify(reports, null, 2));
  if (reports.some((item) => item.scrollWidth > item.clientWidth)) process.exitCode = 1;
} finally {
  await browser.close();
  await app.close();
  await rm(uploadFixture, { force: true });
  await rm(sourceFixture, { force: true });
  if (organizationId) await pool.query("DELETE FROM organizations WHERE id=$1", [organizationId]);
  if (userId) await pool.query("DELETE FROM users WHERE id=$1", [userId]);
  await pool.end();
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, host, resolve); });
  const { port: selectedPort } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return selectedPort;
}
