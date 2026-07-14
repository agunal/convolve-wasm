import { defineConfig, type Plugin } from "vite";

const WORKER_URL_PLACEHOLDER = '"__CONVOLVE_WORKER_URL__"';
const WASM_FALLBACK =
  "module_or_path = new URL('convolve_core_bg.wasm', import.meta.url);";

function requireExplicitWasmUrl(): Plugin {
  return {
    name: "require-explicit-wasm-url",
    enforce: "pre",
    transform(code, id) {
      const normalizedId = id.split("?", 1)[0]?.replaceAll("\\", "/");
      if (!normalizedId?.endsWith("/src/wasm/convolve_core.js")) {
        return null;
      }
      if (!code.includes(WASM_FALLBACK)) {
        this.error("wasm-bindgen glue fallback shape changed");
      }
      return {
        code: code.replace(
          WASM_FALLBACK,
          'throw new Error("WASM module URL is required");',
        ),
        map: null,
      };
    },
  };
}

function preserveWorkerEntryForConsumers(): Plugin {
  return {
    name: "preserve-worker-entry-for-consumers",
    enforce: "post",
    renderChunk(code, chunk) {
      if (chunk.name !== "index" || !code.includes(WORKER_URL_PLACEHOLDER)) {
        return null;
      }
      return {
        code: code.replace(
          WORKER_URL_PLACEHOLDER,
          'new URL("./convolve.worker.js", import.meta.url)',
        ),
        map: null,
      };
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [requireExplicitWasmUrl(), preserveWorkerEntryForConsumers()],
  build: {
    lib: {
      entry: {
        index: "src/index.ts",
        "convolve.worker": "src/convolve.worker.ts",
      },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    assetsInlineLimit: 0,
    sourcemap: true,
  },
  worker: { format: "es" },
});
