import { describe, expect, it } from "vitest";
import * as sanitizerModule from "./sanitize";

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
  it("preserves a realistic Android Chrome user agent", () => {
    const sanitizeEnvironmentText = (
      sanitizerModule as typeof sanitizerModule & {
        sanitizeEnvironmentText?: (value: unknown) => string;
      }
    ).sanitizeEnvironmentText;
    expect(sanitizeEnvironmentText).toBeTypeOf("function");
    if (!sanitizeEnvironmentText) return;
    const userAgent = "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro Build/UQ1A.240105.004) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

    expect(sanitizeEnvironmentText(userAgent)).toBe(userAgent);
    expect(sanitizeEnvironmentText(userAgent).length).toBeLessThanOrEqual(512);
  });

  it("preserves a realistic iPhone Safari user agent", () => {
    const sanitizeEnvironmentText = (
      sanitizerModule as typeof sanitizerModule & {
        sanitizeEnvironmentText?: (value: unknown) => string;
      }
    ).sanitizeEnvironmentText;
    expect(sanitizeEnvironmentText).toBeTypeOf("function");
    if (!sanitizeEnvironmentText) return;
    const userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

    expect(sanitizeEnvironmentText(userAgent)).toBe(userAgent);
  });
  it("keeps user agents at their 512-character policy while capping platform text at 120", () => {
    const platform = `Android ${"x".repeat(200)}`;
    expect(sanitizerModule.sanitizeEnvironmentText("Mozilla/5.0")).toBe("Mozilla/5.0");
    expect(sanitizerModule.sanitizePlatformText(platform)).toHaveLength(120);
  });

  it.each([
    ["HTTPS URL", "Chrome/126 https://private.example/PRIVATE_HTTP", "PRIVATE_HTTP"],
    ["Blob URL", "Chrome/126 blob:https://private.example/PRIVATE_BLOB", "PRIVATE_BLOB"],
    ["file URL", "Linux file:///home/private/PRIVATE_FILE", "PRIVATE_FILE"],
    ["data URL", "Android data:text/plain,PRIVATE_DATA", "PRIVATE_DATA"],
    ["Windows path", "Windows C:\\Users\\private\\PRIVATE_WINDOWS", "PRIVATE_WINDOWS"],
    ["POSIX path", "Linux /home/private/PRIVATE_POSIX", "PRIVATE_POSIX"],
    ["relative path", "Build ../private/PRIVATE_RELATIVE", "PRIVATE_RELATIVE"],
    ["bare path", "Linux home/private/PRIVATE_BARE.txt", "PRIVATE_BARE"],
    ["control-delimited path", "Chrome/126\u0000/home/private/PRIVATE_CONTROL_PATH", "PRIVATE_CONTROL_PATH"],
    ["control text", "Android\u0000PRIVATE_CONTROL", "\u0000"],
  ])("redacts %s in environment fields without treating version slashes as paths", (
    _label,
    input,
    sentinel,
  ) => {
    const sanitizeEnvironmentText = (
      sanitizerModule as typeof sanitizerModule & {
        sanitizeEnvironmentText?: (value: unknown) => string;
      }
    ).sanitizeEnvironmentText;
    expect(sanitizeEnvironmentText).toBeTypeOf("function");
    if (!sanitizeEnvironmentText) return;

    const output = sanitizeEnvironmentText(input);
    expect(output).toContain(input.match(/^[A-Za-z]+(?:\/\d+)?/u)?.[0]);
    expect(output).not.toContain(sentinel);
    expect(output.length).toBeLessThanOrEqual(512);
  });

  it.each(["private-recording.mp3", "private-recording.flac", "private-recording.pdf", "private-recording.7z"])(
    "redacts generic filename %s from sensitive and environment text",
    (filename) => {
      expect(sanitizeSensitiveText(`failed ${filename}`)).not.toContain(filename);
      const sanitizeEnvironmentText = sanitizerModule.sanitizeEnvironmentText;
      expect(sanitizeEnvironmentText(`Platform ${filename}`)).not.toContain(filename);
    },
  );

  it("rejects MIME parameters at the schema-v1 persistence boundary", () => {
    expect(sanitizeCheckpointDetails("input", {
      slot: "a", mimeType: "audio/wav;name=private-recording.wav", encodedBytes: 1,
    })).toEqual({ slot: "a", encodedBytes: 1 });
  });
  it.each(["audio/private-recording.mp3", "audio/private-recording.flac", "audio/private-recording.7z"])(
    "rejects filename-shaped bare MIME essence %s at the schema-v1 persistence boundary",
    (mimeType) => {
      expect(sanitizeCheckpointDetails("input", {
        slot: "a", mimeType, encodedBytes: 1,
      })).toEqual({ slot: "a", encodedBytes: 1 });
    },
  );


  it.each([
    ["audio name", "Could not decode secret-take.wav", "secret-take"],
    ["M4A name", "bad VOICE.M4A input", "VOICE.M4A"],
    ["Windows path", "C:\\Users\\private\\secret-take.wav", "secret-take"],
    ["POSIX path", "/home/private/secret-take.wav", "secret-take"],
    ["file URL", "file:///home/private/secret-take.wav", "secret-take"],
    ["Blob URL", "blob:https://example.test/private-id", "private-id"],
    ["quoted whitespace audio name", 'Could not decode "mix final.wav"', "mix final"],
    ["unquoted whitespace audio name", "Could not decode mix final.wav", "mix final"],
    ["whitespace Windows path", "C:\\Users\\Jane Doe\\mix final.wav", "Jane|Doe|mix|final"],
    ["UNC path", "\\\\server\\private share\\mix final.wav", "server|private|share|mix|final"],
    ["relative path", "../private folder/mix final.wav", "private|folder|mix|final"],
    ["HTTPS source URL", "https://example.test/private-id", "example.test|private-id"],
    ["bare separator path", "private/folder/secret.wav", "private|folder|secret"],
    ["Windows slash path", "C:/Users/private/secret.wav", "C:|Users|private|secret"],
    ["tilde path", "~/private/secret.wav", "private|secret"],
    ["webpack source URL", "webpack://private/hidden-file", "private|hidden-file"],
    ["data audio URL", "data:audio/wav;base64,ENCODED_AUDIO_BYTES", "audio/wav|ENCODED_AUDIO_BYTES"],
  ])("redacts %s", (_label, input, sentinels) => {
    const output = sanitizeSensitiveText(input);
    for (const sentinel of sentinels.split("|")) {
      expect(output).not.toContain(sentinel);
    }
    expect(output.length).toBeLessThanOrEqual(512);
  });

  it("bounds huge untrusted text before redaction", () => {
    const output = sanitizeSensitiveText(`${"x".repeat(1_000_000)} secret.wav`);
    expect(output.length).toBeLessThanOrEqual(512);
    expect(output).not.toContain("secret.wav");
  });

  it("redacts complete drive paths before generic source URL handling", () => {
    expect(sanitizeSensitiveText("C:\\Users\\Jane Doe")).toBe("[redacted-path]");
    expect(sanitizeSensitiveText("C:/Users/Jane Doe")).toBe("[redacted-path]");
  });

  it("fails closed for an oversized string that ends inside a filename", () => {
    const longBlobUrl = `blob:https://example.test/${"x".repeat(4_050)}`;
    expect(sanitizeSensitiveText(`${longBlobUrl} private-recording.wav`)).toBe(
      "[redacted-oversized-text]",
    );
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

  it("assigns the approved checkpoint source without retaining nested error data", () => {
    const details = sanitizeCheckpointDetails("worker-error", {
      error: {
        message: "Worker failed at /private/secret.wav",
        stack: "DROP_STACK",
        samples: new Float32Array([0.123456]),
      },
    });
    expect(details).toEqual({
      source: "worker",
      message: "Worker failed at [redacted-path]",
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
    expect(parseActiveMarker({ schemaVersion: 1, sessionId: "../private.wav" })).toBeNull();
  });

  it("reconstructs a fully valid nested store and drops every unknown field", () => {
    const result = migrateDiagnosticStore(validNestedStore());
    expect(result).toEqual({
      kind: "ok",
      store: {
        schemaVersion: 1,
        sessions: [
          {
            schemaVersion: 1,
            id: "session-1",
            startedAt: "2026-07-23T20:00:00.000Z",
            updatedAt: "2026-07-23T20:00:01.000Z",
            status: "active",
            app: { version: "0.1.0", buildCommit: "commit-1" },
            environment: validEnvironment(),
            checkpoints: [
              {
                sequence: 1,
                type: "input",
                timestamp: "2026-07-23T20:00:01.000Z",
                elapsedMs: 1,
                details: { slot: "a", mimeType: "audio/wav", encodedBytes: 2 },
              },
            ],
            droppedCheckpoints: 0,
          },
        ],
      },
    });
  });

  it.each([
    ["missing", undefined],
    ["scalar", 1],
    ["array", []],
    ["binary", new Uint8Array([1])],
  ])("rejects a %s checkpoint details value", (_label, details) => {
    const store = validNestedStore();
    const checkpoint = (store.sessions as Array<Record<string, unknown>>)[0]!.checkpoints as Array<Record<string, unknown>>;
    if (details === undefined) delete checkpoint[0]!.details;
    else checkpoint[0]!.details = details;
    expect(migrateDiagnosticStore(store)).toEqual({ kind: "corrupt" });
  });

  it("accepts a fully valid active marker and rejects a one-field path mutation", () => {
    const marker = validActiveMarker();
    expect(parseActiveMarker(marker)).toEqual({
      schemaVersion: 1,
      sessionId: "session-1",
      startedAt: "2026-07-23T20:00:00.000Z",
      updatedAt: "2026-07-23T20:00:01.000Z",
      lastCheckpointSequence: 1,
      appVersion: "0.1.0",
      buildCommit: "commit-1",
    });
    marker.sessionId = "../private.wav";
    expect(parseActiveMarker(marker)).toBeNull();
  });
});

function validEnvironment() {
  return {
    userAgent: "Test Browser",
    platform: "Test Platform",
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
  };
}

function validNestedStore(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    unknownStore: "DROP_STORE",
    sessions: [
      {
        schemaVersion: 1,
        id: "session-1",
        startedAt: "2026-07-23T20:00:00.000Z",
        updatedAt: "2026-07-23T20:00:01.000Z",
        status: "active",
        app: { version: "0.1.0", buildCommit: "commit-1", unknownApp: "DROP_APP" },
        environment: { ...validEnvironment(), unknownEnvironment: "DROP_ENVIRONMENT" },
        checkpoints: [
          {
            sequence: 1,
            type: "input",
            timestamp: "2026-07-23T20:00:01.000Z",
            elapsedMs: 1,
            details: {
              slot: "a",
              mimeType: "audio/wav",
              encodedBytes: 2,
              unknownDetails: "DROP_DETAILS",
            },
            unknownCheckpoint: "DROP_CHECKPOINT",
          },
        ],
        droppedCheckpoints: 0,
        unknownSession: "DROP_SESSION",
      },
    ],
  };
}

function validActiveMarker(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sessionId: "session-1",
    startedAt: "2026-07-23T20:00:00.000Z",
    updatedAt: "2026-07-23T20:00:01.000Z",
    lastCheckpointSequence: 1,
    appVersion: "0.1.0",
    buildCommit: "commit-1",
    unknownMarker: "DROP_MARKER",
  };
}
