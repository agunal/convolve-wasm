import path from "node:path";
import { pathToFileURL } from "node:url";

import { readSiteConfig } from "./site-config.mjs";

const expectedTypes = new Map([
  [".css", "text/css"],
  [".gif", "image/gif"],
  [".ico", "image/"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "javascript"],
  [".mjs", "javascript"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
  [".webp", "image/webp"],
  [".woff", "font/"],
  [".woff2", "font/"],
]);

function extractAttribute(tag, name) {
  return tag.match(new RegExp(`${name}=["']([^"']+)["']`, "iu"))?.[1] ?? null;
}

function resolveLocal(reference, baseUrl, deploymentUrl) {
  if (
    !reference ||
    reference.startsWith("data:") ||
    reference.startsWith("blob:") ||
    reference.startsWith("#")
  ) {
    return null;
  }
  const url = new URL(reference, baseUrl);
  if (url.origin !== deploymentUrl.origin) return null;
  const isAbsoluteReference =
    reference.startsWith("/") || /^[a-z][a-z\d+.-]*:/iu.test(reference);
  if (isAbsoluteReference || !url.pathname.startsWith(deploymentUrl.pathname)) {
    throw new Error(
      `Asset reference ${JSON.stringify(reference)} resolves outside configured Pages path ${deploymentUrl.pathname}`,
    );
  }
  return url.href;
}

function collectHtmlAssets(html, documentUrl, deploymentUrl) {
  const assets = [];
  const resourceLinkRelations = new Set([
    "icon",
    "manifest",
    "modulepreload",
    "preload",
    "stylesheet",
  ]);
  for (const match of html.matchAll(/<(?:script|link|img|source)\b[^>]*>/giu)) {
    const tag = match[0];
    if (tag.startsWith("<link")) {
      const relations = (extractAttribute(tag, "rel") ?? "").toLowerCase().split(/\s+/u);
      if (!relations.some((relation) => resourceLinkRelations.has(relation))) continue;
    }
    const reference = extractAttribute(tag, tag.startsWith("<link") ? "href" : "src");
    const resolved = resolveLocal(reference, documentUrl, deploymentUrl);
    if (resolved) assets.push(resolved);

    const srcset = extractAttribute(tag, "srcset");
    if (srcset) {
      for (const candidate of srcset.split(",")) {
        const candidateReference = candidate.trim().split(/\s+/u)[0];
        const candidateUrl = resolveLocal(candidateReference, documentUrl, deploymentUrl);
        if (candidateUrl) assets.push(candidateUrl);
      }
    }
  }
  return assets;
}

function collectJavaScriptAssets(source, scriptUrl, deploymentUrl) {
  const assets = [];
  const expressions = [
    /new\s+URL\(\s*["'`]([^"'`?#]+\.[a-z\d]+)(?:[?#][^"'`]*)?["'`]/giu,
    /import\(\s*["'`]([^"'`?#]+)(?:[?#][^"'`]*)?["'`]\s*\)/giu,
    /(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["'`]([^"'`?#]+)(?:[?#][^"'`]*)?["'`]/giu,
  ];
  for (const expression of expressions) {
    for (const match of source.matchAll(expression)) {
      const resolved = resolveLocal(match[1], scriptUrl, deploymentUrl);
      if (resolved) assets.push(resolved);
    }
  }
  return assets;
}

function collectCssAssets(source, stylesheetUrl, deploymentUrl) {
  const assets = [];
  for (const expression of [
    /url\(\s*["']?([^"')?#]+)(?:[?#][^"')]*)?["']?\s*\)/giu,
    /@import\s+(?:url\(\s*)?["']([^"'?#]+)(?:[?#][^"']*)?["']/giu,
  ]) {
    for (const match of source.matchAll(expression)) {
      const resolved = resolveLocal(match[1], stylesheetUrl, deploymentUrl);
      if (resolved) assets.push(resolved);
    }
  }
  return assets;
}

function requireContentType(url, response) {
  const extension = path.extname(new URL(url).pathname).toLowerCase();
  const expected = expectedTypes.get(extension);
  const actual = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (actual.includes("text/html")) {
    throw new Error(`${url} returned text/html instead of an asset`);
  }
  if (expected && !actual.includes(expected)) {
    throw new Error(`${url} returned ${actual || "no content type"}; expected ${expected}`);
  }
}

async function verifyOnce({ publicUrl, buildSha, fetchImpl, signal }) {
  const documentUrl = new URL(publicUrl);
  documentUrl.searchParams.set("deployment", buildSha);
  const headers = { "cache-control": "no-cache" };
  const pageResponse = await fetchImpl(documentUrl, {
    headers,
    redirect: "follow",
    signal,
  });
  if (!pageResponse.ok) {
    throw new Error(`${publicUrl} returned HTTP ${pageResponse.status}`);
  }
  const pageType = pageResponse.headers.get("content-type")?.toLowerCase() ?? "";
  if (!pageType.includes("text/html")) {
    throw new Error(`${publicUrl} returned ${pageType || "no content type"}; expected text/html`);
  }
  const html = await pageResponse.text();
  const deployedSha = html.match(
    /<meta\s+name=["']convolve-build["']\s+content=["']([^"']+)["']/iu,
  )?.[1];
  if (deployedSha !== buildSha) {
    throw new Error(
      `${publicUrl} exposes build SHA ${JSON.stringify(deployedSha)}; expected ${buildSha}`,
    );
  }

  const deploymentUrl = new URL(publicUrl);
  const queue = collectHtmlAssets(html, deploymentUrl, deploymentUrl);
  const visited = new Set();
  while (queue.length > 0) {
    const assetUrl = queue.shift();
    if (!assetUrl || visited.has(assetUrl)) continue;
    visited.add(assetUrl);
    const response = await fetchImpl(assetUrl, { headers, redirect: "follow", signal });
    if (!response.ok) throw new Error(`${assetUrl} returned HTTP ${response.status}`);
    requireContentType(assetUrl, response);
    const extension = path.extname(new URL(assetUrl).pathname).toLowerCase();
    if (extension === ".js" || extension === ".mjs") {
      queue.push(
        ...collectJavaScriptAssets(await response.text(), new URL(assetUrl), deploymentUrl),
      );
    } else if (extension === ".css") {
      queue.push(
        ...collectCssAssets(await response.text(), new URL(assetUrl), deploymentUrl),
      );
    }
  }

  const assets = [...visited];
  const assetPaths = assets.map((url) => new URL(url).pathname);
  for (const [name, pattern] of [
    ["stylesheet", /\.css$/iu],
    ["JavaScript", /\.(?:m?js)$/iu],
    ["logo image", /\.(?:gif|ico|jpe?g|png|svg|webp)$/iu],
    ["module worker", /\/[^/]*worker[^/]*\.(?:m?js)$/iu],
    ["WASM", /\.wasm$/iu],
  ]) {
    if (!assetPaths.some((assetPath) => pattern.test(assetPath))) {
      throw new Error(`The deployed page did not expose a ${name} asset`);
    }
  }

  return { assets };
}

export async function verifyPublicSite({
  publicUrl,
  buildSha,
  fetchImpl = fetch,
  attempts = 18,
  delayMs = 5_000,
  timeoutMs = 90_000,
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  const deadline = now() + timeoutMs;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    try {
      const result = await verifyOnce({
        publicUrl,
        buildSha,
        fetchImpl,
        signal: AbortSignal.timeout(Math.max(1, Math.ceil(remaining))),
      });
      return { ...result, attempts: attempt };
    } catch (error) {
      lastError = error;
      const delay = Math.min(delayMs, Math.max(0, deadline - now()));
      if (attempt < attempts && delay > 0) await sleep(delay);
    }
  }

  if (now() >= deadline) {
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Timed out after ${timeoutMs}ms verifying ${publicUrl}. Last error: ${detail}`);
  }
  throw lastError;
}

async function main() {
  const { publicUrl } = readSiteConfig();
  const buildSha = process.env.GITHUB_SHA?.trim();
  if (!buildSha) throw new Error("GITHUB_SHA is required for the public-site smoke");
  const result = await verifyPublicSite({ publicUrl, buildSha });
  console.log(
    `Verified ${publicUrl} at ${buildSha} after ${result.attempts} attempt(s), including ${result.assets.length} asset(s).`,
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`::error title=Public Pages smoke failed::${message}`);
    process.exitCode = 1;
  }
}
