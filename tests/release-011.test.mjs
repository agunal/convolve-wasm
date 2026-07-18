import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(relativePath) {
  return readFile(new URL("../" + relativePath, import.meta.url), "utf8");
}

test("v0.1.1 release workflows share an exact package identity", async () => {
  const [candidate, publish, packageJson, jsrJson] = await Promise.all([
    source(".github/workflows/release-candidate.yml"),
    source(".github/workflows/publish-jsr.yml"),
    source("packages/convolve-wasm/package.json").then(JSON.parse),
    source("packages/convolve-wasm/jsr.json").then(JSON.parse),
  ]);

  assert.equal(packageJson.version, "0.1.1");
  assert.equal(jsrJson.version, packageJson.version);
  assert.ok(candidate.includes("convolve-wasm-jsr-0.1.1.tgz"));
  assert.ok(publish.includes("refs/tags/v0.1.1"));
  assert.ok(
    publish.includes(
      "PUBLISH @takana-labs/convolve-wasm@0.1.1 TO JSR",
    ),
  );
});

test("release packaging requires an explicit physical Android Pass", async () => {
  const [candidate, evidence] = await Promise.all([
    source(".github/workflows/release-candidate.yml"),
    source("docs/testing/2026-07-17-mobile-safe-rejection.md"),
  ]);

  assert.ok(
    candidate.includes("grep -Fx '**Physical Android status:** Pass'"),
  );
  assert.match(
    evidence,
    /^\*\*Physical Android status:\*\* (?:Not run|Failed|Pass)$/mu,
  );
});

test("CI and release-candidate pin the same wasm-pack version", async () => {
  const [ci, candidate] = await Promise.all([
    source(".github/workflows/ci.yml"),
    source(".github/workflows/release-candidate.yml"),
  ]);
  const installPattern = /cargo install wasm-pack --version (\d+\.\d+\.\d+) --locked/g;
  const ciPins = [...ci.matchAll(installPattern)];
  const candidatePins = [...candidate.matchAll(installPattern)];

  assert.equal(ciPins.length, 1);
  assert.equal(candidatePins.length, 1);
  assert.equal(ciPins[0][1], candidatePins[0][1]);
  assert.equal(ciPins[0][1], "0.15.0");
});
