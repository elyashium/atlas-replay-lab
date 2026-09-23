import { readFile } from "node:fs/promises";
const t = JSON.parse(await readFile("artifacts/matrix-glb-xr/runs/xr-granted/trace.json", "utf8"));
console.log("states:", t.states.join(" > "));
console.log("firstFrameNonBlank:", t.metrics.firstFrameNonBlank, "end:", t.metrics.reachedEndState);
const v = JSON.parse(await readFile("artifacts/matrix-glb-xr/runs/xr-granted/verdict.json", "utf8"));
console.log("verdict:", v.outcome?.value, v.rootCause?.value, v.releaseBlocking?.score);
console.log("rationale:", (v.rationale ?? []).join(" | ").slice(0, 1200));
console.log("xr:", JSON.stringify(t.xrSessionEvents));
