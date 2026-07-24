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

test("exports marker-only recovery with unavailable-checkpoint wording", async ({ page }) => {
  await page.addInitScript(({ activeKey }) => {
    localStorage.setItem(activeKey, JSON.stringify({
      schemaVersion: 1,
      sessionId: "marker-only-session",
      startedAt: "2026-07-23T20:00:00.000Z",
      updatedAt: "2026-07-23T20:00:03.000Z",
      lastCheckpointSequence: 0,
      appVersion: "0.1.0",
      buildCommit: "seed-build",
    }));
  }, { activeKey: ACTIVE_KEY });
  await page.goto("/");

  await expect(page.locator("#diagnostics-recovered")).toContainText(
    /detailed checkpoints were unavailable/i,
  );
  const json = await downloadedText(page, "#diagnostics-download");
  const report = JSON.parse(json) as {
    sessions: Array<{ inference?: { markerOnly: boolean; statement: string } }>;
  };
  expect(report.sessions.at(-1)?.inference).toMatchObject({ markerOnly: true });
  expect(report.sessions.at(-1)?.inference?.statement).toMatch(
    /detailed checkpoints were unavailable/i,
  );
});
