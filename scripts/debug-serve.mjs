import path from "node:path";
import { startServer } from "../src/runner/server.js";
import { orbitalManifest } from "../src/manifest/atlas-orbital.manifest.js";
import { RuleBasedDecisionEngine } from "../src/decision/rule-based.js";
import { fromRoot } from "../src/util/fsx.js";

const outDir = fromRoot("artifacts", "matrix-glb-smoke");
const server = await startServer({
  manifest: orbitalManifest,
  engine: new RuleBasedDecisionEngine(),
  emulated: true,
  traceDir: null,
  aliases: { "/uploads/": path.join(outDir, "uploads") },
});
for (const p of ["/uploads/f664d6d067cfb929.atlas.json", "/viewer/", "/viewer/viewer.js", "/viewer/ladder.js", "/capability-probe.js", "/api/manifest"]) {
  const r = await fetch(`${server.origin}${p}`);
  console.log(r.status, p, r.headers.get("content-type"));
}
await server.close();
