import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const CANONICAL_STATUS_LINE = "**Physical Android status:** Pass";
const STATUS_MARKER = /physical\s+android\s+status\b[^A-Za-z0-9]*:/iu;

function openingFence(line) {
  const match = /^( {0,3})(`{3,}|~{3,})/u.exec(line);
  if (!match) return null;
  return { character: match[2][0], length: match[2].length };
}

function closesFence(line, fence) {
  const match = /^( {0,3})(`+|~+)/u.exec(line);
  return Boolean(
    match &&
      match[2][0] === fence.character &&
      match[2].length >= fence.length,
  );
}

function statusFieldsOutsideFences(evidence) {
  const fields = [];
  let fence = null;

  for (const originalLine of evidence.split("\n")) {
    const line = originalLine.endsWith("\r")
      ? originalLine.slice(0, -1)
      : originalLine;

    if (fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }

    fence = openingFence(line);
    if (fence) continue;
    if (STATUS_MARKER.test(line)) fields.push(line);
  }

  return fields;
}

export function validatePhysicalAndroidEvidence(v011Evidence, v012Evidence) {
  for (const [release, evidence] of [
    ["v0.1.1", v011Evidence],
    ["v0.1.2", v012Evidence],
  ]) {
    const fields = statusFieldsOutsideFences(evidence);
    if (fields.length !== 1 || fields[0] !== CANONICAL_STATUS_LINE) {
      throw new Error(
        `${release} Android evidence must contain exactly one '**Physical Android status:** Pass' line`,
      );
    }
  }
}

export function validatePhysicalAndroidEvidenceFiles(root = process.cwd()) {
  const v011 = fs.readFileSync(
    path.join(root, "docs/testing/2026-07-17-mobile-safe-rejection.md"),
    "utf8",
  );
  const v012 = fs.readFileSync(
    path.join(root, "docs/testing/2026-07-18-lower-memory-full-fft.md"),
    "utf8",
  );
  validatePhysicalAndroidEvidence(v011, v012);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  validatePhysicalAndroidEvidenceFiles();
  console.log("Both physical Android evidence records explicitly pass.");
}