# Mobile Crash Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add demo-only, bounded local crash diagnostics that survive an abrupt renderer termination, recover an unfinished attempt on reload, and export a strictly privacy-filtered report without changing `CONVOLVE()`, DSP, metadata, progress, errors, or WAV bytes.

**Architecture:** The package emits a private, best-effort union of sanitized lifecycle events, including safe worker/WASM protocol events and aggregate output milestones. The hosted demo owns a versioned `localStorage` ring, active marker, recovery inference, strict field-by-field sanitization, export, and dark diagnostics UI. Acceptance tests establish the user-visible recovery/export and diagnostic-failure-isolation contract first; focused unit tests then drive every internal component.

**Tech Stack:** TypeScript 7, Vitest 4, Vite 8, browser `localStorage`, Web Worker protocol messages, Playwright 1.61, Rust/WASM golden suites, GitHub Pages static build.

## Global Constraints

- Use acceptance-test-driven development for recovered-session UI/export, storage-failure isolation, clearing, layout, and clean-console behavior.
- Use red-green-refactor TDD for sanitizer, schema validation, storage, recovery, event capture, coalescing, and lifecycle instrumentation.
- Run JavaScript commands with bundled Node.js 24.14.0 from `C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin`.
- Persistent diagnostics are demo-only; importing `@takana-labs/convolve-wasm` must never access storage.
- Preserve the public `CONVOLVE()` API, progress callbacks, error behavior, metadata, DSP, PCM output, and browser-specific WAV hashes.
- Do not add v0.2.0 processing modes, bounded convolution, analytics, telemetry, cookies, uploads, server processing, or third-party logging.
- Never retain audio bytes, samples, decoded channels, filenames, paths, source URLs, Blob URLs, stacks, or unknown object fields.
- Bound retention to 6 sessions, 96 checkpoints and 32,768 UTF-8 JSON bytes per session.
- Diagnostic failure must be caught at every boundary and must never reject or alter processing.
- Do not commit private audio, exported diagnostic JSON, generated WAV files, Blob URLs, or generated source-tree WASM.

---

## File map

### New files

- `tests/e2e/diagnostics.spec.ts` — ATDD contract for recovery, export, clear, storage failure, unchanged output, and clean browser logs.
- `apps/demo/src/diagnostics/model.ts` — schema constants, bounded types, validation, and explicit migration dispatch.
- `apps/demo/src/diagnostics/sanitize.ts` — string/error/checkpoint allowlists and privacy redaction.
- `apps/demo/src/diagnostics/sanitize.test.ts` — strict redaction and unknown-field tests.
- `apps/demo/src/diagnostics/recorder.ts` — ring, active marker, recovery, pruning, coalescing, export, and clear.
- `apps/demo/src/diagnostics/recorder.test.ts` — storage, recovery, quota, progress, export, and failure-isolation tests.
- `apps/demo/src/diagnostics/browser.ts` — browser environment capture, package-event mapping, global incident listeners, UI state, copy/download/clear.
- `apps/demo/src/diagnostics/browser.test.ts` — safe event/error mapping and diagnostic-operation failure tests.
- `packages/convolve-wasm/src/diagnostics.ts` — private safe lifecycle union and no-throw browser emitter.
- `packages/convolve-wasm/src/diagnostics.test.ts` — package emitter redaction and observer isolation.
- `docs/mobile-crash-diagnostics.md` — collection boundary, retention, inference, Android workflow, remote debugging, and `adb logcat`.

### Modified files

- `packages/convolve-wasm/src/decode.ts` and `decode.test.ts` — decode boundary events without names or bytes.
- `packages/convolve-wasm/src/convolver.ts` and `index.test.ts` — normalized option, memory-plan, admission, and terminal lifecycle events.
- `packages/convolve-wasm/src/worker-protocol.ts` — private WASM-init diagnostic response union.
- `packages/convolve-wasm/src/worker-runtime.ts` and `worker-runtime.test.ts` — WASM-init start/success/failure reports.
- `packages/convolve-wasm/src/worker-client.ts` and `worker-client.test.ts` — worker creation/errors/messageerror/cancel and sampled output aggregates.
- `packages/convolve-wasm/src/index.ts` — wire the private no-throw browser emitter without changing exports.
- `apps/demo/src/main.ts` — begin/finish attempts and preserve current UI/result behavior.
- `apps/demo/index.html` — app-version metadata, Diagnostics section, and failure-side download action.
- `apps/demo/src/styles.css` — dark diagnostics styling and responsive containment.
- `apps/demo/vite.config.ts` — inject the demo version alongside the existing build SHA.
- `tests/e2e/layout.spec.ts` — diagnostics layout and touch-target acceptance checks.
- `README.md`, `docs/architecture.md`, and `docs/browser-support.md` — link and summarize diagnostics behavior.

---

### Task 1: Write the user-facing acceptance contract first

**Files:**
- Create: `tests/e2e/diagnostics.spec.ts`
- Modify: `tests/e2e/layout.spec.ts`

**Interfaces:**
- Consumes: existing demo IDs `#audio-a`, `#audio-b`, `#run`, `#status`, `#download`.
- Produces: required UI IDs `#diagnostics-storage`, `#diagnostics-recovered`, `#diagnostics-summary`, `#diagnostics-download`, `#diagnostics-copy`, `#diagnostics-clear`, and `#failure-diagnostics-download`.
- Produces: storage keys `convolve-wasm:diagnostics:v1` and `convolve-wasm:diagnostics:active:v1`.

- [ ] **Step 1: Add the unfinished-session recovery and JSON-export acceptance test**

Create `tests/e2e/diagnostics.spec.ts` with the storage seed below. Keep the seed field list identical to schema v1 so the test represents an intentionally incomplete real record rather than arbitrary localStorage text.

```ts
import { createHash } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import {
  makeClickTrackWav,
  makeImpulseResponseWav,
  makeSourceAWav,
} from "./fixtures";

const STORE_KEY = "convolve-wasm:diagnostics:v1";
const ACTIVE_KEY = "convolve-wasm:diagnostics:active:v1";
const PRIVATE_SENTINEL = "secret-mobile-source.wav";
const PLAIN_HASH = {
  chromium: "58e72d8bb4e6585e26542dd164b44b7de7f2292973a4b9e4cfe5241df1facbc1",
  webkit: "301846c1872c07cf8dbc71d62d524cd2a9c7aa3d9aab921ff8c475702b707a3c",
} as const;

function watchFailures(page: Page) {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  return { pageErrors, consoleErrors };
}

async function downloadedText(page: Page, selector: string): Promise<string> {
  const pending = page.waitForEvent("download");
  await page.locator(selector).click();
  const stream = await (await pending).createReadStream();
  if (!stream) throw new Error("Diagnostics download has no readable stream");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

test("recovers and exports an intentionally unfinished prior session", async ({
  page,
}) => {
  const failures = watchFailures(page);
  await page.addInitScript(
    ({ storeKey, activeKey, privateSentinel }) => {
      const startedAt = "2026-07-23T20:00:00.000Z";
      localStorage.setItem(
        storeKey,
        JSON.stringify({
          schemaVersion: 1,
          sessions: [
            {
              schemaVersion: 1,
              id: "seed-unfinished-session",
              startedAt,
              updatedAt: "2026-07-23T20:00:03.000Z",
              status: "active",
              app: { version: "0.1.0", buildCommit: "seed-build" },
              environment: {
                userAgent: "Seed Android Chrome",
                platform: "Linux armv8l",
                deviceMemoryGiB: 4,
                hardwareConcurrency: 8,
                capabilities: {
                  webAssembly: true,
                  worker: true,
                  offlineAudioContext: true,
                  readableStream: true,
                  responseBlob: true,
                  randomUUID: true,
                  localStorage: true,
                  clipboard: false,
                },
              },
              checkpoints: [
                {
                  sequence: 1,
                  type: "session-start",
                  timestamp: startedAt,
                  elapsedMs: 0,
                  details: { diagnosticSchemaVersion: 1 },
                },
                {
                  sequence: 2,
                  type: "memory-plan",
                  timestamp: "2026-07-23T20:00:03.000Z",
                  elapsedMs: 3000,
                  details: {
                    estimatedBytes: 150000000,
                    limitBytes: 201326592,
                    fftFrames: 4194304,
                    outputFrames: 2507164,
                    finalFrames: 5014088,
                    appendReverse: true,
                    admitted: true,
                  },
                    unknownPrivate: privateSentinel,
                },
              ],
              droppedCheckpoints: 0,
            },
          ],
        }),
      );
      localStorage.setItem(
        activeKey,
        JSON.stringify({
          schemaVersion: 1,
          sessionId: "seed-unfinished-session",
          startedAt,
          updatedAt: "2026-07-23T20:00:03.000Z",
          lastCheckpointSequence: 2,
          appVersion: "0.1.0",
          buildCommit: "seed-build",
        }),
      );
    },
    {
      storeKey: STORE_KEY,
      activeKey: ACTIVE_KEY,
      privateSentinel: PRIVATE_SENTINEL,
    },
  );

  await page.goto("/");

  await expect(page.locator("#diagnostics-recovered")).toBeVisible();
  await expect(page.locator("#diagnostics-recovered")).toContainText(
    "unexpected termination",
  );
  await expect(page.locator("#diagnostics-recovered")).toContainText(
    /does not prove.*out.of.memory/i,
  );
  await expect(page.locator("#diagnostics-summary")).toContainText(
    "unexpected-termination",
  );

  const json = await downloadedText(page, "#diagnostics-download");
  const report = JSON.parse(json) as {
    exportFormat: string;
    exportVersion: number;
    notice: string;
    privacy: Record<string, boolean>;
    sessions: Array<{ id: string; status: string; inference?: { kind: string } }>;
  };
  expect(report.exportFormat).toBe("convolve-wasm-diagnostics");
  expect(report.exportVersion).toBe(1);
  expect(report.notice).toMatch(/inference/i);
  expect(report.privacy).toEqual({
    audioDataRecorded: false,
    fileNamesRecorded: false,
    automaticUpload: false,
  });
  expect(report.sessions).toEqual([
    expect.objectContaining({
      id: "seed-unfinished-session",
      status: "unexpected-termination",
      inference: expect.objectContaining({ kind: "unexpected-termination" }),
    }),
  ]);
  expect(json).not.toContain(PRIVATE_SENTINEL);
  expect(failures).toEqual({ pageErrors: [], consoleErrors: [] });
});
```

- [ ] **Step 2: Add clear, clipboard-availability, and storage-failure isolation acceptance cases**

Append the following cases to `tests/e2e/diagnostics.spec.ts`:

```ts
test("clears only diagnostics after confirmation", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(({ storeKey, activeKey }) => {
    localStorage.setItem(storeKey, JSON.stringify({ schemaVersion: 1, sessions: [] }));
    localStorage.setItem(
      activeKey,
      JSON.stringify({
        schemaVersion: 1,
        sessionId: "stale",
        startedAt: "2026-07-23T20:00:00.000Z",
        updatedAt: "2026-07-23T20:00:00.000Z",
        lastCheckpointSequence: 1,
        appVersion: "0.1.0",
        buildCommit: "test",
      }),
    );
    localStorage.setItem("unrelated-origin-key", "keep-me");
  }, { storeKey: STORE_KEY, activeKey: ACTIVE_KEY });
  await page.reload();

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#diagnostics-clear").click();

  await expect(page.locator("#diagnostics-summary")).toContainText(
    "No retained diagnostic sessions",
  );
  expect(
    await page.evaluate(
      ({ storeKey, activeKey }) => ({
        store: localStorage.getItem(storeKey),
        active: localStorage.getItem(activeKey),
        unrelated: localStorage.getItem("unrelated-origin-key"),
      }),
      { storeKey: STORE_KEY, activeKey: ACTIVE_KEY },
    ),
  ).toEqual({ store: null, active: null, unrelated: "keep-me" });
});

test("shows copy only when the Clipboard API is available", async ({ page }) => {
  await page.goto("/");
  const supported = await page.evaluate(
    () => typeof navigator.clipboard?.writeText === "function",
  );
  await expect(page.locator("#diagnostics-copy")).toBeVisible({
    visible: supported,
  });
});

test("diagnostic quota failures cannot block a later byte-identical render", async ({
  browserName,
  page,
}) => {
  const failures = watchFailures(page);
  await page.addInitScript(({ prefix }) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith(prefix)) {
        throw new DOMException("diagnostic quota blocked", "QuotaExceededError");
      }
      return original.call(this, key, value);
    };
  }, { prefix: "convolve-wasm:diagnostics:" });
  await page.goto("/");

  await page.locator("#audio-a").setInputFiles({
    name: "private-a.wav",
    mimeType: "audio/wav",
    buffer: makeSourceAWav(),
  });
  await page.locator("#audio-b").setInputFiles({
    name: "private-b.wav",
    mimeType: "audio/wav",
    buffer: makeImpulseResponseWav(),
  });
  await page.locator("#run").click();
  await expect(page.locator("#status")).toHaveAttribute("data-state", "done", {
    timeout: 90_000,
  });
  await expect(page.locator("#diagnostics-storage")).toContainText(
    /quota|current tab/i,
  );

  const bytes = await page.locator("#download").evaluate(async (link: HTMLAnchorElement) =>
    Array.from(new Uint8Array(await (await fetch(link.href)).arrayBuffer())),
  );
  expect(createHash("sha256").update(Uint8Array.from(bytes)).digest("hex")).toBe(
    PLAIN_HASH[browserName as keyof typeof PLAIN_HASH],
  );
  expect(failures).toEqual({ pageErrors: [], consoleErrors: [] });
});

test("offers diagnostic export beside a structured processing failure", async ({
  page,
}) => {
  const failures = watchFailures(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "deviceMemory", {
      configurable: true,
      value: 1,
    });
  });
  await page.goto("/");
  const longAudio = makeClickTrackWav();
  await page.locator("#audio-a").setInputFiles({
    name: "do-not-export-a.wav",
    mimeType: "audio/wav",
    buffer: longAudio,
  });
  await page.locator("#audio-b").setInputFiles({
    name: "do-not-export-b.wav",
    mimeType: "audio/wav",
    buffer: longAudio,
  });
  await page.locator("#run").click();

  await expect(page.locator("#status")).toHaveAttribute("data-state", "error");
  await expect(page.locator("#status")).toContainText("INPUT_TOO_LARGE");
  await expect(page.locator("#failure-diagnostics-download")).toBeVisible();
  const json = await downloadedText(page, "#failure-diagnostics-download");
  expect(JSON.parse(json).sessions.at(-1)).toMatchObject({ status: "failed" });
  expect(json).not.toContain("do-not-export-a.wav");
  expect(json).not.toContain("do-not-export-b.wav");
  expect(failures).toEqual({ pageErrors: [], consoleErrors: [] });
});
```

- [ ] **Step 3: Extend responsive acceptance coverage**

In `tests/e2e/layout.spec.ts`, require the diagnostics panel to be visible and contained at all three existing viewports:

```ts
await expect(page.locator("#diagnostics")).toBeVisible();
await expectTouchTarget(page, "#diagnostics-download");
await expectTouchTarget(page, "#diagnostics-clear");
```

For phone and tablet, also assert:

```ts
expect(await gridColumnCount(page, ".diagnostics-actions")).toBe(1);
```

- [ ] **Step 4: Run the ATDD file and verify it fails for the missing feature**

Run:

```powershell
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npx.cmd' playwright test -c tests/e2e/playwright.config.ts tests/e2e/diagnostics.spec.ts --project=chromium
```

Expected: FAIL because `#diagnostics-recovered`, `#diagnostics-download`, and the other diagnostic controls do not exist. Confirm there is no fixture/setup syntax failure.

- [ ] **Step 5: Commit the red acceptance contract**

```powershell
git add tests/e2e/diagnostics.spec.ts tests/e2e/layout.spec.ts
git commit -m "test: define mobile diagnostics acceptance"
```

---

### Task 2: Build the strict schema and privacy sanitizer with unit TDD

**Files:**
- Create: `apps/demo/src/diagnostics/model.ts`
- Create: `apps/demo/src/diagnostics/sanitize.ts`
- Create: `apps/demo/src/diagnostics/sanitize.test.ts`

**Interfaces:**
- Produces: `DIAGNOSTIC_SCHEMA_VERSION`, `DIAGNOSTIC_EXPORT_VERSION`, `DIAGNOSTIC_STORE_KEY`, `DIAGNOSTIC_ACTIVE_KEY`, `DIAGNOSTIC_LIMITS`.
- Produces: `DiagnosticSession`, `DiagnosticCheckpoint`, `DiagnosticStore`, `ActiveSessionMarker`, `DiagnosticStorageState`.
- Produces: `migrateDiagnosticStore(value: unknown)` and `parseActiveMarker(value: unknown)`.
- Produces: `sanitizeCheckpointDetails(type, value)` and `sanitizeError(value, source)`.

- [ ] **Step 1: Write failing privacy and schema tests**

Create `apps/demo/src/diagnostics/sanitize.test.ts` with table-driven sentinel cases:

```ts
import { describe, expect, it } from "vitest";

import {
  DIAGNOSTIC_SCHEMA_VERSION,
  migrateDiagnosticStore,
  parseActiveMarker,
} from "./model";
import {
  sanitizeCheckpointDetails,
  sanitizeError,
  sanitizeSensitiveText,
} from "./sanitize";

describe("diagnostic privacy filtering", () => {
  it.each([
    ["audio name", "Could not decode secret-take.wav"],
    ["M4A name", "bad VOICE.M4A input"],
    ["Windows path", "C:\\Users\\private\\secret-take.wav"],
    ["POSIX path", "/home/private/secret-take.wav"],
    ["file URL", "file:///home/private/secret-take.wav"],
    ["Blob URL", "blob:https://example.test/private-id"],
  ])("redacts %s", (_label, input) => {
    const output = sanitizeSensitiveText(input);
    expect(output).not.toContain("secret-take");
    expect(output).not.toContain("private-id");
    expect(output.length).toBeLessThanOrEqual(512);
  });

  it("allows only approved error fields and never walks arbitrary data", () => {
    const samples = new Float32Array([0.123456, -0.654321]);
    const output = sanitizeError(
      {
        name: "DecodeError",
        message: "Could not decode C:\\private\\secret.wav",
        code: "DECODE_FAILED",
        stack: "SECRET_STACK",
        fileName: "secret.wav",
        samples,
        audioData: { channel: [0.123456] },
        details: {
          estimatedBytes: 123,
          limitBytes: 100,
          unknownSecret: "DO_NOT_PERSIST",
        },
        unknownSecret: "DO_NOT_PERSIST",
      },
      "decode",
    );
    const json = JSON.stringify(output);
    expect(output).toMatchObject({
      source: "decode",
      name: "DecodeError",
      code: "DECODE_FAILED",
      details: { estimatedBytes: 123, limitBytes: 100 },
    });
    for (const sentinel of [
      "SECRET_STACK",
      "secret.wav",
      "0.123456",
      "DO_NOT_PERSIST",
      "audioData",
      "samples",
      "fileName",
    ]) {
      expect(json).not.toContain(sentinel);
    }
  });

  it("drops unknown checkpoint fields and binary values", () => {
    const details = sanitizeCheckpointDetails("input", {
      slot: "a",
      mimeType: "audio/wav",
      encodedBytes: 2048,
      name: "private.wav",
      bytes: new Uint8Array([83, 69, 67, 82, 69, 84]),
      unknown: "SECRET",
    });
    expect(details).toEqual({
      slot: "a",
      mimeType: "audio/wav",
      encodedBytes: 2048,
    });
  });
});

describe("diagnostic schema migration boundary", () => {
  it("accepts schema v1 by reconstructing approved fields", () => {
    const result = migrateDiagnosticStore({
      schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
      sessions: [],
      unknown: "discard",
    });
    expect(result).toEqual({
      kind: "ok",
      store: { schemaVersion: 1, sessions: [] },
    });
  });

  it("distinguishes corrupted and unsupported schemas", () => {
    expect(migrateDiagnosticStore({ schemaVersion: 99, sessions: [] })).toEqual({
      kind: "unsupported",
    });
    expect(migrateDiagnosticStore({ schemaVersion: 1, sessions: "bad" })).toEqual({
      kind: "corrupt",
    });
  });

  it("rejects malformed active markers", () => {
    expect(parseActiveMarker({ schemaVersion: 1, sessionId: "../private.wav" }))
      .toBeNull();
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run test -w @takana-labs/convolve-demo -- src/diagnostics/sanitize.test.ts
```

Expected: FAIL because `model.ts` and `sanitize.ts` do not exist.

- [ ] **Step 3: Implement the schema constants and exact persisted types**

Create `apps/demo/src/diagnostics/model.ts` with these public constants and shapes:

```ts
export const DIAGNOSTIC_SCHEMA_VERSION = 1 as const;
export const DIAGNOSTIC_EXPORT_VERSION = 1 as const;
export const DIAGNOSTIC_STORE_KEY = "convolve-wasm:diagnostics:v1";
export const DIAGNOSTIC_ACTIVE_KEY =
  "convolve-wasm:diagnostics:active:v1";
export const DIAGNOSTIC_LIMITS = Object.freeze({
  retainedSessions: 6,
  sessionBytes: 32_768,
  checkpointsPerSession: 96,
});

export type DiagnosticStorageState =
  | "available"
  | "unavailable"
  | "quota-exceeded"
  | "recovered-corruption"
  | "unsupported-schema";
export type DiagnosticSessionStatus =
  | "active"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "clean-shutdown"
  | "unexpected-termination";
export type DiagnosticScalar = string | number | boolean | null;
export type DiagnosticDetails = Record<string, DiagnosticScalar>;

export interface DiagnosticCheckpoint {
  sequence: number;
  type: DiagnosticCheckpointType;
  timestamp: string;
  elapsedMs: number;
  details: DiagnosticDetails;
}


export interface DiagnosticCapabilities {
  webAssembly: boolean;
  worker: boolean;
  offlineAudioContext: boolean;
  readableStream: boolean;
  responseBlob: boolean;
  randomUUID: boolean;
  localStorage: boolean;
  clipboard: boolean;
}

export interface DiagnosticEnvironment {
  userAgent: string;
  platform: string;
  deviceMemoryGiB: number | null;
  hardwareConcurrency: number | null;
  capabilities: DiagnosticCapabilities;
}
export interface DiagnosticSession {
  schemaVersion: 1;
  id: string;
  startedAt: string;
  updatedAt: string;
  status: DiagnosticSessionStatus;
  app: { version: string; buildCommit: string };
  environment: DiagnosticEnvironment | null;
  checkpoints: DiagnosticCheckpoint[];
  droppedCheckpoints: number;
  inference?: {
    kind: "unexpected-termination";
    inferredAt: string;
    markerOnly: boolean;
    statement: string;
  };
}

export interface DiagnosticStore {
  schemaVersion: 1;
  sessions: DiagnosticSession[];
}

export interface ActiveSessionMarker {
  schemaVersion: 1;
  sessionId: string;
  startedAt: string;
  updatedAt: string;
  lastCheckpointSequence: number;
  appVersion: string;
  buildCommit: string;
}
```

Define the checkpoint union explicitly; do not use arbitrary strings:

```ts
export type DiagnosticCheckpointType =
  | "session-start"
  | "input"
  | "options"
  | "decode-start"
  | "decode-success"
  | "decode-failure"
  | "memory-plan"
  | "worker-created"
  | "wasm-init-start"
  | "wasm-init-success"
  | "wasm-init-failure"
  | "progress-stage"
  | "output-start"
  | "output-milestone"
  | "blob-complete"
  | "preview-assigned"
  | "success"
  | "error"
  | "worker-error"
  | "worker-messageerror"
  | "cancelled"
  | "visibility"
  | "pagehide"
  | "clean-shutdown"
  | "unexpected-termination"
  | "audio-error";
```

Implement `migrateDiagnosticStore` and `parseActiveMarker` as field-by-field validators. They may inspect only scalar/array shape; they must reconstruct returned objects and drop unknown keys. Schema versions other than `1` return `{ kind: "unsupported" }`; malformed v1 returns `{ kind: "corrupt" }`.

- [ ] **Step 4: Implement bounded redaction and checkpoint allowlists**

Create `apps/demo/src/diagnostics/sanitize.ts`. Use separate bounded sanitizers for trusted browser metadata and sensitive error text:

```ts
const MAX_ERROR_TEXT = 512;
const MAX_SHORT_TEXT = 120;
const AUDIO_NAME = /\b[^\s"'<>\\/]+\.(?:wav|m4a)\b/giu;
const BLOB_URL = /\bblob:[^\s"'<>]+/giu;
const FILE_URL = /\bfile:\/\/[^\s"'<>]+/giu;
const WINDOWS_PATH = /\b[A-Za-z]:\\[^\s"'<>]*/gu;
const POSIX_PATH = /(^|[\s("'=])\/(?:[^/\s"'<>]+\/)+[^/\s"'<>]*/gu;

export function sanitizeSensitiveText(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  return text
    .replace(BLOB_URL, "[redacted-blob-url]")
    .replace(FILE_URL, "[redacted-file-url]")
    .replace(WINDOWS_PATH, "[redacted-path]")
    .replace(POSIX_PATH, "$1[redacted-path]")
    .replace(AUDIO_NAME, "[redacted-audio-name]")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_ERROR_TEXT);
}
```

Implement a `switch` in `sanitizeCheckpointDetails` for every checkpoint type. Each branch constructs an object using helpers that admit only finite numbers, booleans, bounded enum values, valid MIME syntax, and safe short strings. Never use object spread, recursive traversal, `JSON.stringify(value)`, or a generic copy loop on untrusted details.

Implement `sanitizeError` with the approved source/name/code/message/line/column fields and only these detail keys:

```ts
const ERROR_DETAIL_KEYS = [
  "estimatedBytes",
  "limitBytes",
  "aFrames",
  "bFrames",
  "outputFrames",
  "finalFrames",
  "fftFrames",
  "appendReverse",
  "reverseCrossfadeFrames",
  "beatPan",
  "deviceMemoryGiB",
] as const;
```

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run:

```powershell
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run test -w @takana-labs/convolve-demo -- src/diagnostics/sanitize.test.ts
```

Expected: PASS with all privacy and schema cases green.

- [ ] **Step 6: Commit the schema and privacy boundary**

```powershell
git add apps/demo/src/diagnostics/model.ts apps/demo/src/diagnostics/sanitize.ts apps/demo/src/diagnostics/sanitize.test.ts
git commit -m "feat: define private diagnostic schema"
```

---

### Task 3: Implement the bounded recorder and recovery state machine with unit TDD

**Files:**
- Create: `apps/demo/src/diagnostics/recorder.ts`
- Create: `apps/demo/src/diagnostics/recorder.test.ts`

**Interfaces:**
- Consumes: model and sanitizer APIs from Task 2.
- Produces: `DiagnosticRecorder`, `RecorderDependencies`, `DiagnosticSnapshot`, `DiagnosticExport`.
- Produces: `startSession`, `checkpoint`, `recordProgress`, `finish`, `recordIncident`, `exportJson`, `clear`, `subscribe`, `snapshot`.

- [ ] **Step 1: Write the fake storage and failing bounded-ring tests**

Create `apps/demo/src/diagnostics/recorder.test.ts` with a `FakeStorage` that implements `getItem`, `setItem`, and `removeItem`, records operation order, and can throw a configurable `SecurityError` or `QuotaExceededError`.

Add tests that:

```ts
it("writes the retained session before its active marker", () => {
  const storage = new FakeStorage();
  const recorder = makeRecorder(storage);
  recorder.startSession(startInput());
  expect(storage.operations.slice(-2)).toEqual([
    `set:${DIAGNOSTIC_STORE_KEY}`,
    `set:${DIAGNOSTIC_ACTIVE_KEY}`,
  ]);
});

it("rotates deterministically to six newest sessions", () => {
  const storage = new FakeStorage();
  const recorder = makeRecorder(storage);
  for (let index = 0; index < 8; index += 1) {
    recorder.startSession(startInput(`session-${index}`));
    recorder.finish("succeeded", "success", { outputFrames: index + 1 });
  }
  expect(recorder.snapshot().sessions.map((session) => session.id)).toEqual([
    "session-2",
    "session-3",
    "session-4",
    "session-5",
    "session-6",
    "session-7",
  ]);
});

it("bounds checkpoints and serialized session bytes", () => {
  const recorder = makeRecorder(new FakeStorage());
  recorder.startSession(startInput("bounded"));
  for (let index = 0; index < 200; index += 1) {
    recorder.checkpoint("error", {
      source: "processing",
      message: `message-${index}-${"x".repeat(500)}`,
    });
  }
  const [session] = recorder.snapshot().sessions;
  expect(session.checkpoints.length).toBeLessThanOrEqual(96);
  expect(new TextEncoder().encode(JSON.stringify(session)).byteLength)
    .toBeLessThanOrEqual(32_768);
  expect(session.checkpoints[0]?.type).toBe("session-start");
  expect(session.checkpoints.at(-1)?.details.message).toContain("message-199");
  expect(session.droppedCheckpoints).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Add failing corruption, quota, and disabled-storage cases**

Cover all required storage behavior:

```ts
it.each([
  ["corrupt JSON", "{not-json", "recovered-corruption"],
  [
    "invalid v1",
    JSON.stringify({ schemaVersion: 1, sessions: "bad" }),
    "recovered-corruption",
  ],
  [
    "unsupported schema",
    JSON.stringify({ schemaVersion: 99, sessions: [] }),
    "unsupported-schema",
  ],
])("recovers %s deterministically", (_label, raw, expectedState) => {
  const storage = new FakeStorage({ [DIAGNOSTIC_STORE_KEY]: raw });
  const recorder = makeRecorder(storage);
  expect(recorder.snapshot().storageState).toBe(expectedState);
  expect(recorder.snapshot().sessions).toEqual([]);
});

it("falls back to current-tab memory when storage access is disabled", () => {
  const recorder = makeRecorder(() => {
    throw new DOMException("disabled", "SecurityError");
  });
  expect(() => recorder.startSession(startInput("memory-only"))).not.toThrow();
  expect(recorder.snapshot().storageState).toBe("unavailable");
  expect(recorder.snapshot().sessions).toHaveLength(1);
});

it("prunes its own oldest sessions before reporting quota exhaustion", () => {
  const storage = quotaStorageWithExistingSessions(3);
  const recorder = makeRecorder(storage);
  recorder.startSession(startInput("newest"));
  expect(storage.removedUnrelatedKeys).toEqual([]);
  expect(recorder.snapshot().sessions.at(-1)?.id).toBe("newest");
});
```

- [ ] **Step 3: Add failing recovery, marker-only, terminal, and coalescing cases**

Test the state machine exactly:

```ts
it("infers unexpected termination only for a nonterminal active marker", () => {
  const storage = seedActiveSession({ status: "active", terminal: false });
  const recorder = makeRecorder(storage);
  expect(recorder.snapshot().recoveredSessionId).toBe("unfinished");
  expect(recorder.snapshot().sessions[0]).toMatchObject({
    status: "unexpected-termination",
    inference: {
      kind: "unexpected-termination",
      markerOnly: false,
    },
  });
  expect(storage.getItem(DIAGNOSTIC_ACTIVE_KEY)).toBeNull();
});

it.each(["succeeded", "failed", "cancelled", "clean-shutdown"] as const)(
  "does not infer termination after %s",
  (status) => {
    const recorder = makeRecorder(seedActiveSession({ status, terminal: true }));
    expect(recorder.snapshot().sessions[0]?.status).toBe(status);
    expect(recorder.snapshot().recoveredSessionId).toBeNull();
  },
);

it("creates an explicitly limited marker-only inference after ring corruption", () => {
  const recorder = makeRecorder(seedMarkerWithCorruptRing());
  expect(recorder.snapshot().sessions[0]).toMatchObject({
    status: "unexpected-termination",
    inference: { markerOnly: true },
  });
});

it("coalesces repeated progress fractions to one persisted stage transition", () => {
  const storage = new FakeStorage();
  const recorder = makeRecorder(storage);
  recorder.startSession(startInput("progress"));
  recorder.recordProgress({ stage: "convolve", fraction: 0.3 });
  recorder.recordProgress({ stage: "convolve", fraction: 0.4 });
  recorder.recordProgress({ stage: "convolve", fraction: 0.9 });
  recorder.recordProgress({ stage: "normalize", fraction: 0.95 });
  const progress = recorder.snapshot().sessions[0]?.checkpoints.filter(
    (checkpoint) => checkpoint.type === "progress-stage",
  );
  expect(progress?.map((checkpoint) => checkpoint.details.stage)).toEqual([
    "convolve",
    "normalize",
  ]);
});
```

- [ ] **Step 4: Add failing export, clear, and no-throw continuation cases**

Assert:

```ts
it("exports only validated schema-v1 data in a stable formatted envelope", () => {
  const recorder = makeRecorder(new FakeStorage());
  recorder.startSession(startInput("exported"));
  recorder.finish("succeeded", "success", { outputFrames: 42 });
  const json = recorder.exportJson();
  expect(json.endsWith("\n")).toBe(true);
  expect(JSON.parse(json)).toMatchObject({
    exportFormat: "convolve-wasm-diagnostics",
    exportVersion: 1,
    privacy: {
      audioDataRecorded: false,
      fileNamesRecorded: false,
      automaticUpload: false,
    },
    limits: {
      retainedSessions: 6,
      sessionBytes: 32768,
      checkpointsPerSession: 96,
    },
    sessions: [expect.objectContaining({ id: "exported", status: "succeeded" })],
  });
});

it("clears only recorder keys", () => {
  const storage = new FakeStorage({ unrelated: "keep" });
  const recorder = makeRecorder(storage);
  recorder.startSession(startInput("clear"));
  recorder.clear();
  expect(storage.getItem(DIAGNOSTIC_STORE_KEY)).toBeNull();
  expect(storage.getItem(DIAGNOSTIC_ACTIVE_KEY)).toBeNull();
  expect(storage.getItem("unrelated")).toBe("keep");
});

it("allows a subsequent successful operation after every diagnostic write fails", () => {
  const recorder = makeRecorder(alwaysThrowingStorage());
  expect(() => {
    recorder.startSession(startInput("failure-isolated"));
    recorder.checkpoint("worker-created", {});
    recorder.finish("succeeded", "success", { outputFrames: 1 });
  }).not.toThrow();
  expect(recorder.snapshot().sessions.at(-1)?.status).toBe("succeeded");
});
```

- [ ] **Step 5: Run the recorder tests and verify RED**

Run:

```powershell
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run test -w @takana-labs/convolve-demo -- src/diagnostics/recorder.test.ts
```

Expected: FAIL because `recorder.ts` does not exist.

- [ ] **Step 6: Implement the recorder with deterministic write ordering**

Create `apps/demo/src/diagnostics/recorder.ts` around this exact public surface:

```ts
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface DiagnosticSnapshot {
  storageState: DiagnosticStorageState;
  sessions: readonly DiagnosticSession[];
  activeSessionId: string | null;
  recoveredSessionId: string | null;
}

export interface DiagnosticExport {
  exportFormat: "convolve-wasm-diagnostics";
  exportVersion: 1;
  generatedAt: string;
  notice: string;
  privacy: {
    audioDataRecorded: false;
    fileNamesRecorded: false;
    automaticUpload: false;
  };
  limits: {
    retainedSessions: 6;
    sessionBytes: 32_768;
    checkpointsPerSession: 96;
  };
  storageState: DiagnosticStorageState;
  sessions: DiagnosticSession[];
}
export interface RecorderDependencies {
  getStorage(): StorageLike | null;
  now(): Date;
  monotonicNow(): number;
  id(): string;
  defer(task: () => void): void;
}

export interface StartSessionInput {
  id?: string;
  app: { version: string; buildCommit: string };
  environment: DiagnosticEnvironment;
  inputs: Array<{ slot: "a" | "b"; mimeType: string; encodedBytes: number }>;
  options: {
    appendReverse: boolean;
    beatPan: "a" | "b" | null;
    panTransitionMs: number;
    reverseCrossfadeMs: number;
    targetDbtp: number;
  };
}

export class DiagnosticRecorder {
  startSession(input: StartSessionInput): string;
  checkpoint(type: DiagnosticCheckpointType, details?: unknown): void;
  recordProgress(event: ConvolveProgress): void;
  finish(
    status: Exclude<DiagnosticSessionStatus, "active" | "unexpected-termination">,
    type: DiagnosticCheckpointType,
    details?: unknown,
  ): void;
  recordIncident(type: DiagnosticCheckpointType, details: unknown): void;
  snapshot(): DiagnosticSnapshot;
  subscribe(listener: (snapshot: DiagnosticSnapshot) => void): () => void;
  exportJson(): string;
  clear(): void;
}
```

Implementation rules:

1. Load and validate storage in the constructor.
2. Recover a valid active marker before exposing the first snapshot.
3. Write the ring before the marker at session start and each active checkpoint.
4. Persist terminal session before removing the marker.
5. Use `TextEncoder` for the exact 32,768-byte bound.
6. Drop the oldest non-anchor checkpoint until both count and byte bounds pass.
7. Sort retention by `startedAt`, then `id`; remove oldest terminal sessions first.
8. On quota error, prune one owned terminal session and retry until no more can be pruned; then keep current-tab memory and set `quota-exceeded`.
9. Coalesce progress by last stage; never persist repeated same-stage fractions.
10. Catch storage getters, reads, writes, parses, removes, listeners, and deferred notifications.
11. Export `JSON.stringify(envelope, null, 2) + "\n"` from the validated in-memory model.

- [ ] **Step 7: Run recorder and sanitizer tests and verify GREEN**

Run:

```powershell
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run test -w @takana-labs/convolve-demo -- src/diagnostics/sanitize.test.ts src/diagnostics/recorder.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit the local bounded recorder**

```powershell
git add apps/demo/src/diagnostics/recorder.ts apps/demo/src/diagnostics/recorder.test.ts
git commit -m "feat: persist bounded crash checkpoints"
```

---

### Task 4: Add private package lifecycle events with no public API change

**Files:**
- Create: `packages/convolve-wasm/src/diagnostics.ts`
- Create: `packages/convolve-wasm/src/diagnostics.test.ts`
- Modify: `packages/convolve-wasm/src/decode.ts`
- Modify: `packages/convolve-wasm/src/decode.test.ts`
- Modify: `packages/convolve-wasm/src/convolver.ts`
- Modify: `packages/convolve-wasm/src/index.test.ts`
- Modify: `packages/convolve-wasm/src/worker-protocol.ts`
- Modify: `packages/convolve-wasm/src/worker-runtime.ts`
- Modify: `packages/convolve-wasm/src/worker-runtime.test.ts`
- Modify: `packages/convolve-wasm/src/worker-client.ts`
- Modify: `packages/convolve-wasm/src/worker-client.test.ts`
- Modify: `packages/convolve-wasm/src/index.ts`

**Interfaces:**
- Produces internally: `CONVOLVE_DIAGNOSTIC_EVENT`, `ConvolveDiagnosticEvent`, `DiagnosticObserver`, `notifyDiagnostic`.
- `CONVOLVE()` and every exported type remain unchanged.
- Worker protocol adds only `{ type: "diagnostic"; id; event: WorkerDiagnosticEvent }`.

- [ ] **Step 1: Write failing emitter isolation and redaction tests**

Create `packages/convolve-wasm/src/diagnostics.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import {
  notifyDiagnostic,
  safeDiagnosticError,
  type ConvolveDiagnosticEvent,
} from "./diagnostics";

describe("private diagnostic events", () => {
  it("cannot let a throwing observer affect its caller", () => {
    const observer = vi.fn(() => {
      throw new Error("observer failure");
    });
    expect(() =>
      notifyDiagnostic(observer, { type: "worker-created" }),
    ).not.toThrow();
    expect(observer).toHaveBeenCalledOnce();
  });

  it("redacts names, paths, Blob URLs, stacks, and unknown fields", () => {
    const value = safeDiagnosticError({
      name: "Error",
      message: "failed C:\\private\\take.wav blob:https://example.test/id",
      stack: "SECRET_STACK",
      fileName: "take.wav",
      unknown: "SECRET_UNKNOWN",
      details: { estimatedBytes: 123, unknown: "SECRET_DETAIL" },
    });
    const json = JSON.stringify(value);
    expect(value).toMatchObject({
      name: "Error",
      details: { estimatedBytes: 123 },
    });
    for (const secret of [
      "take.wav",
      "private",
      "https://example.test/id",
      "SECRET_STACK",
      "SECRET_UNKNOWN",
      "SECRET_DETAIL",
    ]) expect(json).not.toContain(secret);
  });

  it("uses only the private event union", () => {
    const event: ConvolveDiagnosticEvent = {
      type: "memory-plan",
      estimatedBytes: 10,
      limitBytes: 20,
      aFrames: 1,
      bFrames: 1,
      outputFrames: 1,
      finalFrames: 1,
      fftFrames: 1,
      appendReverse: false,
      reverseCrossfadeFrames: 240,
      beatPan: null,
      deviceMemoryGiB: 4,
      admitted: true,
    };
    expect(event.type).toBe("memory-plan");
  });
});
```

- [ ] **Step 2: Add failing decode and convolver lifecycle assertions**

Extend `decode.test.ts` to pass a diagnostic observer into `decodeInputPair` and expect:

```ts
expect(diagnostics).toEqual([
  {
    type: "decode-start",
    slot: "a",
    mimeType: "audio/wav",
    encodedBytes: 1,
  },
  {
    type: "decode-success",
    slot: "a",
    sampleRate: 48_000,
    channels: 2,
    frames: 1,
  },
  {
    type: "decode-start",
    slot: "b",
    mimeType: "audio/mp4",
    encodedBytes: 2,
  },
  {
    type: "decode-success",
    slot: "b",
    sampleRate: 48_000,
    channels: 2,
    frames: 1,
  },
]);
expect(JSON.stringify(diagnostics)).not.toContain("private-a.wav");
```

Add a decode rejection test that expects a sanitized `decode-failure` event and preserves the original rejection object.

Extend `index.test.ts` to inject a `diagnostics` observer into `createConvolver` and expect an `options` event, exact `memory-plan` event, and `request-success` or `request-failure`. Keep the existing `expectTypeOf(CONVOLVE)` assertion unchanged.

- [ ] **Step 3: Add failing worker/runtime event tests**

In `worker-runtime.test.ts`, expect this order around the existing load:

```ts
expect(posts.slice(0, 3).map(({ response }) => response)).toEqual([
  {
    type: "progress",
    id: "one",
    event: { stage: "load-wasm", fraction: 0.25 },
  },
  {
    type: "diagnostic",
    id: "one",
    event: { type: "wasm-init-start" },
  },
  {
    type: "diagnostic",
    id: "one",
    event: { type: "wasm-init-success" },
  },
]);
```

For rejected `loadWasm`, expect `wasm-init-failure` with a sanitized message before the unchanged `WASM_INIT_FAILED` response.

In `worker-client.test.ts`:

- extend `FakeWorker` with `messageerrorListeners` and `emitMessageError()`;
- assert `worker-created`, `worker-error`, and `worker-messageerror`;
- assert a messageerror rejects pending work but a subsequent worker succeeds;
- stream at least four chunks and assert only 25/50/75 aggregate milestones;
- assert `blob-complete` contains final aggregate `chunkCount`, `pcmBytes`, and `wavBytes`;
- make the diagnostic observer throw and assert the result Blob and metadata still resolve unchanged.

- [ ] **Step 4: Run focused package tests and verify RED**

Run:

```powershell
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run test -w @takana-labs/convolve-wasm -- src/diagnostics.test.ts src/decode.test.ts src/index.test.ts src/worker-client.test.ts src/worker-runtime.test.ts
```

Expected: FAIL for missing diagnostic interfaces and events, while pre-existing assertions continue to compile.

- [ ] **Step 5: Implement the private no-throw event bridge**

Create `packages/convolve-wasm/src/diagnostics.ts` with:

```ts
export const CONVOLVE_DIAGNOSTIC_EVENT =
  "convolve-wasm:diagnostic" as const;
export type DiagnosticObserver = (event: ConvolveDiagnosticEvent) => void;

export function notifyDiagnostic(
  observer: DiagnosticObserver | undefined,
  event: ConvolveDiagnosticEvent,
): void {
  try {
    observer?.(event);
  } catch {
    // Diagnostics are never part of processing success or failure.
  }
}

export const emitBrowserDiagnostic: DiagnosticObserver = (event) => {
  try {
    if (
      typeof globalThis.dispatchEvent !== "function" ||
      typeof CustomEvent !== "function"
    ) return;
    globalThis.dispatchEvent(
      new CustomEvent(CONVOLVE_DIAGNOSTIC_EVENT, { detail: event }),
    );
  } catch {
    // A browser observer or unavailable event API cannot affect CONVOLVE().
  }
};
```

Define the safe error and event union exactly:

```ts
export interface SafeDiagnosticError {
  name?: string;
  code?: string;
  message: string;
  lineNumber?: number;
  columnNumber?: number;
  details?: Record<string, string | number | boolean | null>;
}

export type ConvolveDiagnosticEvent =
  | {
      type: "decode-start";
      slot: "a" | "b";
      mimeType: string;
      encodedBytes: number;
    }
  | {
      type: "decode-success";
      slot: "a" | "b";
      sampleRate: 48_000;
      channels: 2;
      frames: number;
    }
  | { type: "decode-failure"; slot: "a" | "b"; error: SafeDiagnosticError }
  | {
      type: "options";
      appendReverse: boolean;
      beatPan: "a" | "b" | null;
      panTransitionMs: number;
      reverseCrossfadeMs: number;
      targetDbtp: number;
    }
  | {
      type: "memory-plan";
      estimatedBytes: number;
      limitBytes: number;
      aFrames: number;
      bFrames: number;
      outputFrames: number;
      finalFrames: number;
      fftFrames: number;
      appendReverse: boolean;
      reverseCrossfadeFrames: number;
      beatPan: "a" | "b" | null;
      deviceMemoryGiB: number | null;
      admitted: boolean;
    }
  | { type: "request-success"; outputFrames: number; durationSeconds: number }
  | { type: "request-failure"; error: SafeDiagnosticError }
  | { type: "worker-created" }
  | { type: "worker-error"; error: SafeDiagnosticError }
  | { type: "worker-messageerror"; error: SafeDiagnosticError }
  | { type: "worker-cancelled" }
  | { type: "wasm-init-start" }
  | { type: "wasm-init-success" }
  | { type: "wasm-init-failure"; error: SafeDiagnosticError }
  | { type: "output-start"; outputFrames: number }
  | {
      type: "output-milestone";
      fraction: 0.25 | 0.5 | 0.75;
      chunkCount: number;
      pcmBytes: number;
    }
  | {
      type: "blob-complete";
      chunkCount: number;
      pcmBytes: number;
      wavBytes: number;
    };
```

Implement `safeDiagnosticError` with the same privacy boundary as Task 2,
independently so package events are safe before they reach the demo.

- [ ] **Step 6: Instrument decode and memory admission without changing behavior**

Update `decodeInputPair` to accept an optional final `DiagnosticObserver`.
Wrap each existing `backend.decode(file)` with start/success/failure
notifications. Re-throw the exact original failure.

Add `diagnostics?: DiagnosticObserver` to `ConvolverDependencies`. Emit:

1. normalized approved options;
2. exact memory-plan numbers and decision after decode;
3. request success metadata or sanitized failure.

Do not change call order, memory formulas, worker admission, queue
serialization, or returned/rejected values.

- [ ] **Step 7: Instrument worker/WASM/output boundaries**

Add this private worker event union:

```ts
export type WorkerDiagnosticEvent =
  | { type: "wasm-init-start" }
  | { type: "wasm-init-success" }
  | { type: "wasm-init-failure"; error: SafeDiagnosticError };
```

The worker runtime posts diagnostic messages through a `reportDiagnostic`
helper that catches `postMessage` failures. Existing progress and terminal
messages remain unchanged.

Extend `WorkerLike.addEventListener` with `"messageerror"`. In `WorkerClient`,
store `chunkCount`, `pcmBytes`, and `nextMilestone` in `OutputAssembly`. After
each validated chunk, update counters and emit at thresholds `0.25`, `0.5`,
and `0.75`; never emit per chunk. After `Response.blob()` resolves, emit one
`blob-complete` event before resolving the original result.

- [ ] **Step 8: Wire the private emitter and prove public declarations are unchanged**

In `index.ts`, create one observer reference:

```ts
const diagnostics = emitBrowserDiagnostic;
const convolve = createConvolver({
  getDecodeBackend: getDefaultDecodeBackend,
  diagnostics,
  workerClient: new WorkerClient(undefined, diagnostics),
});
```

Do not export anything from `diagnostics.ts`. Keep `tsconfig.build.json`
declaration entry points unchanged.

- [ ] **Step 9: Run focused and complete package tests and verify GREEN**

Run:

```powershell
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run test -w @takana-labs/convolve-wasm -- src/diagnostics.test.ts src/decode.test.ts src/index.test.ts src/worker-client.test.ts src/worker-runtime.test.ts
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run test -w @takana-labs/convolve-wasm
```

Expected: PASS. Confirm the public-signature type test still passes.

- [ ] **Step 10: Commit the lifecycle bridge**

```powershell
git add packages/convolve-wasm/src
git commit -m "feat: expose private processing checkpoints"
```

---

### Task 5: Integrate browser capture and the dark Diagnostics UI

**Files:**
- Create: `apps/demo/src/diagnostics/browser.ts`
- Create: `apps/demo/src/diagnostics/browser.test.ts`
- Modify: `apps/demo/src/main.ts`
- Modify: `apps/demo/index.html`
- Modify: `apps/demo/src/styles.css`
- Modify: `apps/demo/vite.config.ts`

**Interfaces:**
- Consumes: `DiagnosticRecorder` and package event name `convolve-wasm:diagnostic`.
- Produces: `createBrowserDiagnostics`, `startAttempt`, `recordProgress`, `finishSuccess`, `finishFailure`, `previewAssigned`, and `showFailureAction`.
- Produces the UI IDs established by Task 1.

- [ ] **Step 1: Write failing browser mapping and incident tests**

Create `apps/demo/src/diagnostics/browser.test.ts` using a fake recorder and
`EventTarget`. Cover:

```ts
it.each([
  ["worker-error", "worker-error"],
  ["worker-messageerror", "worker-messageerror"],
  ["wasm-init-failure", "wasm-init-failure"],
])("maps %s package events to approved %s checkpoints", (eventType, checkpoint) => {
  const recorder = fakeRecorder();
  const diagnostics = createBrowserDiagnostics(browserDependencies(recorder));
  diagnostics.handlePackageEvent({ type: eventType, unknownSecret: "DROP" });
  expect(recorder.checkpoint).toHaveBeenCalledWith(
    checkpoint,
    expect.not.objectContaining({ unknownSecret: expect.anything() }),
  );
});

it("captures window and promise errors without preventing defaults", () => {
  const recorder = fakeRecorder();
  const diagnostics = createBrowserDiagnostics(browserDependencies(recorder));
  diagnostics.handleWindowError({
    message: "C:\\private\\secret.wav failed",
    lineno: 9,
    colno: 2,
    error: { stack: "DROP_STACK" },
  });
  diagnostics.handleUnhandledRejection({
    reason: { message: "/private/secret.wav", unknown: "DROP" },
  });
  expect(recorder.recordIncident).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(recorder.recordIncident.mock.calls)).not.toContain(
    "secret.wav",
  );
});

it("swallows recorder, clipboard, URL, and download failures", async () => {
  const diagnostics = createBrowserDiagnostics(allThrowingDependencies());
  expect(() => diagnostics.startAttempt(validAttempt())).not.toThrow();
  await expect(diagnostics.copy()).resolves.toBe(false);
  expect(() => diagnostics.download()).not.toThrow();
});
```

- [ ] **Step 2: Run browser unit tests and verify RED**

Run:

```powershell
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run test -w @takana-labs/convolve-demo -- src/diagnostics/browser.test.ts
```

Expected: FAIL because `browser.ts` does not exist.

- [ ] **Step 3: Add application version metadata and Diagnostics markup**

In `vite.config.ts`, read `apps/demo/package.json` and replace
`%APP_VERSION%` in `transformIndexHtml`, alongside the existing `%BUILD_SHA%`.

Add this meta element:

```html
<meta name="convolve-version" content="%APP_VERSION%" />
```

Add the compact section after `.result-panel`:

```html
<section id="diagnostics" class="diagnostics-panel" aria-labelledby="diagnostics-heading">
  <div class="section-heading">
    <p class="step">Diagnostics</p>
    <div>
      <h2 id="diagnostics-heading">Local crash diagnostics</h2>
      <p>
        No audio data, samples, filenames, or paths are recorded. Nothing is
        uploaded; records stay in this browser until you export or clear them.
      </p>
    </div>
  </div>
  <p id="diagnostics-storage" class="diagnostics-storage" role="status"></p>
  <div id="diagnostics-recovered" class="diagnostics-recovered" hidden>
    A previous session ended without a normal completion marker. This is an
    unexpected-termination inference; it does not prove an out-of-memory event
    or identify Chrome's exact reason.
  </div>
  <p id="diagnostics-summary" class="diagnostics-summary">
    No retained diagnostic sessions.
  </p>
  <div class="diagnostics-actions">
    <button id="diagnostics-download" type="button">Download diagnostics</button>
    <button id="diagnostics-copy" type="button" hidden>Copy diagnostics</button>
    <button id="diagnostics-clear" type="button">Clear diagnostics</button>
  </div>
  <details class="diagnostics-help">
    <summary>Collect an Android crash report</summary>
    <ol>
      <li>Run the files and options that previously reloaded or closed the tab.</li>
      <li>Reopen this page immediately after Chrome reloads or terminates it.</li>
      <li>Download or copy the recovered record before clearing or retrying.</li>
    </ol>
    <p>
      JavaScript cannot record the exact instant or system reason Chrome kills
      a renderer.
    </p>
  </details>
</section>
```

Add beside the existing structured status:

```html
<button id="failure-diagnostics-download" type="button" hidden>
  Download diagnostics
</button>
```

- [ ] **Step 4: Implement the browser controller and UI rendering**

Create `browser.ts` with:

```ts
export interface BrowserAttemptInput {
  inputs: Array<{
    slot: "a" | "b";
    mimeType: string;
    encodedBytes: number;
  }>;
  options: {
    appendReverse: boolean;
    beatPan: "a" | "b" | null;
    panTransitionMs: number;
    reverseCrossfadeMs: number;
    targetDbtp: number;
  };
}

export interface BrowserDiagnostics {
  startAttempt(input: BrowserAttemptInput): void;
  recordProgress(event: ConvolveProgress): void;
  previewAssigned(wavBytes: number): void;
  finishSuccess(metadata: ConvolveMetadata): void;
  finishFailure(error: unknown): void;
  download(): void;
  copy(): Promise<boolean>;
  clear(): void;
  showFailureAction(visible: boolean): void;
  handlePackageEvent(value: unknown): void;
  dispose(): void;
}
```

Implementation requirements:

- obtain version/build only from the two bounded meta values;
- capture UA, platform, finite device memory/hardware concurrency, and boolean
  capabilities field by field;
- access `window.localStorage` through a throwing getter passed to the recorder;
- listen to `convolve-wasm:diagnostic`, but pass its unknown `detail` through
  a switch that recognizes only approved event types;
- attach `window.error`, `unhandledrejection`, `visibilitychange`, `pagehide`,
  and preview `error` listeners without preventing defaults;
- record every `pagehide`; keep a persisted back-forward-cache page active and
  close non-persisted pagehide as `clean-shutdown`;
- render storage state, retained count, recovery notice, and latest summary;
- show copy only when `navigator.clipboard.writeText` is a function;
- generate download and copy from the exact same `recorder.exportJson()`;
- create a JSON Blob, activate a temporary anchor, and revoke its Blob URL in a
  deferred callback without recording the URL;
- confirm clear with:
  `Clear all crash diagnostics stored by convolve-wasm on this device?`;
- catch every recorder, clipboard, Blob URL, DOM, and listener failure.

- [ ] **Step 5: Integrate attempts without changing current processing behavior**

In `main.ts`:

1. Instantiate browser diagnostics after the existing required elements.
2. On each run click, compute the same options once, call `startAttempt`, then
   preserve the existing validation/status/reset sequence.
3. In the existing `onProgress`, call `diagnostics.recordProgress(event)`
   before formatting the unchanged status.
4. After the final Blob URL and preview are assigned, call
   `diagnostics.previewAssigned(result.wav.size)`.
5. After unchanged metadata/status rendering, call `finishSuccess`.
6. In both typed and untyped catch branches, call `finishFailure(error)` and
   reveal the failure-side download action.
7. Hide the failure action at the next attempt and after success.
8. Keep `beforeunload` URL revocation unchanged. Do not dispose diagnostics
   during unload; the `pagehide` listener must remain installed through shutdown.

- [ ] **Step 6: Add responsive dark styling**

Extend the existing panel selector so `.diagnostics-panel` uses the same dark
stone boundary. Add styles for:

```css
.diagnostics-panel {
  position: relative;
  margin-top: 18px;
  padding: clamp(22px, 4vw, 32px);
}

.diagnostics-storage,
.diagnostics-summary,
.diagnostics-recovered,
.diagnostics-help {
  position: relative;
  z-index: 1;
}

.diagnostics-recovered {
  border: 1px solid rgb(196 155 115 / 30%);
  border-radius: 12px;
  padding: 14px;
  background: rgb(196 155 115 / 8%);
  color: #d8bea4;
}

.diagnostics-actions {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.diagnostics-actions button,
#failure-diagnostics-download {
  min-height: 44px;
}
```

At `max-width: 760px`, set `.diagnostics-actions` to one column and full-width
buttons. Preserve the existing dark-only color scheme and all current controls.

- [ ] **Step 7: Run unit tests and verify GREEN**

Run:

```powershell
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run test -w @takana-labs/convolve-demo
```

Expected: PASS.

- [ ] **Step 8: Run the ATDD recovery file and make it GREEN**

Use project lifecycle automation for browser work:

```powershell
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run app:doctor
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run app:status
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run app:start:hidden
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run app:ready
$env:CONVOLVE_REUSE_SERVER = '1'
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npx.cmd' playwright test -c tests/e2e/playwright.config.ts tests/e2e/diagnostics.spec.ts --project=chromium
Remove-Item Env:CONVOLVE_REUSE_SERVER
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run app:logs -- --tail 100
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run app:stop
```

Expected: all diagnostics acceptance cases PASS and lifecycle logs contain no
page or application errors. If Playwright cannot reuse the lifecycle server,
stop it and run the same Playwright file through its configured project-owned
webServer; do not launch an ad hoc server.

- [ ] **Step 9: Run complete Chromium/WebKit output and layout regression**

Run:

```powershell
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run test:e2e
```

Expected: PASS in Chromium and WebKit, including unchanged metadata and all
existing browser-specific WAV SHA-256 values, diagnostics recovery/export,
responsive containment, and zero page/console errors.

- [ ] **Step 10: Commit browser integration**

```powershell
git add apps/demo tests/e2e
git commit -m "feat: add local crash diagnostics UI"
```

---

### Task 6: Document collection, inference, and debugging limits

**Files:**
- Create: `docs/mobile-crash-diagnostics.md`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/browser-support.md`
- Modify: `tests/release-012.test.mjs`

**Interfaces:**
- Produces: one canonical user/operator guide linked from repository entry points.

- [ ] **Step 1: Add a failing documentation contract test**

Create a new case in `tests/release-012.test.mjs` that loads the new guide and
asserts exact required language:

```js
test("mobile diagnostics documentation states its privacy and inference boundary", async () => {
  const [guide, readme, architecture, browserSupport] = await Promise.all([
    source("docs/mobile-crash-diagnostics.md"),
    source("README.md"),
    source("docs/architecture.md"),
    source("docs/browser-support.md"),
  ]);
  for (const statement of [
    "No audio bytes, samples, filenames, paths, or Blob URLs",
    "6 sessions",
    "32 KiB",
    "96 checkpoints",
    "does not prove an out-of-memory event",
    "Chrome remote debugging",
    "adb logcat",
  ]) assert.ok(guide.includes(statement), statement);
  assert.ok(readme.includes("docs/mobile-crash-diagnostics.md"));
  assert.ok(architecture.includes("demo-only diagnostic recorder"));
  assert.ok(browserSupport.includes("unexpected-termination"));
});
```

- [ ] **Step 2: Run the documentation contract and verify RED**

Run:

```powershell
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test tests/release-012.test.mjs
```

Expected: FAIL because the guide and links do not exist.

- [ ] **Step 3: Write the canonical guide**

Create `docs/mobile-crash-diagnostics.md` with these sections and explicit
statements:

```md
# Mobile crash diagnostics

## What is collected

Application/schema versions, build commit, session/timing data, browser/device
capabilities, MIME types and encoded sizes, decoded format/frame counts,
sanitized options, memory-plan/admission values, lifecycle stages, aggregate
output counters, and sanitized structured errors.

## What is never collected

No audio bytes, samples, filenames, paths, or Blob URLs are recorded. There
are no analytics, cookies, uploads, telemetry services, automatic
transmissions, or server processing.

## Storage and retention

Records stay in this browser origin. Retention is limited to 6 sessions, 96
checkpoints and 32 KiB per session. Storage failure leaves convolution
available and may reduce diagnostics to the current tab.

## What unexpected termination means

The next load labels an active session without a terminal marker as
`unexpected-termination`. This proves only that the prior JavaScript session
did not save a normal completion or shutdown boundary. It does not prove an
out-of-memory event or reveal Chrome's exact renderer/system reason.

## Collect an Android report

1. Open the hosted app in current Android Chrome.
2. Select the private files and exact options that reproduce the reload/crash.
3. Start convolution.
4. If Chrome reloads or closes the tab, reopen the same site immediately.
5. Download or copy diagnostics before clearing or reproducing again.
6. Record device model/RAM, Android and Chrome versions, observed behavior, and
   the exported JSON with the issue report.

## Add Chrome or Android system evidence

When available, combine the export with Chrome remote debugging console/process
evidence or timestamp-matched `adb logcat` output. Keep audio and unrelated
device data private. JavaScript cannot record the exact instant or system
reason when Chrome kills a renderer.
```

- [ ] **Step 4: Link and summarize the guide**

Add:

- a README link near architecture/browser support;
- a `demo-only diagnostic recorder` subsection to `docs/architecture.md`;
- Android support copy explaining `unexpected-termination` and linking the
  guide in `docs/browser-support.md`.

- [ ] **Step 5: Run docs, identity, link, and contract validation**

Run:

```powershell
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test tests/release-012.test.mjs
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run validate:docs
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run validate:identity
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run validate:links
```

Expected: PASS.

- [ ] **Step 6: Commit documentation**

```powershell
git add docs README.md tests/release-012.test.mjs
git commit -m "docs: explain local crash reports"
```

---

### Task 7: Full verification, privacy audit, and draft-PR readiness

**Files:**
- Review all changed files.
- Do not create generated diagnostic or audio artifacts.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: fresh evidence for the PR description.

- [ ] **Step 1: Run format, lint, Rust, TypeScript, demo, build, package, and static validation**

Run with bundled Node 24.14.0:

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run validate:toolchain
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run check:site-url
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run test:site
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run validate:docs
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run validate:identity
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run validate:links
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run test:ts
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run build
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run validate:jsr
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' pack -w @takana-labs/convolve-wasm --dry-run
```

Expected: every command exits 0. Confirm package contents do not add a public
diagnostic export.

- [ ] **Step 2: Run generated-WASM, E2E, Pages, and artifact suites**

Run:

```powershell
wasm-pack test --headless --chrome crates/convolve-core
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run test:e2e
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run build:pages
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run validate:pages
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run test:pages
```

Expected: PASS in available configured browsers with existing WAV hashes,
metadata, page paths, and clean console/page error assertions unchanged.

- [ ] **Step 3: Run the complete lifecycle contract and a real hidden lifecycle**

Run:

```powershell
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run app:doctor
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run app:status
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run app:start:hidden
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run app:ready
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run app:url
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run app:logs -- --tail 200
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run app:stop
& 'C:\Users\ag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\npm.cmd' run app:status
```

Expected: doctor/ready succeed, the app-owned hidden process serves the built
demo, logs contain no application error, stop confirms port release, and final
status is stopped.

- [ ] **Step 4: Review the diff against every privacy and behavior invariant**

Run:

```powershell
git diff origin/main...HEAD --check
git diff origin/main...HEAD --stat
git diff origin/main...HEAD
rg -n "localStorage|setItem|checkpoint|output-milestone|unknown|filename|fileName|Blob|Float32Array|AudioBuffer|postMessage" apps/demo/src/diagnostics packages/convolve-wasm/src
rg --files -g "*.wav" -g "*.m4a" -g "*diagnostic*.json" -g "*.mp3"
git status --short
```

Review explicitly:

- no audio bytes, samples, typed arrays, filenames, paths, source URLs, Blob
  URLs, stacks, or unknown objects enter persisted details;
- no package consumer storage access;
- all rings, strings, checkpoints, and retained sessions are bounded;
- only stage transitions and sampled output milestones cause progress writes;
- every diagnostic call is no-throw;
- `CONVOLVE()` declarations and runtime behavior are unchanged;
- existing WAV hash and metadata assertions are unchanged and passing;
- no private audio, generated output, exported JSON, or source-tree WASM is
  staged.

- [ ] **Step 5: Request focused code review and fix all Critical/Important findings**

Use `superpowers:requesting-code-review` with base `origin/main` and current
`HEAD`. Ask the reviewer specifically to inspect privacy leakage, unbounded
storage, synchronous write frequency, recovery false claims, API changes, and
PCM/output risk. For every valid issue, add a failing regression test before
the fix and rerun the focused plus complete affected suite.

- [ ] **Step 6: Re-run fresh final verification after review fixes**

Run the full commands from Steps 1-3 again. Do not rely on earlier output.
Record exact pass counts, browsers, and any environment limitation for the PR.

- [ ] **Step 7: Prepare the draft PR body**

The body must include these exact topics:

```md
## Why deployment logs are insufficient

GitHub Pages deployment logs cover static build and delivery. Audio decode,
WASM processing, and renderer termination happen in the user's browser, so a
renderer kill leaves no useful server-side request or deployment trace.

## How recovery works

The demo writes small, bounded checkpoints and an active marker to localStorage
at meaningful boundaries. On the next load, an active session without a known
terminal marker is recovered and labeled `unexpected-termination`.

## What the inference proves

It proves only that the previous JavaScript session did not record normal
completion, cancellation, failure, or clean shutdown. It does not prove OOM or
identify Chrome's browser, renderer, operating-system, or device-level cause.

## Privacy boundary

No audio bytes, samples, decoded channels, filenames, paths, Blob URLs, stacks,
cookies, analytics, uploads, telemetry services, or automatic transmissions.
Only approved bounded scalar fields are retained locally until manual export
or clear.

## Verification

List the exact Rust, TypeScript, demo, E2E, Pages, build, lint, documentation,
identity, link, package, lifecycle, privacy scan, API signature, metadata, and
WAV-hash checks run.
```

- [ ] **Step 8: Commit any final reviewed adjustments**

```powershell
git add apps/demo packages/convolve-wasm/src tests/e2e tests/release-012.test.mjs docs README.md
git commit -m "test: verify private crash diagnostics"
```

Skip this commit if review required no changes.
