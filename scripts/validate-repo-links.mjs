import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const docsRoot = path.join(root, "docs");
const ignoredDirectories = new Set(["superpowers"]);
const sourceFiles = [
  path.join(root, "README.md"),
  path.join(root, "packages/convolve-wasm/README.md"),
  path.join(root, "apps/demo/index.html"),
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

function linkReferences(source) {
  const references = [];
  for (const pattern of [
    /(?<!!)\[[^\]]+\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g,
    /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi,
  ]) {
    for (const match of source.matchAll(pattern)) references.push(match[1]);
  }
  return references;
}

async function assertExists(target, reference, owner) {
  try {
    await access(target);
  } catch {
    throw new Error(`${owner}: missing link target ${reference} -> ${target}`);
  }
}

function cleanReference(reference) {
  return decodeURIComponent(reference.split(/[?#]/, 1)[0]);
}

const files = [...sourceFiles, ...(await collectMarkdown(docsRoot))];
let checked = 0;

for (const file of files) {
  const owner = path.relative(root, file);
  const source = await readFile(file, "utf8");

  for (const reference of linkReferences(source)) {
    if (
      reference.startsWith("#") ||
      /^(?:mailto|tel|javascript|data|blob):/i.test(reference)
    ) {
      continue;
    }

    if (reference === "https://github.com/takana-labs/convolve-wasm") {
      checked += 1;
      continue;
    }

    if (reference === "https://convolve-wasm.app/") {
      checked += 1;
      continue;
    }

    const repositoryMatch = reference.match(
      /^https:\/\/github\.com\/agunal\/convolve-wasm\/(blob|tree)\/([^/]+)\/(.+?)(?:[?#].*)?$/,
    );
    if (repositoryMatch) {
      const [, kind, ref, repositoryPath] = repositoryMatch;
      if (ref !== "main") {
        throw new Error(`${owner}: repository link must use main, not ${ref}`);
      }
      const target = path.join(root, decodeURIComponent(repositoryPath));
      await assertExists(target, reference, owner);
      checked += 1;
      if (kind === "blob" && repositoryPath.endsWith("/")) {
        throw new Error(`${owner}: blob link cannot target a directory: ${reference}`);
      }
      continue;
    }

    const rawMatch = reference.match(
      /^https:\/\/raw\.githubusercontent\.com\/agunal\/convolve-wasm\/([^/]+)\/(.+?)(?:[?#].*)?$/,
    );
    if (rawMatch) {
      const [, ref, repositoryPath] = rawMatch;
      if (ref !== "main") {
        throw new Error(`${owner}: raw repository link must use main, not ${ref}`);
      }
      await assertExists(
        path.join(root, decodeURIComponent(repositoryPath)),
        reference,
        owner,
      );
      checked += 1;
      continue;
    }

    if (/^https?:\/\//i.test(reference)) continue;

    const cleaned = cleanReference(reference);
    if (!cleaned) continue;
    const target = path.resolve(path.dirname(file), cleaned);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new Error(`${owner}: link escapes repository: ${reference}`);
    }
    await assertExists(target, reference, owner);
    checked += 1;
  }
}

console.log(`Validated ${checked} repository documentation and site link(s).`);
