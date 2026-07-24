import { describe, expect, it, vi } from "vitest";

import {
  emitBrowserDiagnostic,
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

  it("cannot let browser dispatch failures affect its caller", () => {
    const original = globalThis.dispatchEvent;
    globalThis.dispatchEvent = vi.fn(() => {
      throw new Error("dispatch failure");
    });
    try {
      expect(() =>
        emitBrowserDiagnostic({ type: "worker-created" }),
      ).not.toThrow();
    } finally {
      globalThis.dispatchEvent = original;
    }
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

  it("drops detail values that do not match their allowlisted scalar types", () => {
    const value = safeDiagnosticError({
      message: "safe",
      details: {
        estimatedBytes: "C:\\private\\take.wav",
        appendReverse: "SECRET_BOOLEAN",
        beatPan: "SECRET_SOURCE",
        deviceMemoryGiB: "SECRET_MEMORY",
      },
    });

    expect(value).toEqual({ message: "safe" });
    expect(JSON.stringify(value)).not.toContain("SECRET");
  });
  it("cannot let hostile error objects affect processing failures", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();

    expect(() => safeDiagnosticError(revoked.proxy)).not.toThrow();
    expect(safeDiagnosticError(revoked.proxy)).toEqual({ message: "" });
  });
  it("does not invoke throwing own accessors while sanitizing errors", () => {
    let getterInvoked = false;
    const hostile = {};
    Object.defineProperty(hostile, "message", {
      get() {
        getterInvoked = true;
        throw new Error("SECRET_GETTER");
      },
    });

    expect(() => safeDiagnosticError(hostile)).not.toThrow();
    expect(safeDiagnosticError(hostile)).toEqual({ message: "" });
    expect(getterInvoked).toBe(false);
  });

  it("does not throw when a Proxy traps own-property inspection", () => {
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("SECRET_DESCRIPTOR_TRAP");
        },
      },
    );

    expect(() => safeDiagnosticError(hostile)).not.toThrow();
    expect(safeDiagnosticError(hostile)).toEqual({ message: "" });
  });

  it("redacts arbitrary filename tokens from diagnostic free text", () => {
    const value = safeDiagnosticError({
      message:
        "failed core.wasm while reading report.json from worker.js and take.mp3",
      stack: "SECRET_STACK",
    });
    const json = JSON.stringify(value);

    for (const secret of [
      "core.wasm",
      "report.json",
      "worker.js",
      "take.mp3",
      "SECRET_STACK",
    ]) {
      expect(json).not.toContain(secret);
    }
  });

  it.each([
    [
      "multi-word audio filename",
      "Could not decode private secret.wav",
      ["private", "secret.wav"],
    ],
    [
      "numeric-leading filename extension",
      "Could not unpack archive.7z",
      ["archive.7z"],
    ],
  ])("redacts every sentinel in %s", (_label, message, sentinels) => {
    const sanitized = JSON.stringify(safeDiagnosticError({ message }));

    for (const sentinel of sentinels) {
      expect(sanitized).not.toContain(sentinel);
    }
  });

  it("preserves a diagnostic category that contains no filename", () => {
    expect(
      safeDiagnosticError({ message: "WAV decoder unavailable" }),
    ).toEqual({ message: "WAV decoder unavailable" });
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
