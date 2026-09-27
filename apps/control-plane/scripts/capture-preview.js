import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchBrowser } from "../../../src/runner/cdp.js";

const output = path.resolve("../../artifacts");
await mkdir(output, { recursive: true });
const browser = await launchBrowser({ headless: true });
try {
  const page = await browser.connection.newPage();
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  const reports = [];
  for (const viewport of [
    { name: "desktop", width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false },
    { name: "mobile", width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
  ]) {
    await page.send("Emulation.setDeviceMetricsOverride", viewport);
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: viewport.mobile, maxTouchPoints: 5 });
    const loaded = page.once("Page.loadEventFired", { timeoutMs: 10000 });
    await page.send("Page.navigate", { url: "http://127.0.0.1:3000" });
    await loaded;
    await new Promise((resolve) => setTimeout(resolve, 400));
    const layout = await page.evaluate("({innerWidth, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth})");
    const screenshot = await page.screenshot();
    await writeFile(path.join(output, `control-plane-${viewport.name}.png`), screenshot);
    reports.push({ viewport: viewport.name, ...layout, screenshot: `artifacts/control-plane-${viewport.name}.png` });
  }
  console.log(JSON.stringify(reports, null, 2));
  if (reports.some((item) => item.scrollWidth > item.clientWidth)) process.exitCode = 1;
} finally {
  await browser.close();
}
