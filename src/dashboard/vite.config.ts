import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { popmelt } from "@popmelt.com/core/vite";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(import.meta.dirname, "web"),
  base: process.env.PATRONUM_DASH_BASE ?? "/",
  // popmelt() only acts on the dev server; projectRoot keeps .popmelt/ at the repo root, not the Vite root.
  plugins: [react(), tailwindcss(), popmelt({ projectRoot: resolve(import.meta.dirname, "../..") })],
  resolve: { alias: { "@": resolve(import.meta.dirname, "web") } },
  build: { outDir: "../dist", emptyOutDir: true, sourcemap: false },
  // web/api/*.ts shares the /api prefix with the backend; bypass keeps those source modules on Vite.
  server: { host: "127.0.0.1", port: 7800, proxy: { "/api": { target: "http://127.0.0.1:7799", bypass: (req) => (/\.tsx?(\?|$)/.test(req.url ?? "") ? req.url : undefined) } } },
});
