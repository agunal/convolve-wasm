import { expect, test, type Page } from "@playwright/test";

import {
  CLICK_TRACK_FRAMES,
  IMPULSE_RESPONSE_FRAMES,
  SOURCE_A_FRAMES,
  makeClickTrackWav,
  makeImpulseResponseWav,
  makeSourceAWav,
  readWavHeader,
} from "./fixtures";

interface BrowserFailures {
  pageErrors: string[];
  consoleErrors: string[];
}

function watchFailures(page: Page): BrowserFailures {
  const failures: BrowserFailures = { pageErrors: [], consoleErrors: [] };
  page.on("pageerror", (error) => failures.pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") failures.consoleErrors.push(message.text());
  });
  return failures;
}

async function setAudioFiles(page: Page, a: Buffer, b: Buffer): Promise<void> {
  await page.locator("#audio-a").setInputFiles({
    name: "a.wav",
    mimeType: "audio/wav",
    buffer: a,
  });
  await page.locator("#audio-b").setInputFiles({
    name: "b.wav",
    mimeType: "audio/wav",
    buffer: b,
  });
}

async function runAndReadOutput(page: Page): Promise<Uint8Array> {
  await page.locator("#run").click();
  const status = page.locator("#status");
  await expect(status).toHaveAttribute("data-state", "done", {
    timeout: 90_000,
  });
  await expect(page.locator("#preview")).toHaveAttribute("src", /^blob:/);
  await expect(page.locator("#download")).toHaveAttribute("href", /^blob:/);
  await expect(page.locator("#download")).toHaveAttribute("download", /\.wav$/);
  const output = await page
    .locator("#download")
    .evaluate(async (link: HTMLAnchorElement) =>
      Array.from(new Uint8Array(await (await fetch(link.href)).arrayBuffer())),
    );
  return Uint8Array.from(output);
}

function expectNoBrowserFailures(failures: BrowserFailures): void {
  expect(failures.pageErrors).toEqual([]);
  expect(failures.consoleErrors).toEqual([]);
}

test("creates a playable PCM24 WAV with the full convolution length", async ({
  page,
}) => {
  const failures = watchFailures(page);
  await page.goto("/");
  await setAudioFiles(page, makeSourceAWav(), makeImpulseResponseWav());

  const output = await runAndReadOutput(page);
  const header = readWavHeader(output);

  expect(header.isPcm).toBe(true);
  expect(header.channels).toBe(2);
  expect(header.sampleRate).toBe(48_000);
  expect(header.bitsPerSample).toBe(24);
  expect(header.frames).toBe(SOURCE_A_FRAMES + IMPULSE_RESPONSE_FRAMES - 1);
  expectNoBrowserFailures(failures);
});

test("appends an exact reverse using the default five-millisecond overlap", async ({
  page,
}) => {
  const failures = watchFailures(page);
  await page.goto("/");
  await setAudioFiles(page, makeSourceAWav(), makeImpulseResponseWav());
  await page.locator("#append-reverse").check();

  const output = await runAndReadOutput(page);
  const forwardFrames = SOURCE_A_FRAMES + IMPULSE_RESPONSE_FRAMES - 1;
  expect(readWavHeader(output).frames).toBe(2 * forwardFrames - 240);
  expectNoBrowserFailures(failures);
});

test("reports detected beats for a 120 BPM click track", async ({ page }) => {
  const failures = watchFailures(page);
  await page.goto("/");
  await setAudioFiles(page, makeClickTrackWav(), makeImpulseResponseWav());
  await page.locator("#beat-pan").selectOption("a");

  const output = await runAndReadOutput(page);
  const detectedBeats = Number(
    await page.locator("#status").getAttribute("data-detected-beats"),
  );
  expect(detectedBeats).toBeGreaterThan(0);
  expect(readWavHeader(output).frames).toBe(
    CLICK_TRACK_FRAMES + IMPULSE_RESPONSE_FRAMES - 1,
  );
  expectNoBrowserFailures(failures);
});
