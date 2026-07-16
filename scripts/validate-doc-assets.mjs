import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const docsRoot = path.join(root, "docs");
const rawPrefix =
  "https://raw.githubusercontent.com/takana-labs/convolve-wasm/main/";
const ignoredDirectories = new Set(["superpowers"]);
const entryFiles = [
  path.join(root, "README.md"),
  path.join(root, "packages/convolve-wasm/README.md"),
];

async function collectMarkdown(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...(await collectMarkdown(path.join(directory, entry.name))));
      }
    } else if (entry.name.endsWith(".md")) {
      files.push(path.join(directory, entry.name));
    }
  }
  return files;
}

function imageReferences(source) {
  const references = [];
  for (const pattern of [
    /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi,
    /!\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g,
  ]) {
    for (const match of source.matchAll(pattern)) references.push(match[1]);
  }
  return references;
}

async function assertExists(file, reference, owner) {
  try {
    await access(file);
  } catch {
    throw new Error(`${owner}: missing image ${reference} -> ${file}`);
  }
}

const markdownFiles = [...entryFiles, ...(await collectMarkdown(docsRoot))];
let checked = 0;

for (const markdownFile of markdownFiles) {
  const source = await readFile(markdownFile, "utf8");
  for (const reference of imageReferences(source)) {
    if (reference.startsWith("data:") || reference.startsWith("#")) continue;

    const rawMatch = reference.match(
      /^https:\/\/raw\.githubusercontent\.com\/agunal\/convolve-wasm\/([^/]+)\/(.+)$/,
    );
    if (rawMatch) {
      if (!reference.startsWith(rawPrefix)) {
        throw new Error(
          `${path.relative(root, markdownFile)}: repository image must use main, not ${rawMatch[1]}`,
        );
      }
      await assertExists(
        path.join(root, rawMatch[2]),
        reference,
        path.relative(root, markdownFile),
      );
      checked += 1;
      continue;
    }

    if (/^https?:\/\//.test(reference)) continue;

    const cleanReference = decodeURIComponent(reference.split(/[?#]/, 1)[0]);
    const resolved = path.resolve(path.dirname(markdownFile), cleanReference);
    if (!resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error(
        `${path.relative(root, markdownFile)}: image escapes repository: ${reference}`,
      );
    }
    await assertExists(resolved, reference, path.relative(root, markdownFile));
    checked += 1;
  }
}

console.log(`Validated ${checked} repository documentation image reference(s).`);
