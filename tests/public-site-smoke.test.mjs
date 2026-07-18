import assert from "node:assert/strict";
import test from "node:test";

import { verifyPublicSite } from "../scripts/public-site-smoke.mjs";

function response(body, contentType, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
}

function page(buildSha) {
  return `<!doctype html><html><head>
    <meta name="convolve-build" content="${buildSha}">
    <link rel="stylesheet" href="./assets/app.css">
    <link rel="icon" href="./logo.png">
    <link rel="modulepreload" href="./assets/preloaded.js">
    <script type="module" src="./assets/app.js"></script>
  </head></html>`;
}

test("retries stale HTML and recursively verifies the complete generated asset graph", async () => {
  let pageAttempts = 0;
  const fetched = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    fetched.push(url.pathname);
    if (url.pathname === "/") {
      pageAttempts += 1;
      return response(
        page(pageAttempts === 1 ? "old-sha" : "new-sha"),
        "text/html; charset=utf-8",
      );
    }
    if (url.pathname.endsWith("app.js")) {
      return response(
        'new Worker(new URL("convolve.worker.js", import.meta.url)); import("./lazy.js");',
        "application/javascript",
      );
    }
    if (url.pathname.endsWith("convolve.worker.js")) {
      return response(
        'const wasm = new URL("convolve_core_bg.wasm", import.meta.url);',
        "application/javascript",
      );
    }
    if (url.pathname.endsWith("app.css")) {
      return response(
        '@import "./theme.css"; body { background: url("../texture.png"); }',
        "text/css",
      );
    }
    if (url.pathname.endsWith(".wasm")) return response("wasm", "application/wasm");
    if (url.pathname.endsWith(".css")) return response("css", "text/css");
    if (url.pathname.endsWith(".js")) return response("js", "application/javascript");
    if (url.pathname.endsWith(".png")) return response("png", "image/png");
    return response("missing", "text/plain", 404);
  };

  const result = await verifyPublicSite({
    publicUrl: "https://example.com/",
    buildSha: "new-sha",
    fetchImpl,
    attempts: 2,
    delayMs: 0,
    sleep: async () => {},
  });

  assert.equal(result.attempts, 2);
  for (const suffix of [
    "preloaded.js",
    "convolve.worker.js",
    "convolve_core_bg.wasm",
    "lazy.js",
    "theme.css",
    "texture.png",
  ]) {
    assert.ok(fetched.some((pathname) => pathname.endsWith(suffix)), suffix);
  }
});

test("rejects HTML fallbacks returned for JavaScript after retry exhaustion", async () => {
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/") return response(page("new-sha"), "text/html");
    if (url.pathname.endsWith("app.js")) return response("fallback", "text/html");
    if (url.pathname.endsWith(".css")) return response("css", "text/css");
    if (url.pathname.endsWith(".png")) return response("png", "image/png");
    if (url.pathname.endsWith(".js")) return response("js", "application/javascript");
    return response("missing", "text/plain", 404);
  };

  await assert.rejects(
    verifyPublicSite({
      publicUrl: "https://example.com/",
      buildSha: "new-sha",
      fetchImpl,
      attempts: 2,
      delayMs: 0,
      sleep: async () => {},
    }),
    /app\.js.*text\/html/i,
  );
});

test("never forwards credentials to the public site", async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    calls.push(init.headers ?? {});
    if (url.pathname === "/") return response(page("new-sha"), "text/html");
    if (url.pathname.endsWith("app.js")) {
      return response(
        'new Worker(new URL("convolve.worker.js", import.meta.url));',
        "application/javascript",
      );
    }
    if (url.pathname.endsWith("convolve.worker.js")) {
      return response(
        'new URL("convolve_core_bg.wasm", import.meta.url);',
        "application/javascript",
      );
    }
    if (url.pathname.endsWith(".wasm")) return response("", "application/wasm");
    if (url.pathname.endsWith(".css")) return response("", "text/css");
    if (url.pathname.endsWith(".js")) return response("", "application/javascript");
    return response("", "image/png");
  };

  await verifyPublicSite({
    publicUrl: "https://example.com/",
    buildSha: "new-sha",
    fetchImpl,
    attempts: 1,
  });

  assert.ok(calls.every((headers) => headers.authorization === undefined));
});

test("rejects generated asset references outside the configured Pages path", async (t) => {
  const cases = [
    {
      name: "root-absolute HTML asset",
      htmlExtra: '<img src="/escaped.png">',
    },
    {
      name: "root-absolute CSS asset",
      cssExtra: "body { background: url(/escaped.png); }",
    },
    {
      name: "JavaScript traversal outside the deployment",
      jsExtra: 'new URL("../../escaped.worker.js", import.meta.url);',
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const fetchImpl = async (input) => {
        const url = new URL(input);
        if (url.pathname === "/repo/") {
          return response(
            page("new-sha").replace("</head>", `${testCase.htmlExtra ?? ""}</head>`),
            "text/html",
          );
        }
        if (url.pathname.endsWith("app.js")) {
          return response(
            `new Worker(new URL("convolve.worker.js", import.meta.url));${testCase.jsExtra ?? ""}`,
            "application/javascript",
          );
        }
        if (url.pathname.endsWith("convolve.worker.js")) {
          return response(
            'new URL("convolve_core_bg.wasm", import.meta.url);',
            "application/javascript",
          );
        }
        if (url.pathname.endsWith("app.css")) {
          return response(testCase.cssExtra ?? "body {}", "text/css");
        }
        if (url.pathname.endsWith(".wasm")) return response("", "application/wasm");
        if (url.pathname.endsWith(".js")) return response("", "application/javascript");
        if (url.pathname.endsWith(".png")) return response("", "image/png");
        return response("missing", "text/plain", 404);
      };

      await assert.rejects(
        verifyPublicSite({
          publicUrl: "https://example.com/repo/",
          buildSha: "new-sha",
          fetchImpl,
          attempts: 1,
        }),
        /asset reference .* outside configured Pages path \/repo\//iu,
      );
    });
  }
});

test("aborts a stalled request at the deployment deadline", async () => {
  const fetchImpl = async (_input, { signal }) =>
    new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(() => {}, 1_000);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(keepAlive);
          reject(signal.reason);
        },
        { once: true },
      );
    });

  await assert.rejects(
    verifyPublicSite({
      publicUrl: "https://example.com/",
      buildSha: "new-sha",
      fetchImpl,
      attempts: 18,
      timeoutMs: 10,
    }),
    /Timed out after 10ms/u,
  );
});
