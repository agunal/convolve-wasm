import assert from "node:assert/strict";
import test from "node:test";

import { validatePhysicalAndroidEvidence } from "../scripts/verify-android-release-gate.mjs";

const pass = "# evidence\n\n**Physical Android status:** Pass\n";

test("Android release gate permits only two explicit Pass records", () => {
  assert.doesNotThrow(() => validatePhysicalAndroidEvidence(pass, pass));
});

for (const [name, first, second] of [
  ["v0.1.1 Not run", "**Physical Android status:** Not run", pass],
  ["v0.1.2 Failed", pass, "**Physical Android status:** Failed"],
  ["missing status", pass, "# no status"],
  ["malformed status", pass, "**Physical Android status:** PASS"],
  ["mixed status lines", pass, "**Physical Android status:** Pass\n**Physical Android status:** Not run"],
]) {
  test(`Android release gate rejects ${name}`, () => {
    assert.throws(() => validatePhysicalAndroidEvidence(first, second), /must contain exactly/);
  });
}
for (const [name, evidence] of [
  [
    "a canonical Pass hidden only in a fenced code block",
    "```md\n**Physical Android status:** Pass\n```",
  ],
  [
    "an indented status marker alongside the canonical field",
    `${pass}    **Physical Android status:** Pass`,
  ],
  [
    "a blockquote status marker alongside the canonical field",
    `${pass}> **Physical Android status:** Pass`,
  ],
  [
    "a list status marker alongside the canonical field",
    `${pass}- **Physical Android status:** Pass`,
  ],
  ["a whitespace variant", "**Physical Android status:** Pass "],
  ["a case variant", "**Physical Android Status:** Pass"],
  ["a malformed emphasis variant", "**Physical Android status**: Pass"],
  [
    "duplicate canonical fields",
    `${pass}**Physical Android status:** Pass`,
  ],
  [
    "a canonical field plus a conflicting field",
    `${pass}**Physical Android status:** Not run`,
  ],
  [
    "prose containing a status-marker lookalike",
    `${pass}The required marker is **Physical Android status:** Pass.`,
  ],
]) {
  test(`Android release gate rejects ${name}`, () => {
    assert.throws(() => validatePhysicalAndroidEvidence(evidence, pass), /must contain exactly/);
  });
}

test("Android release gate accepts one canonical field outside a fenced example", () => {
  const evidence = `${pass}\n\`\`\`md\n**Physical Android status:** Not run\n\`\`\`\n`;
  assert.doesNotThrow(() => validatePhysicalAndroidEvidence(evidence, pass));
});
