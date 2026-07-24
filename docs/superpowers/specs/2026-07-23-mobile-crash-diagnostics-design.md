# Mobile Crash Diagnostics Design

## Goal

Add privacy-preserving, browser-local diagnostics to the hosted
`convolve-wasm` demo so useful checkpoints survive an abrupt Android Chrome
tab or renderer termination and can be exported manually after the user
reopens the site.

The recorder is diagnostic evidence, not telemetry. It never uploads or
automatically transmits anything, and an inferred `unexpected-termination`
does not prove an out-of-memory kill or identify Chrome's exact reason for
ending a renderer.

## Scope and invariants

Persistent recording belongs only to `apps/demo`. Importing
`@takana-labs/convolve-wasm` in another application does not read or write
browser storage.

The package may emit internal, sanitized lifecycle events so the demo can
observe decode, memory planning, worker, WASM, and streamed-output boundaries.
Those events are not exported as a public API. The following behavior remains
unchanged:

- the public `CONVOLVE()` signature and option types;
- progress stages, fractions, and callback behavior;
- structured error codes, messages, details, and rejection timing;
- DSP operations and operation order;
- output metadata;
- PCM sample values, WAV headers, and final WAV bytes;
- the current processing controls, result playback, and WAV download behavior;
- the absence of v0.2.0 processing modes or bounded convolution.

Diagnostic dispatch, serialization, storage, clipboard, and export failures
are isolated from the processing promise. A diagnostic failure must never
block, reject, cancel, or otherwise alter convolution.

## Considered approaches

### Internal lifecycle events with demo-only persistence

The package emits a strict discriminated union of approved scalar diagnostic
events. The worker reports its safe lifecycle events through the existing
worker protocol, and the control thread forwards them through one internal
browser event. The demo listens, sanitizes again, and persists checkpoints.

This is the selected approach. It reaches the required deep lifecycle
boundaries while keeping storage out of package consumers and preserving the
public API.

### Demo wrapper only

The demo could record input summaries, public progress, results, and rejected
errors around `CONVOLVE()`. It could not reliably distinguish worker creation,
WASM initialization, memory admission, or streamed Blob assembly. This would
leave the most useful crash boundaries unobserved.

### Public diagnostic callback

A public observer option would make integration explicit, but it would change
the package surface and create a compatibility commitment for a demo-specific
feature. This is unnecessary for the current goal.

## Component boundaries

### Package lifecycle bridge

A focused internal package module defines the allowed event union and a
best-effort emitter. Event payloads are constructed field by field. They never
contain a `File`, `Blob`, `AudioBuffer`, typed array, channel data, worker
message object, arbitrary error object, filename, path, URL, or stack.

The browser control thread emits:

- decode start, success, and failure for input slot `a` or `b`;
- decoded sample rate, channel count, and frame count;
- calculated memory estimate, budget, FFT frames, forward/final output frames,
  reverse state, sanitized options, and admission or rejection;
- worker creation, worker `error`, worker `messageerror`, and cancellation;
- output start;
- sampled output assembly milestones with aggregate chunk and PCM byte counts;
- final Blob completion with aggregate chunk count and total WAV bytes;
- terminal request success or failure.

The worker protocol adds safe lifecycle messages for WASM initialization start,
success, and failure. Existing progress and output protocol messages retain
their exact meaning and ordering.

The bridge catches its own failures. A missing `window` or `CustomEvent`
implementation is a no-op so Node tests and non-window consumers behave as
before.

### Demo recorder

The demo recorder owns:

- schema validation and explicit migration dispatch;
- strict checkpoint construction and error sanitization;
- session state;
- the bounded in-memory ring;
- best-effort `localStorage` persistence;
- active-marker recovery;
- deterministic pruning;
- formatted export creation;
- clearing;
- a read-only state subscription used by the UI.

The recorder accepts injected storage, clocks, ID generation, and deferred
scheduling so its failure modes and coalescing behavior can be tested without
browser globals.

### Demo integration and UI

The demo starts one diagnostic session per processing attempt. It records the
application/environment checkpoint and the two input summaries before calling
`CONVOLVE()`. It consumes the package lifecycle bridge, records public progress
stage transitions, and adds UI-only checkpoints for preview assignment and
visible success or failure.

Global listeners record `window.error`, `unhandledrejection`, visibility
changes, non-persisted `pagehide`, and preview-audio errors. They never call
`preventDefault()` and do not change normal browser error handling.

Global incidents attach to the active processing session when one exists.
Preview errors or late global incidents may append to the most recent terminal
session without reopening its active marker. If no session exists, the
recorder creates a bounded incident-only session, records the environment and
sanitized error, and immediately marks it `failed`.

## Schema and limits

The storage schema version and export schema version are both explicit integer
`1` values. The recorder uses two origin-local keys: one for the retained ring
and one for the active-session marker.

The retained store has this conceptual shape:

```json
{
  "schemaVersion": 1,
  "sessions": []
}
```

Each session contains:

- schema version and opaque random session ID;
- wall-clock start and last-update timestamps;
- status: `active`, `succeeded`, `failed`, `cancelled`, `clean-shutdown`, or
  `unexpected-termination`;
- application version and build commit;
- bounded environment and capability fields;
- ordered checkpoints;
- a count of deterministically dropped checkpoints;
- an optional explicit unexpected-termination inference object.

Each checkpoint contains a bounded sequence number, approved type, ISO
wall-clock timestamp, non-negative monotonic elapsed milliseconds, and a
type-specific approved data object.

Limits are constants and are included in exports:

- at most 6 retained sessions;
- at most 96 checkpoints per session;
- at most 32 KiB of UTF-8 JSON per session;
- at most 512 characters per sanitized error message;
- at most 120 characters for MIME, platform, capability, code, and similar
  bounded strings.

The retained ring therefore stays below approximately 200 KiB plus a
sub-kilobyte active marker. The limits are intentionally far below common
`localStorage` quotas.

When a checkpoint would cross a count or byte limit, the recorder preserves
the session-start anchor and newest boundary, removes the oldest non-anchor
checkpoint first, and increments `droppedCheckpoints`. Retention removes the
oldest completed session first, ordered by start timestamp and then session ID.
The active session is retained ahead of completed sessions. These rules make
rotation deterministic.

## Approved fields and privacy filtering

The session-start checkpoint may contain only:

- application version, build commit, diagnostic schema version;
- user agent and platform;
- `navigator.deviceMemory` when finite and positive;
- finite hardware concurrency;
- booleans for WebAssembly, Worker, OfflineAudioContext, ReadableStream,
  `Response.blob()`, random UUID, local storage, and Clipboard API support.

Input checkpoints may contain only input slot, MIME type, and encoded byte
size. Empty MIME types are represented as an empty string. File names and
extensions derived from names are never recorded.

Options may contain only normalized `beatPan`, `panTransitionMs`,
`reverseCrossfadeMs`, `targetDbtp`, and `appendReverse`. Callback functions and
unknown option properties are omitted.

Structured errors may contain only:

- source category such as `decode`, `worker`, `window`, `promise`, `audio`, or
  `processing`;
- approved stable error code when available;
- bounded error name;
- sanitized bounded message;
- finite line and column numbers when available;
- a small approved numeric/boolean detail list used by memory planning and
  processing (`estimatedBytes`, `limitBytes`, `aFrames`, `bFrames`,
  `outputFrames`, `finalFrames`, `fftFrames`, `appendReverse`,
  `reverseCrossfadeFrames`, `beatPan`, and `deviceMemoryGiB`).

Stacks, source URLs, worker filenames, `event.reason` objects, and unknown error
details are never persisted.

Before persistence, every string sanitizer removes Blob URLs, file URLs,
Windows and POSIX path-like text, and tokens ending in `.wav` or `.m4a`,
replacing them with explicit redaction labels. Control characters are removed
and the result is length limited. The persistence layer reconstructs every
checkpoint from an approved field list; it never spreads, stringifies, or
recursively walks an unknown object.

The test suite uses sentinel private values in names, paths, sample arrays,
audio-like objects, Blob URLs, stack text, and unknown fields, then scans both
stored and exported JSON to prove those sentinels are absent.

## Session and recovery state machine

1. On a processing attempt, create the bounded session in memory and persist
   the ring.
2. Persist the active marker only after the session exists in the ring.
3. At each meaningful boundary, update the ring and then the marker's last
   checkpoint sequence and timestamp.
4. A known success, structured failure, cancellation, or clean non-persisted
   `pagehide` appends a terminal checkpoint, persists the terminal session, and
   removes the active marker.
5. `visibilitychange` and a persisted `pagehide` are recorded but do not
   classify the session as cleanly shut down. A restored back-forward-cache
   page can continue the same attempt.

On the next page load, recovery reads the validated ring and marker:

- If the marker references a session with no terminal checkpoint, append an
  `unexpected-termination` inference, set the status accordingly, persist the
  recovered session, and remove the marker.
- If the referenced session already has a terminal checkpoint, treat the
  marker as a stale write and remove it without adding an inference.
- If the ring is missing or corrupt but a valid marker survives, create a
  bounded marker-only recovery record that clearly states the detailed
  checkpoints were unavailable.
- If the marker itself is corrupt or unsupported, remove it and expose a
  storage-recovery state without fabricating a crash record.

The inference text in both UI and export states that the previous JavaScript
session did not record a normal terminal boundary. It does not claim OOM,
renderer crash, browser crash, operating-system kill, or any exact cause.

## Persistence behavior

Meaningful lifecycle boundaries write synchronously because renderer-crash
survival is the purpose of the feature. High-frequency progress does not.

Public progress is coalesced to stage transitions. Repeated fractions within
the same stage update only ephemeral in-memory timing. Streamed output keeps
chunk and PCM-byte counters in memory and persists only output start, sampled
25/50/75 percent milestones, and completion. No per-chunk checkpoints are
stored.

Storage access is wrapped at the getter, parse, validation, write, and removal
boundaries:

- unavailable or security-disabled storage switches to current-tab memory and
  reports `unavailable`;
- corrupt JSON or invalid schema-v1 data resets only the recorder's keys and
  reports `recovered-corruption`;
- an unsupported schema is never recursively inspected or exported; it resets
  only the recorder's keys and reports `unsupported-schema`;
- quota failure deterministically prunes this recorder's oldest completed
  sessions and retries after each prune;
- a remaining quota failure switches to current-tab memory and reports
  `quota-exceeded`;
- clearing removes only the two diagnostic keys and resets in-memory records.

The schema loader is an explicit migration dispatcher. Version 1 is the first
supported version; future versions must add a reviewed, field-by-field
migration rather than accepting unknown data.

## Export format

Download and copy use the same freshly generated, two-space-indented JSON:

```json
{
  "exportFormat": "convolve-wasm-diagnostics",
  "exportVersion": 1,
  "generatedAt": "ISO-8601 timestamp",
  "notice": "Unexpected termination is an inference and does not identify an exact browser or system cause.",
  "privacy": {
    "audioDataRecorded": false,
    "fileNamesRecorded": false,
    "automaticUpload": false
  },
  "limits": {
    "retainedSessions": 6,
    "sessionBytes": 32768,
    "checkpointsPerSession": 96
  },
  "storageState": "available",
  "sessions": []
}
```

The export is generated from the validated in-memory model, never directly
from raw storage. Diagnostic download uses a short-lived JSON Blob URL that is
not recorded and is revoked after activation. Copy is shown only when
`navigator.clipboard.writeText` is available.

## User interface

A compact Diagnostics section is added to the existing dark interface near the
result panel. It includes:

- current storage state and retained-session count;
- a prominent but calm recovered-session notice;
- a concise latest-session summary with status, last boundary, and timestamp;
- Download diagnostics;
- Copy diagnostics only when supported;
- Clear diagnostics with a confirmation that names the local records being
  removed;
- explicit copy that no audio bytes, samples, filenames, or paths are recorded
  and nothing is uploaded;
- Android instructions: reproduce, reopen the page after a reload or crash,
  and export before clearing or reproducing again;
- a limitation statement that JavaScript cannot record the exact instant or
  system reason Chrome kills a renderer.

When processing fails, an unobtrusive Download diagnostics action appears
alongside the structured failure. It does not replace or alter the existing
error text.

## Testing strategy

Implementation follows red-green-refactor cycles.

Focused demo unit tests cover:

- ring rotation by count and byte bound;
- deterministic pruning;
- corrupt JSON, invalid v1 data, and unsupported schemas;
- disabled storage and quota failure;
- exact redaction of file names, Windows/POSIX paths, Blob URLs, stacks,
  samples, audio data, binary values, and unknown fields;
- active-marker write ordering and meaningful-boundary updates;
- normal success/failure/cancellation/clean shutdown versus inferred
  unexpected termination;
- marker-only recovery;
- progress-stage coalescing and sampled aggregate output milestones;
- worker, promise, window, and audio error capture;
- export shape and schema version;
- copy/download data equivalence;
- clearing both keys;
- continued app processing when every diagnostic operation throws.

Package unit tests cover each internal lifecycle emission point, worker
`messageerror`, WASM initialization reports, aggregate chunk counters, and the
fact that diagnostic observers cannot change request results.

Playwright coverage:

- seeds a valid unfinished session and active marker, reloads, verifies the
  recovered notice, downloads JSON, and checks the inference wording and
  schema;
- verifies copy availability conditionally;
- verifies clearing;
- injects storage failures, completes a later convolution, and retains the
  existing metadata and browser-specific WAV SHA-256 expectations;
- verifies the normal processing path produces no page or console errors;
- verifies the diagnostics section remains contained at phone, tablet, and
  desktop widths.

Actual renderer termination is not automated. The E2E test intentionally seeds
an incomplete persisted session and tests recovery rather than claiming to
prove a browser OOM.

Existing Rust golden fixtures, WASM output goldens, TypeScript API signature
tests, package-consumer tests, and Chromium/WebKit E2E WAV hashes remain the
authoritative regression evidence that diagnostics did not change DSP or the
public API.

## Documentation and verification

Repository documentation will state exactly what is and is not collected,
limits and retention, the recovery inference, Android collection steps, the
JavaScript visibility limitation, and how to pair an exported record with
Chrome remote debugging or `adb logcat`.

Final verification uses the repository-owned lifecycle commands and bundled
Node 24.14.0. It runs the complete applicable Rust, TypeScript, demo, E2E,
Pages, build, lint, documentation, identity, link, package, and lifecycle
suites. Before the draft PR, the diff is reviewed specifically for privacy
leakage, unbounded storage, high-frequency synchronous writes, output/API
changes, generated diagnostics, private audio, and rendered audio artifacts.

The draft PR explains why deployment logs cannot observe a client renderer
termination, how local incremental checkpoints survive reload, what the
unexpected-termination inference proves and does not prove, the privacy
boundary, and the verification performed.
