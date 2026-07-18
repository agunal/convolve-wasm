import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { synchronizeSiteUrl } from "../scripts/sync-site-url.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const tempRoot = path.join(repositoryRoot, "app_work", "tmp");

async function makeFixture() {
  await mkdir(tempRoot, { recursive: true });
  const root = await mkdtemp(path.join(tempRoot, "site-url-sync-"));
  await mkdir(path.join(root, "docs"), { recursive: true });
  await mkdir(path.join(root, "packages", "convolve-wasm"), { recursive: true });
  await writeFile(
    path.join(root, "README.md"),
    "before\n<!-- site-url:start -->\nold\n<!-- site-url:end -->\nafter\n",
  );
  await writeFile(
    path.join(root, "docs", "release-readiness.md"),
    "| Canonical site | <!-- site-url:start -->`old`<!-- site-url:end --> |\n| Registry | JSR |\n",
  );
  await writeFile(
    path.join(root, "packages", "convolve-wasm", "package.json"),
    `${JSON.stringify({ name: "pkg", homepage: "https://old.example/" }, null, 2)}\n`,
  );
  return root;
}

test("synchronizes every active derived URL deterministically", async () => {
  const root = await makeFixture();
  const result = await synchronizeSiteUrl({
    root,
    publicUrl: "https://example.com/app/",
    check: false,
  });

  assert.deepEqual(result.changed.sort(), [
    "README.md",
    "docs/release-readiness.md",
    "packages/convolve-wasm/package.json",
  ]);
  assert.equal(
    await readFile(path.join(root, "docs", "release-readiness.md"), "utf8"),
    [
      "| Canonical site | <!-- site-url:start -->`https://example.com/app/`<!-- site-url:end --> |",
      "| Registry | JSR |",
      "",
    ].join("\n"),
  );
  assert.equal(
    JSON.parse(
      await readFile(
        path.join(root, "packages", "convolve-wasm", "package.json"),
        "utf8",
      ),
    ).homepage,
    "https://example.com/app/",
  );

  const second = await synchronizeSiteUrl({
    root,
    publicUrl: "https://example.com/app/",
    check: false,
  });
  assert.deepEqual(second.changed, []);
});

test("check mode reports drift without writing files", async () => {
  const root = await makeFixture();
  const before = await readFile(path.join(root, "README.md"), "utf8");

  const result = await synchronizeSiteUrl({
    root,
    publicUrl: "https://example.com/",
    check: true,
  });

  assert.equal(result.changed.length, 3);
  assert.equal(await readFile(path.join(root, "README.md"), "utf8"), before);
});
