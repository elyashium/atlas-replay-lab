import { loadLocalEnv } from "../src/load-env.js";

loadLocalEnv();
const { startServer } = await import("../src/server.js");
await startServer();