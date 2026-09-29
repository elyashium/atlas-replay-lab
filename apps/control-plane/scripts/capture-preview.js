import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
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
const referenceFixture = path.join(output, "control-plane-synthetic-reference.png");
const sourceFixture = path.join(output, "control-plane-synthetic-component.jsx");
const previewArtifactRoot = path.join(output, "control-plane-preview-run-artifacts");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const idempotencyPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = buildApp({
  pool, idempotencyPool, appOrigin: origin, secureCookies: false, closePool: false, artifactRoot: previewArtifactRoot,
  dns: { lookup: async () => [{ address: "93.184.216.34", family: 4 }], resolveTxt: async () => [] },
  groqApiKey: "preview-only-no-egress",
  visualReviewer: async () => ({
    provider: "groq", requestedModel: "synthetic-fixture", returnedModel: "synthetic-fixture",
    imageSha256: "a".repeat(64), referenceSha256: null, criteria: null,
    issues: [{ category: "hierarchy", kind: "subjective", severity: "minor", confidence: "medium", observation: "Illustrative fixture finding; no provider request was made.", recommendation: "This suggestion is test-only and is not a design assessment.", region: { x: 250, y: 280, width: 300, height: 200 } }],
    verdictEffect: "none", source: "synthetic-fixture",
  }),
  codeProposer: async ({ fileName }) => ({
    provider: "groq", requestedModel: "synthetic-fixture", returnedModel: "synthetic-fixture",
    fileName, sourceSha256: "b".repeat(64), summary: "Illustrative diff; no provider request was made.",
    proposedSourceSha256: "c".repeat(64), patchAppliesToSource: true,
    unifiedDiff: `--- a/${fileName}\n+++ b/${fileName}\n@@ -1 +1 @@\n-old visual treatment\n+new visual treatment`,
    status: "proposal", applied: false, testsRun: false, verdictEffect: "none",
  }),
});
const browser = await launchBrowser({ headless: true });
let organizationId;
let userId;
try {
  await writeFile(uploadFixture, encodePng({ width: 16, height: 16, data: Buffer.alloc(16 * 16 * 4, 180) }));
  const referencePixels = Buffer.alloc(16 * 16 * 4);
  for (let offset = 0; offset < referencePixels.length; offset += 4) {
    referencePixels[offset] = 80; referencePixels[offset + 1] = 100; referencePixels[offset + 2] = 140; referencePixels[offset + 3] = 255;
  }
  await writeFile(referenceFixture, encodePng({ width: 16, height: 16, data: referencePixels }));
  await writeFile(sourceFixture, "export function PreviewButton(){ return <button>Preview</button>; }\n");
  await mkdir(previewArtifactRoot, { recursive: true });
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
  const sampleRunId = randomUUID();
  await pool.query(
    "INSERT INTO runs(id,organization_id,project_id,target_id,status,verdict,contract_version,contract_snapshot,binding_snapshot,requested_by,idempotency_key,retention_expires_at,result_snapshot) VALUES($1,$2,$3,$4,'completed','INCONCLUSIVE','1',$5,$6,$7,$8,now()+interval '30 days',$9)",
    [sampleRunId, organizationId, project.id, targetId, targetContract, { bindingVersion: 1, bindingHash: "1".repeat(16) }, userId, `preview-${sampleRunId}`, { evidenceScope: "Illustrative UI fixture; no browser job was run.", targetDecision: { evidence: [{ profileId: "high-wifi", journey: null, score: null, error: "No run executed in this preview" }] } }],
  );
  const screenshotBytes = await readFile(uploadFixture);
  const screenshotId = randomUUID();
  await mkdir(path.join(previewArtifactRoot, sampleRunId), { recursive: true });
  await writeFile(path.join(previewArtifactRoot, sampleRunId, "high-wifi-preview.png"), screenshotBytes);
  await pool.query(
    "INSERT INTO artifacts(id,organization_id,run_id,object_key,media_type,byte_length,sha256) VALUES($1,$2,$3,$4,'image/png',$5,$6)",
    [screenshotId, organizationId, sampleRunId, `${sampleRunId}/high-wifi-preview.png`, screenshotBytes.length, createHash("sha256").update(screenshotBytes).digest("hex")],
  );

  const page = await browser.connection.newPage();
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Network.enable");
  await page.send("Network.setCookie", { name: "atlas_session", value: cookie, url: origin, httpOnly: true, sameSite: "Strict" });
  const reports = [];
  const shareUrls = [];
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
    await page.evaluate("document.querySelector('.run-card').scrollIntoView({block:'center'})");
    await new Promise((resolve) => setTimeout(resolve, 180));
    const runLayout = await page.evaluate("({innerWidth, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth, fixtureLabel: document.querySelector('.run-card')?.innerText.includes('Illustrative UI fixture')})");
    await writeFile(path.join(output, `control-plane-run-${viewport.name}.png`), await page.screenshot());
    reports.push({ viewport: viewport.name, state: "illustrative-run", ...runLayout, screenshot: `artifacts/control-plane-run-${viewport.name}.png` });
    await page.evaluate("(() => { const form=document.querySelector('.run-card .share-create-form'); if(!form) throw new Error('share link form was not rendered'); form.querySelector('[name=includeSummary]').checked=true; const artifact=form.querySelector('[name=artifact]'); if(!artifact) throw new Error('no fixture artifact is available to share'); artifact.checked=true; form.requestSubmit(); })()");
    await page.evaluate("new Promise((resolve, reject) => { const started=Date.now(); const check=() => { const link=document.querySelector('.run-card .share-row input[readonly]'); if(link?.value.includes('#share=')) resolve(true); else if(Date.now()-started>8000) reject(new Error('share link creation did not complete')); else setTimeout(check,25); }; check(); })", { awaitPromise: true });
    const createdShareUrl = await page.evaluate("document.querySelector('.run-card .share-row input[readonly]').value");
    shareUrls.push(createdShareUrl);
    const shareCreationState = await page.evaluate("({activeShare:document.querySelector('.run-card .share-row')?.innerText.includes('ACTIVE'), shareTokenInUrl:Boolean(document.querySelector('.run-card .share-row input[readonly]')?.value.includes('#share=')), artifactSelected:document.querySelector('.run-card .share-row')?.innerText.includes('high-wifi-preview.png')})");
    await page.evaluate("document.querySelector('.run-card .share-manager').scrollIntoView({block:'center'})");
    await page.evaluate("(() => { const input=document.querySelector('.run-card .share-row input[readonly]'); if(input) input.value=new URL(input.value).origin+'/#share=[redacted synthetic token]'; })()");
    await writeFile(path.join(output, `control-plane-share-create-${viewport.name}.png`), await page.screenshot());
    reports.push({ viewport: viewport.name, state: "share-link-created", ...shareCreationState, screenshot: `artifacts/control-plane-share-create-${viewport.name}.png` });
    await page.evaluate("document.querySelector('.target-card').scrollIntoView({block:'start'})");
    await page.evaluate("document.querySelector('.verification-record').open = true");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const verificationScreenshot = await page.screenshot();
    await writeFile(path.join(output, `control-plane-verification-${viewport.name}.png`), verificationScreenshot);
    const verificationLayout = await page.evaluate("({innerWidth, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth})");
    reports.push({ viewport: viewport.name, state: "verification", ...verificationLayout, screenshot: `artifacts/control-plane-verification-${viewport.name}.png` });
    await page.evaluate("document.querySelector('.target-form').scrollIntoView({block:'start'})");
    await page.evaluate("(() => { const form=document.querySelector('.target-form'); const set=(name,value)=>{form.elements[name].value=value;form.elements[name].dispatchEvent(new Event('input',{bubbles:true}));}; set('buildId','preview-build-2026'); form.elements.authorizationConsent.checked=true; form.elements.authorizationConsent.dispatchEvent(new Event('change',{bubbles:true})); form.querySelector('button[type=button]').click(); })()");
    await page.evaluate("new Promise((resolve,reject)=>{const started=Date.now();const check=()=>{const status=document.querySelector('.target-validation-status');if(status?.dataset.state==='success')resolve(true);else if(status?.dataset.state==='error')reject(new Error('target static validation failed: '+status.innerText));else if(Date.now()-started>8000)reject(new Error('target static validation did not finish'));else setTimeout(check,25)};check()})", { awaitPromise: true });
    const targetPreflightState = await page.evaluate("({registerEnabled:!document.querySelector('.target-form button[type=submit]').disabled, ownershipPending:document.querySelector('.target-validation-status').innerText.includes('Ownership verification is still pending'), selectorNotTested:document.querySelector('.target-validation-status').innerText.includes('selectors have not been tested')})");
    reports.push({ viewport: viewport.name, state: "target-static-preflight", ...targetPreflightState });
    await page.evaluate("document.querySelector('.target-validation-status').scrollIntoView({block:'center'})");
    await writeFile(path.join(output, `control-plane-target-preflight-${viewport.name}.png`), await page.screenshot());
    await new Promise((resolve) => setTimeout(resolve, 250));
    const layout = await page.evaluate("({innerWidth, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth})");
    const screenshot = await page.screenshot();
    await writeFile(path.join(output, `control-plane-wizard-${viewport.name}.png`), screenshot);
    reports.push({ viewport: viewport.name, state: "wizard", ...layout, screenshot: `artifacts/control-plane-wizard-${viewport.name}.png` });
    await page.evaluate("document.querySelector('.visual-review-tool').scrollIntoView({block:'start'})");
    await page.send("DOM.enable");
    const documentNode = await page.send("DOM.getDocument", { depth: -1 });
    await page.evaluate("(() => { const select=document.querySelector('.visual-review-form select[name=capturedScreenshot]'); if(select.options.length<2) throw new Error('captured screenshot option was not rendered'); select.selectedIndex=1; select.dispatchEvent(new Event('change',{bubbles:true})); })()");
    await page.evaluate("new Promise((resolve, reject) => { const started=Date.now(); const check=() => { if (document.querySelector('.visual-review-form .visual-previews img') && document.querySelector('.visual-review-status').innerText.includes('Preview the run screenshot')) resolve(true); else if (Date.now()-started>8000) reject(new Error('captured screenshot preview did not load through the artifact API')); else setTimeout(check,25); }; check(); })", { awaitPromise: true });
    const referenceInput = await page.send("DOM.querySelector", { nodeId: documentNode.root.nodeId, selector: ".visual-review-form input[name=reference]" });
    await page.send("DOM.setFileInputFiles", { nodeId: referenceInput.nodeId, files: [referenceFixture] });
    await page.evaluate("(() => { const criteria=document.querySelector('.visual-review-form textarea[name=criteria]'); criteria.value='Preserve the approved component composition at '+innerWidth+'px.'; criteria.dispatchEvent(new Event('input',{bubbles:true})); })()");
    await page.evaluate("document.querySelector('.visual-review-form button[type=button]').click()");
    await page.evaluate("new Promise((resolve, reject) => { const started=Date.now(); const check=() => { if (document.querySelector('.local-pixel-comparison .pixel-comparison') && document.querySelector('.visual-review-status').innerText.includes('No images or comparison data were sent')) resolve(true); else if (Date.now()-started>10000) reject(new Error('local pixel comparison did not complete in the browser worker')); else setTimeout(check,25); }; check(); })", { awaitPromise: true });
    await page.evaluate("document.querySelector('.visual-review-tool').scrollIntoView({block:'start'})");
    await new Promise((resolve) => setTimeout(resolve, 180));
    const capturePreviewState = await page.evaluate("({innerWidth, clientWidth:document.documentElement.clientWidth, scrollWidth:document.documentElement.scrollWidth, imageReady:document.querySelector('.visual-review-form .visual-previews img')?.complete, screenshotCaption:document.querySelector('.visual-review-form .visual-previews figcaption')?.innerText, consentChecked:document.querySelector('.visual-review-form input[name=consent]').checked, localComparisonVisible:Boolean(document.querySelector('.local-pixel-comparison .pixel-comparison')), statusColor:getComputedStyle(document.querySelector('.visual-review-status')).color})");
    await writeFile(path.join(output, `control-plane-capture-preview-${viewport.name}.png`), await page.screenshot());
    reports.push({ viewport: viewport.name, state: "local-only-captured-screenshot-comparison", ...capturePreviewState, screenshot: `artifacts/control-plane-capture-preview-${viewport.name}.png` });
    await page.evaluate("document.querySelector('.visual-review-form input[name=consent]').checked = true; document.querySelector('.visual-review-form input[name=consent]').dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('.visual-review-form').requestSubmit()");
    await page.evaluate("new Promise((resolve, reject) => { const started=Date.now(); const check=() => { const image=document.querySelector('.visual-review-history .visual-finding-preview img'); if(image?.complete && image.naturalWidth) resolve(true); else if(Date.now()-started>8000) reject(new Error('synthetic finding overlay did not finish: '+JSON.stringify({history:document.querySelectorAll('.visual-review-history .visual-review-result').length,overlay:Boolean(image)}))); else setTimeout(check,25); }; check(); })", { awaitPromise: true });
    const previewState = await page.evaluate("({reviewCount:document.querySelectorAll('.visual-review-history .visual-review-result').length, fixtureLabel:document.body.innerText.includes('SYNTHETIC FIXTURE'), sourceProvenanceVisible:document.querySelector('.visual-review-history')?.innerText.includes('Source: run'), pixelComparisonVisible:document.body.innerText.includes('DETERMINISTIC REFERENCE COMPARISON'), findingOverlayCount:document.querySelectorAll('.visual-finding-region').length, findingOverlayLabel:document.querySelector('.visual-finding-preview figcaption')?.innerText, status:document.querySelector('.visual-review-status')?.innerText, scrollY})");
    reports.push({ viewport: viewport.name, state: "visual-review-result", ...previewState });
    await page.evaluate("(() => { const form=document.querySelector('.finding-disposition'); if(!form) throw new Error('team finding disposition control was not rendered'); const select=form.querySelector('select'); select.value='confirmed'; form.requestSubmit(); })()");
    await page.evaluate("new Promise((resolve, reject) => { const started=Date.now(); const check=() => { if(document.querySelector('.visual-review-history .finding-disposition select')?.value==='confirmed') resolve(true); else if(Date.now()-started>8000) reject(new Error('saved team finding disposition did not reload')); else setTimeout(check,25); }; check(); })", { awaitPromise: true });
    const dispositionState = await page.evaluate("({persisted:document.querySelector('.visual-review-history .finding-disposition select')?.value==='confirmed', noVerdictClaim:document.querySelector('.visual-review-history .finding-disposition')?.innerText.includes('does not change the release verdict')})");
    reports.push({ viewport: viewport.name, state: "finding-disposition", ...dispositionState });
    const sourceInput = await page.send("DOM.querySelector", { nodeId: documentNode.root.nodeId, selector: ".code-proposal-form input[type=file]" });
    await page.send("DOM.setFileInputFiles", { nodeId: sourceInput.nodeId, files: [sourceFixture] });
    await page.evaluate("document.querySelector('.code-proposal-form input[type=checkbox]').checked = true; document.querySelector('.code-proposal-form input[type=checkbox]').dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('.code-proposal-form').requestSubmit()");
    await page.evaluate("new Promise((resolve, reject) => { const started=Date.now(); const check=() => { if (document.querySelector('.code-proposal-result')) resolve(true); else if (Date.now()-started>8000) reject(new Error('synthetic code proposal preview did not finish')); else setTimeout(check,25); }; check(); })", { awaitPromise: true });
    reports.push({ viewport: viewport.name, state: "code-proposal-result", proposalCount: await page.evaluate("document.querySelectorAll('.code-proposal-result').length"), unappliedLabel: await page.evaluate("document.body.innerText.includes('did not write, run, or test the candidate')"), candidateHashVisible: await page.evaluate("document.body.innerText.includes('c'.repeat(64))") });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const visualLayout = await page.evaluate("({innerWidth, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth})");
    const clip = await page.evaluate("(() => { const target=document.querySelector('.visual-review-history'); const pageHeight=Math.max(document.documentElement.scrollHeight,document.body.scrollHeight); const height=Math.min(window.innerHeight,pageHeight); const top=target.getBoundingClientRect().top+window.scrollY-80; const y=Math.max(0,Math.min(top,pageHeight-height)); return {x:0,y,width:window.innerWidth,height,scale:1}; })()");
    const visualCapture = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip }, 60000);
    const visualScreenshot = Buffer.from(visualCapture.data, "base64");
    await writeFile(path.join(output, `control-plane-visual-review-${viewport.name}.png`), visualScreenshot);
    reports.push({ viewport: viewport.name, state: "visual-review", ...visualLayout, screenshot: `artifacts/control-plane-visual-review-${viewport.name}.png` });
    const localImageCleared = await page.evaluate("(() => { const button=document.querySelector('.visual-finding-preview button[aria-label=\"Clear local screenshot from this page\"]'); if(!button) return false; button.click(); return !document.querySelector('.visual-finding-preview img'); })()");
    reports.push({ viewport: viewport.name, state: "clear-local-screenshot", passed: localImageCleared });
    await page.evaluate("document.querySelector('.code-proposal-result').scrollIntoView({block:'center'})");
    await new Promise((resolve) => setTimeout(resolve, 150));
    await writeFile(path.join(output, `control-plane-code-proposal-${viewport.name}.png`), await page.screenshot());
    reports.push({ viewport: viewport.name, state: "code-proposal", screenshot: `artifacts/control-plane-code-proposal-${viewport.name}.png` });
  }
  const sharedPage = await browser.connection.newPage();
  await sharedPage.send("Page.enable"); await sharedPage.send("Runtime.enable");
  for (const viewport of [
    { name: "desktop", width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false },
    { name: "mobile", width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
  ]) {
    await sharedPage.send("Emulation.setDeviceMetricsOverride", viewport);
    await sharedPage.send("Network.enable");
    const sharedPreviewUrl = new URL(shareUrls[0]); sharedPreviewUrl.searchParams.set("previewViewport", viewport.name);
    await sharedPage.send("Page.navigate", { url: sharedPreviewUrl.href });
    await sharedPage.evaluate("new Promise((resolve, reject) => { const started=Date.now(); const check=() => { const heading=document.querySelector('#shared-report h2'); if(!document.querySelector('#shared-report').hidden && heading?.innerText.startsWith('Run ')) resolve(true); else if(Date.now()-started>10000) reject(new Error('shared report did not open: '+document.body.innerText.slice(-500))); else setTimeout(check,25); }; check(); })", { awaitPromise: true });
    await sharedPage.evaluate("[...document.querySelectorAll('#shared-report button')].find((button)=>button.innerText==='Preview screenshot')?.click()");
    await sharedPage.evaluate("new Promise((resolve, reject) => { const started=Date.now(); const check=() => { const image=document.querySelector('#shared-report .shared-artifact-preview img'); if(image?.complete && image.naturalWidth) resolve(true); else if(Date.now()-started>8000) reject(new Error('shared screenshot preview did not load')); else setTimeout(check,25); }; check(); })", { awaitPromise: true });
    const shareView = await sharedPage.evaluate("({heading:document.querySelector('#shared-report h2').innerText, artifactCount:document.querySelectorAll('#shared-report .artifact-list li').length, screenshotPreviewCount:document.querySelectorAll('#shared-report .shared-artifact-preview img').length, tokenRemoved:location.hash==='', scrollWidth:document.documentElement.scrollWidth, clientWidth:document.documentElement.clientWidth})");
    await writeFile(path.join(output, `control-plane-shared-report-${viewport.name}.png`), await sharedPage.screenshot());
    reports.push({ viewport: viewport.name, state: "anonymous-shared-report", ...shareView, screenshot: `artifacts/control-plane-shared-report-${viewport.name}.png` });
  }
  console.log(JSON.stringify(reports, null, 2));
  if (reports.some((item) => item.scrollWidth > item.clientWidth || (item.state === "target-static-preflight" && (!item.registerEnabled || !item.ownershipPending || !item.selectorNotTested)) || (item.state === "visual-review-result" && (item.findingOverlayCount !== 1 || !item.sourceProvenanceVisible)) || (item.state === "finding-disposition" && (!item.persisted || !item.noVerdictClaim)) || (item.state === "clear-local-screenshot" && !item.passed) || (item.state === "code-proposal-result" && (!item.unappliedLabel || !item.candidateHashVisible)) || (item.state === "share-link-created" && (!item.activeShare || !item.shareTokenInUrl || !item.artifactSelected)) || (item.state === "anonymous-shared-report" && (!item.tokenRemoved || item.artifactCount !== 1 || item.screenshotPreviewCount !== 1)))) process.exitCode = 1;
} finally {
  await browser.close();
  await app.close();
  await rm(uploadFixture, { force: true });
  await rm(referenceFixture, { force: true });
  await rm(sourceFixture, { force: true });
  await rm(previewArtifactRoot, { recursive: true, force: true });
  if (organizationId) await pool.query("DELETE FROM organizations WHERE id=$1", [organizationId]);
  if (userId) await pool.query("DELETE FROM users WHERE id=$1", [userId]);
  await idempotencyPool.end();
  await pool.end();
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, host, resolve); });
  const { port: selectedPort } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return selectedPort;
}
