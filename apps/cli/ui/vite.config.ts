import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [solid()],
  build: {
    target: "es2022",
    outDir: fileURLToPath(new URL("../dist/ui", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: 0,
  },
});
