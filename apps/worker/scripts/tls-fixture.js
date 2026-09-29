import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import https from "node:https";

const directory = await mkdtemp(path.join(tmpdir(), "atlas-worker-fixture-"));
const keyPath = path.join(directory, "key.pem");
const certPath = path.join(directory, "cert.pem");
const generated = spawn("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
  "-subj", "/CN=fixture.example.test", "-keyout", keyPath, "-out", certPath,
], { stdio: "ignore" });
const generatedCode = await new Promise((resolve, reject) => {
  generated.once("error", reject);
  generated.once("exit", resolve);
});
if (generatedCode !== 0) throw new Error("could not create ephemeral TLS fixture certificate");

const server = https.createServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, (request, response) => {
  if (request.url === "/redirect" || request.url === "/redirect-frame") {
    response.writeHead(302, { location: "https://169.254.169.254/metadata-probe", "cache-control": "no-store" });
    response.end();
    return;
  }
  if (request.url === "/sw.js") {
    response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store", "service-worker-allowed": "/" });
    response.end("self.addEventListener('install', event => event.waitUntil(fetch('https://169.254.169.254/service-worker-probe').catch(() => {})));\n");
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end("<!doctype html><title>Atlas isolated fixture</title><style>body{margin:0}main{width:240px;height:120px;background:#345;color:#fff;padding:12px;box-sizing:border-box}</style><main id=ready>Controlled worker network fixture <span data-private>fixture private label</span></main>");
});
server.listen(443, "0.0.0.0", () => process.stdout.write("TLS fixture ready on 443\n"));

async function shutdown() {
  server.close(async () => {
    await rm(directory, { recursive: true, force: true });
    process.exit(0);
  });
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
