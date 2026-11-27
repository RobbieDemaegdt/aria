import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

const here = import.meta.dirname;

// The workspace packages ship TypeScript sources, so they're bundled into main and preload. Everything else in
// package.json stays external; @github/copilot-sdk must, since it starts its bundled runtime from its package folder.
const bundleWorkspace = { exclude: ["@aria/core", "@aria/protocol"] };

export default defineConfig({
  main: {
    build: {
      externalizeDeps: bundleWorkspace,
      rollupOptions: { input: { index: resolve(here, "src/main/index.ts") } },
    },
  },
  preload: {
    build: {
      externalizeDeps: bundleWorkspace,
      rollupOptions: {
        input: { index: resolve(here, "src/preload/index.ts") },
        // Sandboxed preload scripts must be CommonJS.
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve(here, "src/renderer"),
    build: { rollupOptions: { input: { index: resolve(here, "src/renderer/index.html") } } },
    plugins: [react(), tailwindcss()],
  },
});
