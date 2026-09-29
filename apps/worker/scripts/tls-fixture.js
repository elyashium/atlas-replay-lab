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

const server = https.createServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, (_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end("<!doctype html><title>Atlas isolated fixture</title><main id=ready>Controlled worker network fixture</main>");
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
