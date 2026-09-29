import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(here, "public"),
  publicDir: false,
  build: {
    outDir: path.join(here, "dist/public"),
    emptyOutDir: true,
    assetsDir: "assets",
    target: "es2022",
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
