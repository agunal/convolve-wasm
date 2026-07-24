# Mobile crash diagnostics

The hosted demo has a demo-only diagnostic recorder for collecting a small, local report after a browser reload or tab termination. It is not telemetry and does not affect convolution results.

## What is collected

Each report uses diagnostic schema v1 and export v1. It records application and diagnostic-schema versions, build commit, opaque session ID and timing data, sanitized browser/device environment and capability values, input slot, MIME type, and encoded byte size, decoded format (sample rate and channel count) and frame count, sanitized convolution options, memory-plan/admission values, lifecycle and progress stages, aggregate output counters and metadata, and sanitized structured errors.

The report stores only the allow-listed scalar fields for those checkpoints. Unknown fields are ignored rather than copied into a record.

## What is never collected

No audio bytes, samples, filenames, paths, or Blob URLs are recorded. The recorder also does not retain decoded channel buffers, audio names, source URLs, stack traces, or unknown fields. It has no analytics, cookies, uploads, telemetry services, automatic transmissions, or server processing. Downloading or copying an export is a manual user action.

## Storage and retention

Records stay in `localStorage` for the same browser origin: the session ring key is `convolve-wasm:diagnostics:v1` and the active marker key is `convolve-wasm:diagnostics:active:v1`. Retention is bounded to 6 sessions, 96 checkpoints per session, and 32,768 UTF-8 JSON bytes (32 KiB) per session. When a session reaches a checkpoint or byte limit, the recorder keeps its session-start anchor and newest boundary while dropping older non-anchor checkpoints and counting those drops. Retention removes older completed sessions before an active or newly recovered one.

Checkpoint updates are persisted incrementally with the active marker. On a later load of the same site/origin, those local records can therefore survive a reload and be recovered, unless storage was unavailable or a write failed. This is best effort: disabled storage leaves diagnostics in the current tab only; quota pressure may prune older completed sessions and then degrade to current-tab diagnostics; and corrupt or unsupported stored data is cleared or recovered only where safe. These diagnostic storage failures do not block convolution.

## What unexpected termination means

On the next load, an active marker whose session lacks a terminal completion or clean-shutdown checkpoint is labeled `unexpected-termination`. This proves only that the previous JavaScript session did not save a normal completion or shutdown boundary. It does not prove an out-of-memory event, browser crash, exact kill instant, or Chrome renderer/system reason.
If recovery has only the active marker and no retained session, the export explicitly states that detailed checkpoints were unavailable.

A clean navigation can save a `pagehide`/clean-shutdown boundary, but termination can prevent JavaScript from running that cleanup. The label is deliberately an inference, not a crash classifier.

## Collect an Android report

1. Open the hosted app in current Android Chrome and select the private files and exact options that reproduce the reload or termination.
2. Start convolution and note the visible behavior and approximate time.
3. If Chrome reloads or closes the tab, reopen the same site/origin immediately.
4. Review the recovered-session notice and the `unexpected-termination` record if it appears.
5. Download or copy diagnostics promptly, before clearing the records or reproducing again.
6. Clear diagnostics from the app when desired, then record device model/RAM, Android and Chrome versions, the observed behavior, and the exported JSON with the issue report.

## Add Chrome or Android system evidence

When available, combine the local export with Chrome remote debugging console/process evidence or timestamp-matched `adb logcat` output. Keep audio and unrelated device data private. JavaScript cannot record the exact instant or system reason when Chrome kills a renderer.

This is a static, client-only application: convolution and this recorder run in the browser, with no diagnostics upload endpoint or server-side processing request. Deployment or server logs therefore cannot diagnose a browser renderer termination; they do not observe the local renderer's memory decision or termination reason. The incremental local checkpoints above are the browser-side evidence that may remain after the same origin reloads.
