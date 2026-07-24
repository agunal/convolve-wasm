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
  ])("redacts %s", (_label, input, sentinels) => {
    const output = sanitizeSensitiveText(input);
    for (const sentinel of sentinels.split("|")) {
      expect(output).not.toContain(sentinel);
    }
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
