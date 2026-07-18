import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(relativePath) {
  return readFile(new URL("../" + relativePath, import.meta.url), "utf8");
}

test("v0.1.2 release workflows share an exact package identity", async () => {
  const [candidate, publish, packageJson, jsrJson] = await Promise.all([
    source(".github/workflows/release-candidate.yml"),
    source(".github/workflows/publish-jsr.yml"),
    source("packages/convolve-wasm/package.json").then(JSON.parse),
    source("packages/convolve-wasm/jsr.json").then(JSON.parse),
  ]);

  assert.equal(packageJson.version, "0.1.2");
  assert.equal(jsrJson.version, packageJson.version);
  assert.ok(candidate.includes("convolve-wasm-jsr-0.1.2.tgz"));
  assert.ok(publish.includes("refs/tags/v0.1.2"));
  assert.ok(
    publish.includes(
      "PUBLISH @takana-labs/convolve-wasm@0.1.2 TO JSR",
    ),
  );
});

test("release workflows require both immutable Android physical evidence records", async () => {
  const [candidate, publish, v011Evidence, v012Evidence] = await Promise.all([
    source(".github/workflows/release-candidate.yml"),
    source(".github/workflows/publish-jsr.yml"),
    source("docs/testing/2026-07-17-mobile-safe-rejection.md"),
    source("docs/testing/2026-07-18-lower-memory-full-fft.md"),
  ]);

  for (const workflow of [candidate, publish]) {
    assert.ok(workflow.includes("node scripts/verify-android-release-gate.mjs"));
  }
  assert.match(
    v011Evidence,
    /^\*\*Physical Android status:\*\* (?:Not run|Failed|Pass)$/mu,
  );
  assert.match(
    v012Evidence,
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
test("v0.1.2 evidence and release notes retain the lower-memory release contract", async () => {
  const [release, evidence, architecture, browserSupport, packageReadme] = await Promise.all([
    source("docs/releases/v0.1.2.md"),
    source("docs/testing/2026-07-18-lower-memory-full-fft.md"),
    source("docs/architecture.md"),
    source("docs/browser-support.md"),
    source("packages/convolve-wasm/README.md"),
  ]);

  for (const hash of [
    "B72090BD221ECCC2AF1A59206C40BC279E0790CD2AFBD7C163409C4CF8A28FC9",
    "33A2AD19C95CDA18E59CD7D2745A138BA91B011ECC0606A30F4C22B0CE684059",
  ]) {
    assert.ok(evidence.includes(hash));
  }
  for (const estimate of ["235,793,987", "224.87 MiB", "250,835,531", "239.22 MiB"]) {
    assert.ok(evidence.includes(estimate));
  }
  assert.match(evidence, /^\*\*Physical Android status:\*\* Not run$/mu);
  assert.ok(release.includes("official Android completion"));
  assert.ok(architecture.includes("E + 3D + F + X + W + 2C + reserve"));
  assert.ok(architecture.includes("68-byte `WAVE_FORMAT_EXTENSIBLE`"));
  assert.ok(browserSupport.includes("iOS remains best effort"));
  assert.ok(packageReadme.includes("pull-based PCM24 streaming"));
});

test("v0.1.2 evidence makes both private-pair scenarios reproducible", async () => {
  const evidence = await source("docs/testing/2026-07-18-lower-memory-full-fft.md");

  assert.ok(evidence.includes("Both scenarios below must use this exact pair"));
  assert.match(
    evidence,
    /audio\.a[\s\S]*Supplied WAV[\s\S]*B72090BD221ECCC2AF1A59206C40BC279E0790CD2AFBD7C163409C4CF8A28FC9/,
  );
  assert.match(
    evidence,
    /audio\.b[\s\S]*Supplied M4A[\s\S]*33A2AD19C95CDA18E59CD7D2745A138BA91B011ECC0606A30F4C22B0CE684059/,
  );
  assert.match(
    evidence,
    /Plain safe rejection[\s\S]*`appendReverse: false`[\s\S]*`beatPan: null`[\s\S]*`panTransitionMs: 20`[\s\S]*`reverseCrossfadeMs: 5`[\s\S]*`targetDbtp: -1`[\s\S]*235,793,987 bytes/,
  );
  assert.match(
    evidence,
    /Reverse \+ beat-pan safe rejection[\s\S]*`appendReverse: true`[\s\S]*`beatPan: "a"`[\s\S]*`panTransitionMs: 20`[\s\S]*`reverseCrossfadeMs: 5`[\s\S]*`targetDbtp: -1`[\s\S]*250,835,531 bytes/,
  );
  assert.match(
    evidence,
    /`appendReverse` and `reverseCrossfadeMs` affect `finalFrames` and the memory estimate[\s\S]*`beatPan`, `panTransitionMs`, and `targetDbtp` are DSP-only and do not change the estimate/,
  );
});
