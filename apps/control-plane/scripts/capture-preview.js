import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { launchBrowser } from "../../../src/runner/cdp.js";

const output = path.resolve("../../artifacts");
await mkdir(output, { recursive: true });
const origin = process.env.ATLAS_APP_ORIGIN ?? "http://127.0.0.1:3000";
const email = `preview-${randomUUID()}@example.test`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const browser = await launchBrowser({ headless: true });
let organizationId;
let userId;
try {
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
    await page.evaluate("document.querySelector('.target-form').scrollIntoView({block:'start'})");
    await new Promise((resolve) => setTimeout(resolve, 250));
    const layout = await page.evaluate("({innerWidth, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth})");
    const screenshot = await page.screenshot();
    await writeFile(path.join(output, `control-plane-wizard-${viewport.name}.png`), screenshot);
    reports.push({ viewport: viewport.name, ...layout, screenshot: `artifacts/control-plane-wizard-${viewport.name}.png` });
  }
  console.log(JSON.stringify(reports, null, 2));
  if (reports.some((item) => item.scrollWidth > item.clientWidth)) process.exitCode = 1;
} finally {
  await browser.close();
  if (organizationId) await pool.query("DELETE FROM organizations WHERE id=$1", [organizationId]);
  if (userId) await pool.query("DELETE FROM users WHERE id=$1", [userId]);
  await pool.end();
}
