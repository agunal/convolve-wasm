import { describe, expect, it, vi } from "vitest";

import type { DecodedInputPair } from "./decode";
import type { ConvolveDiagnosticEvent } from "./diagnostics";
import { normalizeOptions } from "./options";
import type {
  ConvolveMetadata,
  ConvolveProgress,
  ConvolveResult,
} from "./types";
import { WorkerClient } from "./worker-client";
import type {
  WorkerRequest,
  WorkerResponse,
} from "./worker-protocol";

interface PostedMessage {
  message: WorkerRequest;
  transfer: Transferable[];
}

class FakeWorker {
  readonly posts: PostedMessage[] = [];
  readonly messageListeners = new Set<
    (event: MessageEvent<WorkerResponse>) => void
  >();
  readonly errorListeners = new Set<(event: ErrorEvent) => void>();
  readonly messageerrorListeners = new Set<
    (event: MessageEvent<unknown>) => void
  >();

  postMessage(message: WorkerRequest, transfer: Transferable[] = []): void {
    this.posts.push({ message, transfer });
  }

  addEventListener(
    type: "message",
    listener: (event: MessageEvent<WorkerResponse>) => void,
  ): void;
  addEventListener(
    type: "error",
    listener: (event: ErrorEvent) => void,
  ): void;
  addEventListener(
    type: "messageerror",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  addEventListener(
    type: "message" | "error" | "messageerror",
    listener:
      | ((event: MessageEvent<WorkerResponse>) => void)
      | ((event: ErrorEvent) => void)
      | ((event: MessageEvent<unknown>) => void),
  ): void {
    if (type === "message") {
      this.messageListeners.add(
        listener as (event: MessageEvent<WorkerResponse>) => void,
      );
    } else if (type === "error") {
      this.errorListeners.add(listener as (event: ErrorEvent) => void);
    } else {
      this.messageerrorListeners.add(
        listener as (event: MessageEvent<unknown>) => void,
      );
    }
  }

  emitError(message = "fatal worker"): void {
    const event = { message, filename: "worker.ts", lineno: 1, colno: 1 } as ErrorEvent;
    for (const listener of this.errorListeners) listener(event);
  }

  emitMessage(data: WorkerResponse): void {
    const event = { data } as MessageEvent<WorkerResponse>;
    for (const listener of this.messageListeners) listener(event);
  }

  emitMessageError(data: unknown = { secret: "SECRET_DATA" }): void {
    const event = { data } as MessageEvent<unknown>;
    for (const listener of this.messageerrorListeners) listener(event);
  }
}

const metadata = (outputFrames: number): ConvolveMetadata => ({
  sampleRate: 48_000,
  channels: 2,
  durationSeconds: outputFrames / 48_000,
  outputFrames,
  detectedBeats: 0,
  detectedBpm: null,
  beatConfidence: null,
  appliedGainDb: 0,
  estimatedTruePeakDbtp: -1,
});

const validHeader = (frames: number): Uint8Array => {
  const header = new Uint8Array(68);
  const view = new DataView(header.buffer);
  header.set([82, 73, 70, 70], 0);
  view.setUint32(4, 60 + frames * 6, true);
  header.set([87, 65, 86, 69, 102, 109, 116, 32], 8);
  view.setUint32(16, 40, true);
  view.setUint16(20, 0xfffe, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, 48_000, true);
  view.setUint32(28, 288_000, true);
  view.setUint16(32, 6, true);
  view.setUint16(34, 24, true);
  view.setUint16(36, 22, true);
  view.setUint16(38, 24, true);
  view.setUint32(40, 3, true);
  header.set([1, 0, 0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113], 44);
  header.set([100, 97, 116, 97], 60);
  view.setUint32(64, frames * 6, true);
  return header;
};
const decodedPair = (): DecodedInputPair => ({
  a: {
    sampleRate: 48_000,
    frames: 2,
    left: new Float32Array([1, 2]),
    right: new Float32Array([3, 4]),
  },
  b: {
    sampleRate: 48_000,
    frames: 2,
    left: new Float32Array([5, 6]),
    right: new Float32Array([7, 8]),
  },
});

describe("WorkerClient", () => {
  it("reports worker creation and forwards private runtime diagnostics", async () => {
    const worker = new FakeWorker();
    const diagnostics: ConvolveDiagnosticEvent[] = [];
    const client = new WorkerClient(
      () => worker,
      (event) => diagnostics.push(event),
    );
    const pending = client.process(decodedPair(), false, normalizeOptions());
    const id = worker.posts[0]!.message.id;

    worker.emitMessage({
      type: "diagnostic",
      id,
      event: { type: "wasm-init-start" },
    });
    worker.emitMessage({
      type: "result",
      id,
      wav: Uint8Array.from([82, 73, 70, 70]).buffer,
      metadata: metadata(1),
    });
    await pending;

    expect(diagnostics).toEqual([
      { type: "worker-created" },
      { type: "wasm-init-start" },
    ]);
  });

  it("drops hostile diagnostic packets without changing a valid result", async () => {
    const worker = new FakeWorker();
    const diagnostics: ConvolveDiagnosticEvent[] = [];
    const client = new WorkerClient(
      () => worker,
      (event) => diagnostics.push(event),
    );
    const pending = client.process(decodedPair(), false, normalizeOptions());
    const id = worker.posts[0]!.message.id;
    const hostilePacket = { type: "diagnostic", id };
    Object.defineProperty(hostilePacket, "event", {
      get() {
        throw new Error("SECRET_EVENT_GETTER");
      },
    });
    const hostileEvent = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("SECRET_EVENT_PROXY");
        },
      },
    );

    worker.emitMessage(hostilePacket as unknown as WorkerResponse);
    worker.emitMessage({ type: "diagnostic", id, event: hostileEvent } as unknown as WorkerResponse);
    worker.emitMessage({
      type: "result",
      id,
      wav: Uint8Array.from([82, 73, 70, 70]).buffer,
      metadata: metadata(1),
    });

    const result = await pending;
    expect(result.metadata).toEqual(metadata(1));
    expect(Array.from(new Uint8Array(await result.wav.arrayBuffer()))).toEqual([
      82, 73, 70, 70,
    ]);
    expect(diagnostics).toEqual([{ type: "worker-created" }]);
  });

  it("reconstructs worker diagnostics from allowlisted own data only", async () => {
    const worker = new FakeWorker();
    const diagnostics: ConvolveDiagnosticEvent[] = [];
    const client = new WorkerClient(
      () => worker,
      (event) => diagnostics.push(event),
    );
    const pending = client.process(decodedPair(), false, normalizeOptions());
    const id = worker.posts[0]!.message.id;

    worker.emitMessage({
      type: "diagnostic",
      id,
      event: {
        type: "wasm-init-start",
        stack: "SECRET_STACK",
        binary: new Uint8Array([83, 69, 67, 82, 69, 84]),
        private: "SECRET_PRIVATE",
      },
    } as unknown as WorkerResponse);
    worker.emitMessage({
      type: "diagnostic",
      id,
      event: {
        type: "wasm-init-failure",
        error: {
          name: "Error",
          message: "failed core.wasm C:\\private\\take.wav",
          stack: "SECRET_ERROR_STACK",
          binary: new Uint8Array([1, 2, 3]),
          unknown: "SECRET_UNKNOWN",
        },
        stack: "SECRET_EVENT_STACK",
        unknown: "SECRET_EVENT_UNKNOWN",
      },
    } as unknown as WorkerResponse);
    worker.emitMessage({
      type: "result",
      id,
      wav: Uint8Array.from([82, 73, 70, 70]).buffer,
      metadata: metadata(1),
    });

    await expect(pending).resolves.toMatchObject({
      metadata: { outputFrames: 1 },
    });
    expect(diagnostics).toEqual([
      { type: "worker-created" },
      { type: "wasm-init-start" },
      {
        type: "wasm-init-failure",
        error: {
          name: "Error",
          message: "failed [redacted-file-name] [redacted-path]",
        },
      },
    ]);
    const json = JSON.stringify(diagnostics);
    for (const secret of [
      "core.wasm",
      "take.wav",
      "SECRET_STACK",
      "SECRET_PRIVATE",
      "SECRET_UNKNOWN",
      "SECRET_EVENT",
      "binary",
      "unknown",
    ]) {
      expect(json).not.toContain(secret);
    }
  });

  it("rejects message errors and succeeds with a replacement worker", async () => {
    const first = new FakeWorker();
    const second = new FakeWorker();
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const diagnostics: ConvolveDiagnosticEvent[] = [];
    const client = new WorkerClient(factory, (event) => diagnostics.push(event));

    const failed = client.process(decodedPair(), false, normalizeOptions());
    expect(first.messageerrorListeners).toHaveLength(1);
    first.emitMessageError({
      message: "failed C:\\private\\message.bin",
      secret: "SECRET_DATA",
    });
    await expect(failed).rejects.toMatchObject({ code: "PROCESSING_FAILED" });

    const next = client.process(decodedPair(), false, normalizeOptions());
    const id = second.posts[0]!.message.id;
    second.emitMessage({
      type: "result",
      id,
      wav: Uint8Array.from([82, 73, 70, 70]).buffer,
      metadata: metadata(1),
    });
    await expect(next).resolves.toMatchObject({ metadata: { outputFrames: 1 } });

    expect(diagnostics).toEqual([
      { type: "worker-created" },
      {
        type: "worker-messageerror",
        error: {
          name: "DataCloneError",
          message: "The processing worker emitted an unreadable message",
        },
      },
      { type: "worker-created" },
    ]);
  });

  it("reports sanitized worker errors", async () => {
    const worker = new FakeWorker();
    const diagnostics: ConvolveDiagnosticEvent[] = [];
    const client = new WorkerClient(
      () => worker,
      (event) => diagnostics.push(event),
    );
    const failed = client.process(decodedPair(), false, normalizeOptions());

    worker.emitError("failed C:\\private\\worker.ts");
    await expect(failed).rejects.toMatchObject({ code: "PROCESSING_FAILED" });
    expect(diagnostics).toEqual([
      { type: "worker-created" },
      {
        type: "worker-error",
        error: {
          name: "ConvolveError",
          code: "PROCESSING_FAILED",
          message: "failed [redacted-path]",
          lineNumber: 1,
          columnNumber: 1,
        },
      },
    ]);
  });
  it("keeps an observer-started replacement request off the failed worker", async () => {
    const first = new FakeWorker();
    const second = new FakeWorker();
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    let replacement: Promise<ConvolveResult> | undefined;
    let client!: WorkerClient;
    client = new WorkerClient(factory, (event) => {
      if (event.type === "worker-error") {
        replacement = client.process(decodedPair(), false, normalizeOptions());
        void replacement.catch(() => undefined);
      }
    });
    const failed = client.process(decodedPair(), false, normalizeOptions());

    first.emitError();
    await expect(failed).rejects.toMatchObject({ code: "PROCESSING_FAILED" });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(replacement).toBeDefined();
    const id = second.posts[0]!.message.id;
    second.emitMessage({
      type: "result",
      id,
      wav: Uint8Array.from([82, 73, 70, 70]).buffer,
      metadata: metadata(1),
    });
    await expect(replacement).resolves.toMatchObject({
      metadata: { outputFrames: 1 },
    });
  });
  it("samples aggregate output milestones and reports Blob completion", async () => {
    const worker = new FakeWorker();
    const diagnostics: ConvolveDiagnosticEvent[] = [];
    const client = new WorkerClient(
      () => worker,
      (event) => diagnostics.push(event),
    );
    const pending = client.process(decodedPair(), false, normalizeOptions());
    const id = worker.posts[0]!.message.id;
    worker.emitMessage({
      type: "output-start",
      id,
      header: validHeader(4).buffer as ArrayBuffer,
      metadata: metadata(4),
    });
    for (let sequence = 0; sequence < 4; sequence += 1) {
      worker.emitMessage({
        type: "output-chunk",
        id,
        sequence,
        offset: sequence,
        frames: 1,
        pcm: new Uint8Array(6).buffer,
      });
    }
    worker.emitMessage({ type: "result", id, metadata: metadata(4) });
    const result = await pending;

    expect(result.wav.size).toBe(92);
    expect(diagnostics).toEqual([
      { type: "worker-created" },
      { type: "output-start", outputFrames: 4 },
      { type: "output-milestone", fraction: 0.25, chunkCount: 1, pcmBytes: 6 },
      { type: "output-milestone", fraction: 0.5, chunkCount: 2, pcmBytes: 12 },
      { type: "output-milestone", fraction: 0.75, chunkCount: 3, pcmBytes: 18 },
      { type: "blob-complete", chunkCount: 4, pcmBytes: 24, wavBytes: 92 },
    ]);
  });

  it("cannot let a throwing diagnostic observer change output or metadata", async () => {
    const worker = new FakeWorker();
    const observer = vi.fn(() => {
      throw new Error("diagnostic observer failure");
    });
    const client = new WorkerClient(() => worker, observer);
    const pending = client.process(decodedPair(), false, normalizeOptions());
    const id = worker.posts[0]!.message.id;
    const header = validHeader(1);
    const pcm = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    worker.emitMessage({
      type: "output-start",
      id,
      header: header.buffer as ArrayBuffer,
      metadata: metadata(1),
    });
    worker.emitMessage({
      type: "output-chunk",
      id,
      sequence: 0,
      offset: 0,
      frames: 1,
      pcm: pcm.buffer,
    });
    worker.emitMessage({ type: "result", id, metadata: metadata(1) });

    const result = await pending;
    expect(result.metadata).toEqual(metadata(1));
    expect(Array.from(new Uint8Array(await result.wav.arrayBuffer()))).toEqual([
      ...header,
      ...pcm,
    ]);
    expect(observer).toHaveBeenCalled();
  });
  it("reports cancellation once for a failed streamed request", async () => {
    const worker = new FakeWorker();
    const diagnostics: ConvolveDiagnosticEvent[] = [];
    const client = new WorkerClient(
      () => worker,
      (event) => diagnostics.push(event),
    );
    const pending = client.process(decodedPair(), false, normalizeOptions());
    const id = worker.posts[0]!.message.id;
    worker.emitMessage({
      type: "output-start",
      id,
      header: validHeader(2).buffer as ArrayBuffer,
      metadata: metadata(2),
    });
    worker.emitMessage({
      type: "output-chunk",
      id,
      sequence: 0,
      offset: 1,
      frames: 1,
      pcm: new Uint8Array(6).buffer,
    });

    await expect(pending).rejects.toMatchObject({ code: "PROCESSING_FAILED" });
    expect(diagnostics.filter(({ type }) => type === "worker-cancelled")).toEqual([
      { type: "worker-cancelled" },
    ]);
  });
  it("creates one worker lazily and routes interleaved responses by request id", async () => {
    const worker = new FakeWorker();
    const factory = vi.fn(() => worker);
    const client = new WorkerClient(factory);
    const firstProgress: ConvolveProgress[] = [];
    const secondProgress: ConvolveProgress[] = [];

    expect(factory).not.toHaveBeenCalled();
    const first = client.process(decodedPair(), false, {
      ...normalizeOptions(),
      onProgress: (event) => firstProgress.push(event),
    });
    const second = client.process(decodedPair(), true, {
      ...normalizeOptions(),
      onProgress: (event) => secondProgress.push(event),
    });

    expect(factory).toHaveBeenCalledTimes(1);
    const firstId = worker.posts[0]?.message.id;
    const secondId = worker.posts[1]?.message.id;
    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    expect(firstId).not.toBe(secondId);

    worker.emitMessage({
      type: "progress",
      id: secondId!,
      event: { stage: "convolve", fraction: 0.55 },
    });
    worker.emitMessage({
      type: "progress",
      id: firstId!,
      event: { stage: "validate", fraction: 0.3 },
    });
    worker.emitMessage({
      type: "result",
      id: firstId!,
      wav: Uint8Array.from([82, 73, 70, 70]).buffer,
      metadata: metadata(3),
    });
    worker.emitMessage({
      type: "result",
      id: secondId!,
      wav: Uint8Array.from([87, 65, 86, 69]).buffer,
      metadata: metadata(4),
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstProgress).toEqual([{ stage: "validate", fraction: 0.3 }]);
    expect(secondProgress).toEqual([{ stage: "convolve", fraction: 0.55 }]);
    expect(firstResult.metadata.outputFrames).toBe(3);
    expect(secondResult.metadata.outputFrames).toBe(4);
  });

  it("transfers every decoded channel buffer and returns an audio/wav Blob", async () => {
    const worker = new FakeWorker();
    const client = new WorkerClient(() => worker);
    const decoded = decodedPair();
    const promise = client.process(decoded, false, normalizeOptions());
    const post = worker.posts[0];

    expect(post?.transfer).toEqual([
      decoded.a.left.buffer,
      decoded.a.right.buffer,
      decoded.b.left.buffer,
      decoded.b.right.buffer,
    ]);
    expect(post?.message.payload.options).toEqual({
      beatPan: null,
      panTransitionMs: 20,
      reverseCrossfadeMs: 5,
      targetDbtp: -1,
    });
    expect("onProgress" in (post?.message.payload.options ?? {})).toBe(false);

    worker.emitMessage({
      type: "result",
      id: post!.message.id,
      wav: Uint8Array.from([82, 73, 70, 70]).buffer,
      metadata: metadata(3),
    });
    const result = await promise;
    expect(result.wav.type).toBe("audio/wav");
    expect(Array.from(new Uint8Array(await result.wav.arrayBuffer()))).toEqual([
      82, 73, 70, 70,
    ]);
  });

  it("reconstructs stable worker errors as ConvolveError", async () => {
    const worker = new FakeWorker();
    const client = new WorkerClient(() => worker);
    const promise = client.process(decodedPair(), false, normalizeOptions());
    const id = worker.posts[0]!.message.id;

    worker.emitMessage({
      type: "error",
      id,
      error: {
        code: "INPUT_TOO_LARGE",
        message: "request exceeds the fixed limit",
        details: { estimatedBytes: 300_000_000, limitBytes: 268_435_456 },
      },
    });

    await expect(promise).rejects.toMatchObject({
      code: "INPUT_TOO_LARGE",
      details: { estimatedBytes: 300_000_000, limitBytes: 268_435_456 },
    });
  });

  it("assembles ordered PCM chunks into an audio/wav Blob and pulls one chunk at a time", async () => {
    const worker=new FakeWorker(); const client=new WorkerClient(()=>worker); const promise=client.process(decodedPair(),false,normalizeOptions()); const id=worker.posts[0]!.message.id; const header=validHeader(3);
    worker.emitMessage({type:"output-start",id,header:header.buffer,metadata:metadata(3)}); expect(worker.posts.at(-1)?.message).toMatchObject({type:"pull-output",id,sequence:0,offset:0,frames:3}); const pcm=Uint8Array.from({length:18},(_,index)=>index); worker.emitMessage({type:"output-chunk",id,sequence:0,offset:0,frames:3,pcm:pcm.buffer}); worker.emitMessage({type:"result",id,metadata:metadata(3)});
    const result=await promise; expect(result.wav.type).toBe("audio/wav"); expect(Array.from(new Uint8Array(await result.wav.arrayBuffer()))).toEqual([...header,...pcm]);
  });
  it("rejects malformed, duplicate, and stale output without retaining a partial Blob", async () => {
    const worker=new FakeWorker();const client=new WorkerClient(()=>worker);const promise=client.process(decodedPair(),false,normalizeOptions());const id=worker.posts[0]!.message.id;const header=validHeader(2);worker.emitMessage({type:"output-start",id,header:header.buffer,metadata:metadata(2)});worker.emitMessage({type:"output-chunk",id,sequence:0,offset:1,frames:1,pcm:new Uint8Array(6).buffer});await expect(promise).rejects.toMatchObject({code:"PROCESSING_FAILED"});expect(worker.posts.at(-1)?.message).toMatchObject({type:"cancel",id});worker.emitMessage({type:"output-chunk",id,sequence:0,offset:0,frames:1,pcm:new Uint8Array(6).buffer});
  });

  it("recreates a worker after a fatal failure and accepts a subsequent request", async () => {
    const first=new FakeWorker(),second=new FakeWorker();const factory=vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);const client=new WorkerClient(factory);const failed=client.process(decodedPair(),false,normalizeOptions());first.emitError();await expect(failed).rejects.toMatchObject({code:"PROCESSING_FAILED"});const next=client.process(decodedPair(),false,normalizeOptions());const id=second.posts[0]!.message.id;second.emitMessage({type:"result",id,wav:Uint8Array.from([82,73,70,70]).buffer,metadata:metadata(1)});await expect(next).resolves.toMatchObject({metadata:{outputFrames:1}});expect(factory).toHaveBeenCalledTimes(2);
  });
  it.each([
    ["gap", { sequence: 1, offset: 0, frames: 1, bytes: 6 }],
    ["wrong PCM byte length", { sequence: 0, offset: 0, frames: 1, bytes: 5 }],
    ["wrong frames", { sequence: 0, offset: 0, frames: 0, bytes: 0 }],
  ])("rejects a %s sequence/length violation", async (_name, bad) => {
    const worker=new FakeWorker();const client=new WorkerClient(()=>worker);const promise=client.process(decodedPair(),false,normalizeOptions());const id=worker.posts[0]!.message.id;const header=validHeader(2);worker.emitMessage({type:"output-start",id,header:header.buffer,metadata:metadata(2)});worker.emitMessage({type:"output-chunk",id,sequence:bad.sequence,offset:bad.offset,frames:bad.frames,pcm:new Uint8Array(bad.bytes).buffer});await expect(promise).rejects.toMatchObject({code:"PROCESSING_FAILED"});
  });

  it("does not issue the second pull until the first chunk arrives, and rejects premature totals", async () => {
    const worker=new FakeWorker();const client=new WorkerClient(()=>worker);const promise=client.process(decodedPair(),false,normalizeOptions());const id=worker.posts[0]!.message.id;const frames=65_537;const header=validHeader(frames);worker.emitMessage({type:"output-start",id,header:header.buffer,metadata:metadata(frames)});expect(worker.posts.filter(post=>post.message.type==="pull-output")).toHaveLength(1);worker.emitMessage({type:"result",id,metadata:metadata(frames)});await expect(promise).rejects.toMatchObject({code:"PROCESSING_FAILED"});
  });

  it("cancels and discards output when a progress callback throws, then handles a later request", async () => {
    const worker=new FakeWorker();const client=new WorkerClient(()=>worker);const failed=client.process(decodedPair(),false,{...normalizeOptions(),onProgress:()=>{throw new Error("observer failed");}});const id=worker.posts[0]!.message.id;worker.emitMessage({type:"progress",id,event:{stage:"validate",fraction:.3}});await expect(failed).rejects.toThrow("observer failed");expect(worker.posts.at(-1)?.message).toMatchObject({type:"cancel",id});const next=client.process(decodedPair(),false,normalizeOptions());const nextId=worker.posts.at(-1)!.message.id;worker.emitMessage({type:"result",id:nextId,wav:new Uint8Array([82,73,70,70]).buffer,metadata:metadata(1)});await expect(next).resolves.toMatchObject({metadata:{outputFrames:1}});
  });
  it("rejects duplicate chunks and output-start metadata/header disagreement", async () => {
    const worker=new FakeWorker();const client=new WorkerClient(()=>worker);const malformed=client.process(decodedPair(),false,normalizeOptions());const malformedId=worker.posts[0]!.message.id;const mismatch=validHeader(1);worker.emitMessage({type:"output-start",id:malformedId,header:mismatch.buffer,metadata:metadata(2)});await expect(malformed).rejects.toMatchObject({code:"PROCESSING_FAILED"});const promise=client.process(decodedPair(),false,normalizeOptions());const id=worker.posts.at(-1)!.message.id;const header=validHeader(2);worker.emitMessage({type:"output-start",id,header:header.buffer,metadata:metadata(2)});worker.emitMessage({type:"output-chunk",id,sequence:0,offset:0,frames:1,pcm:new Uint8Array(6).buffer});worker.emitMessage({type:"output-chunk",id,sequence:0,offset:0,frames:1,pcm:new Uint8Array(6).buffer});await expect(promise).rejects.toMatchObject({code:"PROCESSING_FAILED"});
  });

  it("keeps a replacement worker request alive when the old worker emits a late error", async () => {
    const first = new FakeWorker();
    const second = new FakeWorker();
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const client = new WorkerClient(factory);
    const failed = client.process(decodedPair(), false, normalizeOptions());
    first.emitError("first fatal");
    await expect(failed).rejects.toMatchObject({ code: "PROCESSING_FAILED" });

    const next = client.process(decodedPair(), false, normalizeOptions());
    const nextId = second.posts[0]!.message.id;
    first.emitError("late old-worker error");
    second.emitMessage({ type: "result", id: nextId, wav: new Uint8Array([82, 73, 70, 70]).buffer, metadata: metadata(1) });

    await expect(next).resolves.toMatchObject({ metadata: { outputFrames: 1 } });
  });

  it.each([
    ["RIFF size", (header: Uint8Array) => new DataView(header.buffer).setUint32(4, 0, true)],
    ["fmt marker", (header: Uint8Array) => header.set([66, 65, 68, 33], 12)],
    ["fmt size", (header: Uint8Array) => new DataView(header.buffer).setUint32(16, 16, true)],
    ["format tag", (header: Uint8Array) => new DataView(header.buffer).setUint16(20, 1, true)],
    ["channel count", (header: Uint8Array) => new DataView(header.buffer).setUint16(22, 1, true)],
    ["sample rate", (header: Uint8Array) => new DataView(header.buffer).setUint32(24, 44_100, true)],
    ["byte rate", (header: Uint8Array) => new DataView(header.buffer).setUint32(28, 1, true)],
    ["block alignment", (header: Uint8Array) => new DataView(header.buffer).setUint16(32, 1, true)],
    ["bits per sample", (header: Uint8Array) => new DataView(header.buffer).setUint16(34, 16, true)],
    ["extension size", (header: Uint8Array) => new DataView(header.buffer).setUint16(36, 0, true)],
    ["valid bits", (header: Uint8Array) => new DataView(header.buffer).setUint16(38, 16, true)],
    ["channel mask", (header: Uint8Array) => new DataView(header.buffer).setUint32(40, 0, true)],
    ["PCM GUID", (header: Uint8Array) => header[44] = 0],
    ["data marker", (header: Uint8Array) => header.set([66, 65, 68, 33], 60)],
    ["data size", (header: Uint8Array) => new DataView(header.buffer).setUint32(64, 0, true)],
  ])("rejects an output-start header with an invalid %s", async (_name, mutate) => {
    const worker = new FakeWorker();
    const client = new WorkerClient(() => worker);
    const pending = client.process(decodedPair(), false, normalizeOptions());
    const id = worker.posts[0]!.message.id;
    const header = validHeader(1);
    mutate(header);

    worker.emitMessage({ type: "output-start", id, header: header.buffer as ArrayBuffer, metadata: metadata(1) });

    await expect(pending).rejects.toMatchObject({ code: "PROCESSING_FAILED" });
    expect(worker.posts.at(-1)?.message).toMatchObject({ type: "cancel", id });
  });

  it.each([
    ["wrong sample rate", (value: ConvolveMetadata) => ({ ...value, sampleRate: 44_100 })],
    ["wrong channel count", (value: ConvolveMetadata) => ({ ...value, channels: 1 })],
    ["zero frame count", (value: ConvolveMetadata) => ({ ...value, outputFrames: 0 })],
    ["inconsistent duration", (value: ConvolveMetadata) => ({ ...value, durationSeconds: 1 })],
    ["non-finite duration", (value: ConvolveMetadata) => ({ ...value, durationSeconds: Number.NaN })],
    ["non-integral frame count", (value: ConvolveMetadata) => ({ ...value, outputFrames: 1.5 })],
    ["negative beat count", (value: ConvolveMetadata) => ({ ...value, detectedBeats: -1 })],
    ["non-finite BPM", (value: ConvolveMetadata) => ({ ...value, detectedBpm: Number.NaN })],
    ["non-finite confidence", (value: ConvolveMetadata) => ({ ...value, beatConfidence: Number.POSITIVE_INFINITY })],
    ["non-finite gain", (value: ConvolveMetadata) => ({ ...value, appliedGainDb: Number.NaN })],
    ["NaN true peak", (value: ConvolveMetadata) => ({ ...value, estimatedTruePeakDbtp: Number.NaN })],
    ["positive infinite true peak", (value: ConvolveMetadata) => ({ ...value, estimatedTruePeakDbtp: Number.POSITIVE_INFINITY })],
  ])("rejects output-start metadata with %s", async (_name, mutate) => {
    const worker = new FakeWorker();
    const client = new WorkerClient(() => worker);
    const pending = client.process(decodedPair(), false, normalizeOptions());
    const id = worker.posts[0]!.message.id;

    worker.emitMessage({ type: "output-start", id, header: validHeader(1).buffer, metadata: mutate(metadata(1)) });

    await expect(pending).rejects.toMatchObject({ code: "PROCESSING_FAILED" });
    expect(worker.posts.at(-1)?.message).toMatchObject({ type: "cancel", id });
  });

  it("accepts silent negative-infinite true-peak output and recovers after invalid peaks", async () => {
    const worker = new FakeWorker();
    const client = new WorkerClient(() => worker);
    const silent = client.process(decodedPair(), false, normalizeOptions());
    const silentId = worker.posts[0]!.message.id;
    const silentMetadata = { ...metadata(1), estimatedTruePeakDbtp: Number.NEGATIVE_INFINITY };

    worker.emitMessage({ type: "output-start", id: silentId, header: validHeader(1).buffer, metadata: silentMetadata });
    worker.emitMessage({ type: "output-chunk", id: silentId, sequence: 0, offset: 0, frames: 1, pcm: new Uint8Array(6).buffer });
    worker.emitMessage({ type: "result", id: silentId, metadata: silentMetadata });
    await expect(silent).resolves.toMatchObject({ metadata: { estimatedTruePeakDbtp: Number.NEGATIVE_INFINITY } });

    for (const invalidPeak of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const invalid = client.process(decodedPair(), false, normalizeOptions());
      const invalidId = worker.posts.at(-1)!.message.id;
      worker.emitMessage({ type: "output-start", id: invalidId, header: validHeader(1).buffer, metadata: { ...metadata(1), estimatedTruePeakDbtp: invalidPeak } });
      await expect(invalid).rejects.toMatchObject({ code: "PROCESSING_FAILED" });
      expect(worker.posts.at(-1)?.message).toMatchObject({ type: "cancel", id: invalidId });
    }

    const later = client.process(decodedPair(), false, normalizeOptions());
    const laterId = worker.posts.at(-1)!.message.id;
    worker.emitMessage({ type: "result", id: laterId, wav: new Uint8Array([82, 73, 70, 70]).buffer, metadata: metadata(1) });
    await expect(later).resolves.toMatchObject({ metadata: { outputFrames: 1 } });
  });
});
