import { readFile } from "node:fs/promises";
const t = JSON.parse(await readFile("artifacts/matrix-glb-smoke/runs/high-wifi/trace.json", "utf8"));
console.log("states:", t.states.join(" > "));
console.log("metrics:", JSON.stringify(t.metrics, null, 1).slice(0, 1200));
const v = JSON.parse(await readFile("artifacts/matrix-glb-smoke/runs/high-wifi/verdict.json", "utf8"));
console.log("verdict:", v.outcome?.value, v.rootCause?.value, v.releaseBlocking?.score);
console.log("rationale:", (v.rationale ?? []).join(" | ").slice(0, 2000));
