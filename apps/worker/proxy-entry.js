import { startEgressProxy } from "../control-plane/src/egress-proxy.js";

const encodedOrigins = process.env.ATLAS_ALLOWED_ORIGINS;
let allowedOrigins;
try { allowedOrigins = JSON.parse(encodedOrigins ?? "null"); }
catch { throw new Error("ATLAS_ALLOWED_ORIGINS must be a JSON array"); }
if (!Array.isArray(allowedOrigins) || !allowedOrigins.length || allowedOrigins.some((origin) => typeof origin !== "string")) {
  throw new Error("ATLAS_ALLOWED_ORIGINS must be a non-empty string array");
}

const proxy = await startEgressProxy({
  allowedOrigins, host: "0.0.0.0", port: 3128, maxTunnels: 64,
  ...(process.env.ATLAS_PROXY_TEST_DIAGNOSTICS === "1"
    ? { onDecision: (allowed) => process.stdout.write(allowed ? "ATLAS_PROXY_CONNECT_ALLOWED\n" : "ATLAS_PROXY_CONNECT_REFUSED\n") }
    : {}),
});
let stopping;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopping ??= proxy.close().finally(() => process.exit(0));
  });
}

// Do not print target origins: contract URLs can reveal private staging names.
process.stdout.write("Atlas per-job egress proxy ready on 3128\n");
