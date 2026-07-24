import { readFileSync } from "node:fs";

import { defineConfig } from "vite";

import { readSiteConfig } from "../../scripts/site-config.mjs";

export default defineConfig(() => {
  const siteConfig = readSiteConfig();
  const buildSha = process.env.GITHUB_SHA?.trim() || "local";
  const packageJson = JSON.parse(
    readFileSync(new URL("./package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  const appVersion =
    typeof packageJson.version === "string" ? packageJson.version : "unknown";

  return {
    base: "./",
    plugins: [
      {
        name: "convolve-site-metadata",
        transformIndexHtml(html) {
          return html
            .replaceAll("%PUBLIC_SITE_URL%", siteConfig.publicUrl)
            .replaceAll("%PUBLIC_SITE_LOGO_URL%", siteConfig.publicLogoUrl)
            .replaceAll("%BUILD_SHA%", buildSha)
            .replaceAll("%APP_VERSION%", appVersion);
        },
        configurePreviewServer(server) {
          const transferPath = "/transferred-owner/renamed-repo/";
          server.middlewares.use((request, _response, next) => {
            if (request.url?.startsWith(transferPath)) {
              request.url = `/${request.url.slice(transferPath.length)}`;
            }
            next();
          });
        },
      },
    ],
    server: { port: 4173 },
    preview: { port: 4173 },
  };
});
