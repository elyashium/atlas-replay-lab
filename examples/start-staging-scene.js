import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const page = await readFile(path.join(here, "staging-scene", "index.html"));
const server = createServer((req, res) => {
  if (req.url !== "/" && req.url !== "/index.html") {
    res.writeHead(404).end("Not found");
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page);
});
server.listen(4173, "127.0.0.1", () => console.log("Owned staging fixture: http://127.0.0.1:4173/ (Ctrl+C to stop)"));
