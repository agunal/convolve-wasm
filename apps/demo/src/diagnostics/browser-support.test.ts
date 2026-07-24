import { describe, expect, it } from "vitest";

import { copyEnvironment, mapMediaError } from "./browser-mappers";
import { summaryMessage } from "./browser-ui";

describe("browser diagnostics support", () => {
  it("maps prototype MediaError values through a fresh allowlist", () => {
    const mediaError = Object.create({
      code: 3,
      message: "Could not decode C:\\private\\preview.wav",
      privateField: "DROP",
    });

    expect(mapMediaError(mediaError)).toEqual({
      source: "audio",
      code: "MEDIA_ERR_DECODE",
      message: "Could not decode [redacted-path]",
    });
  });

  it("copies bounded browser environment fields without destroying UA tokens", () => {
    const userAgent =
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36";

    expect(copyEnvironment({
      userAgent,
      platform: "Linux armv8l https://private.example/PRIVATE_PATH",
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
    })).toMatchObject({
      userAgent,
      platform: "Linux armv8l [redacted-source-url]",
    });
  });

  it("summarizes the latest boundary with a bounded updated time", () => {
    expect(summaryMessage({
      storageState: "available",
      activeSessionId: null,
      recoveredSessionId: null,
      sessions: [{
        schemaVersion: 1,
        id: "support-summary",
        startedAt: "2026-07-23T20:00:00.000Z",
        updatedAt: "x".repeat(4_000),
        status: "succeeded",
        app: { version: "0.1.0", buildCommit: "test" },
        environment: null,
        checkpoints: [{
          sequence: 0,
          type: "success",
          timestamp: "2026-07-23T20:00:01.000Z",
          elapsedMs: 1,
          details: {},
        }],
        droppedCheckpoints: 0,
      }],
    })).toBe(
      "1 retained diagnostic session. Latest: succeeded; last boundary success; updated unknown time (1 checkpoint).",
    );
  });
});
