import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    base: env.CONVOLVE_DEMO_BASE || "/",
    server: { port: 4173 },
    preview: { port: 4173 },
  };
});
