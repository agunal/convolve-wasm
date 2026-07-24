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
});
