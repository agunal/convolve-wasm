import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("apps/demo/dist");

async function walk(directory) {
  const entries = await readdir(directory);
  const files = [];

  for (const entry of entries) {
    const absolute = path.join(directory, entry);
    const info = await stat(absolute);
    if (info.isDirectory()) {
      files.push(...(await walk(absolute)));
    } else if (info.isFile()) {
      files.push(path.relative(root, absolute).replaceAll(path.sep, "/"));
    }
  }

  return files.sort();
}

function requireValue(value, message) {
  if (!value) throw new Error(message);
  return value;
}

const files = await walk(root);
const indexPath = requireValue(
  files.find((file) => file === "index.html"),
  "Pages artifact is missing index.html",
);
const logoPath = requireValue(
  files.find((file) => file === "convolve-wasm-logo.png"),
  "Pages artifact is missing the canonical logo",
);
const workerPath = requireValue(
  files.find((file) => /(^|\/)convolve\.worker(?:-[^/]+)?\.js$/u.test(file)),
  "Pages artifact is missing the module worker",
);
const wasmPath = requireValue(
  files.find((file) => file.endsWith(".wasm")),
  "Pages artifact is missing the WASM binary",
);

const privateAudio = files.filter((file) => /\.(?:m4a|wav)$/iu.test(file));
if (privateAudio.length > 0) {
  throw new Error(`Pages artifact contains audio files: ${privateAudio.join(", ")}`);
}

const html = await readFile(path.join(root, indexPath), "utf8");
if (!html.includes("/convolve-wasm/")) {
  throw new Error("Pages HTML does not use the /convolve-wasm/ base path");
}
if (html.includes("/src/")) {
  throw new Error("Pages HTML still references source files");
}

for (const match of html.matchAll(/(?:src|href)="([^"]+)"/gu)) {
  const reference = match[1];

  if (!reference) {
    continue;
  }

  // Ignore external URLs, protocol-relative URLs, and page fragments.
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/iu.test(reference)) {
    continue;
  }

  if (reference.startsWith("/convolve-wasm/")) {
    throw new Error(
      `Pages HTML contains the obsolete /convolve-wasm/ prefix: ${reference}`,
    );
  }

  if (!reference.startsWith("/")) {
    throw new Error(
      `Pages HTML contains a non-root-relative local reference: ${reference}`,
    );
  }
}

/*
for (const match of html.matchAll(/(?:src|href)="([^"]+)"/gu)) {
  const reference = match[1];
  if (!reference?.startsWith("/") || reference.startsWith("/convolve-wasm/")) {
    throw new Error(`Pages HTML contains a domain-root asset reference: ${reference}`);
  }
}
*/

console.log(
  JSON.stringify(
    {
      root,
      index: indexPath,
      logo: logoPath,
      worker: workerPath,
      wasm: wasmPath,
      files: files.length,
    },
    null,
    2,
  ),
);
