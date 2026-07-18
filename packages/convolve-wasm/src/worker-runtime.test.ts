import { describe, expect, it, vi } from "vitest";

import type { WorkerRequest, WorkerResponse } from "./worker-protocol";
import { createWorkerRequestHandler } from "./worker-runtime";

const request = (id: string): WorkerRequest => ({
  type: "process",
  id,
  payload: {
    a: {
      sampleRate: 48_000,
      frames: 1,
      left: new Float32Array([1]),
      right: new Float32Array([1]),
    },
    b: {
      sampleRate: 48_000,
      frames: 1,
      left: new Float32Array([1]),
      right: new Float32Array([1]),
    },
    appendReverse: false,
    options: {
      beatPan: null,
      panTransitionMs: 20,
      reverseCrossfadeMs: 5,
      targetDbtp: -1,
    },
  },
});

describe("worker request runtime", () => {
  it("loads WASM once, forwards progress, copies bytes, and frees results", async () => {
    const free = vi.fn();
    const processAudio = vi.fn(
      (
        _aLeft: Float32Array,
        _aRight: Float32Array,
        _bLeft: Float32Array,
        _bRight: Float32Array,
        _appendReverse: boolean,
        _options: unknown,
        progress?: (stage: string, fraction: number) => void,
      ) => {
        progress?.("validate", 0.3);
        return {
          sampleRate: 48_000,
          channels: 2,
          durationSeconds: 1 / 48_000,
          outputFrames: 1,
          detectedBeats: 0,
          detectedBpm: undefined,
          beatConfidence: undefined,
          appliedGainDb: 0,
          estimatedTruePeakDbtp: -1,
          wav_bytes: () => Uint8Array.from([82, 73, 70, 70]),
          free,
        };
      },
    );
    const loadWasm = vi.fn(async () => ({ process_audio_wasm: processAudio }));
    const posts: Array<{ response: WorkerResponse; transfer: Transferable[] }> = [];
    const handle = createWorkerRequestHandler({
      loadWasm,
      postMessage: (response, transfer = []) => posts.push({ response, transfer }),
    });

    await handle(request("one"));
    await handle(request("two"));

    expect(loadWasm).toHaveBeenCalledTimes(1);
    expect(processAudio).toHaveBeenCalledTimes(2);
    expect(free).toHaveBeenCalledTimes(2);
    expect(posts[0]?.response).toEqual({
      type: "progress",
      id: "one",
      event: { stage: "load-wasm", fraction: 0.25 },
    });
    expect(posts[1]?.response).toEqual({
      type: "progress",
      id: "one",
      event: { stage: "validate", fraction: 0.3 },
    });
    const firstResult = posts[2];
    expect(firstResult?.response).toMatchObject({
      type: "result",
      id: "one",
      metadata: {
        sampleRate: 48_000,
        channels: 2,
        outputFrames: 1,
        detectedBpm: null,
        beatConfidence: null,
      },
    });
    if (firstResult?.response.type !== "result") {
      throw new Error("expected a result response");
    }
    expect(firstResult.transfer).toEqual([firstResult.response.wav]);
    expect(Array.from(new Uint8Array(firstResult.response.wav))).toEqual([
      82, 73, 70, 70,
    ]);
  });

  it("preserves structured processing failures and classifies init failures", async () => {
    const structuredPosts: WorkerResponse[] = [];
    const structured = createWorkerRequestHandler({
      loadWasm: async () => ({
        process_audio_wasm: () => {
          throw {
            code: "INPUT_TOO_LARGE",
            message: "too large",
            details: { limitBytes: 268_435_456 },
          };
        },
      }),
      postMessage: (response) => structuredPosts.push(response),
    });
    await structured(request("structured"));
    expect(structuredPosts.at(-1)).toEqual({
      type: "error",
      id: "structured",
      error: {
        code: "INPUT_TOO_LARGE",
        message: "too large",
        details: { limitBytes: 268_435_456 },
      },
    });

    const initPosts: WorkerResponse[] = [];
    const initFailure = createWorkerRequestHandler({
      loadWasm: async () => {
        throw new Error("network blocked");
      },
      postMessage: (response) => initPosts.push(response),
    });
    await initFailure(request("init"));
    expect(initPosts.at(-1)).toEqual({
      type: "error",
      id: "init",
      error: {
        code: "WASM_INIT_FAILED",
        message: "network blocked",
      },
    });
  });

  it("copies input into a two-phase job, releases request channels, and streams one transferred chunk", async () => {
    const freeJob = vi.fn(); const freeSession = vi.fn(); const header = new Uint8Array(68); header.set([82,73,70,70],0); header.set([87,65,86,69],8); header.set([100,97,116,97],60); new DataView(header.buffer).setUint32(64,6,true); const pcm=Uint8Array.from([1,2,3,4,5,6]);
    const Job = vi.fn(function () { return { free: freeJob, process: () => ({ sampleRate:48_000, channels:2, durationSeconds:1/48_000, outputFrames:1, detectedBeats:0, detectedBpm:undefined, beatConfidence:undefined, appliedGainDb:0, estimatedTruePeakDbtp:-1, wav_header:()=>header, pcm24_chunk:()=>pcm, free:freeSession }) }; });
    const posts: Array<{ response: WorkerResponse; transfer: Transferable[] }> = [];
    const handle=createWorkerRequestHandler({loadWasm:async()=>({WasmProcessJob: Job as never}),postMessage:(response,transfer=[])=>posts.push({response,transfer})}); const input=request("stream"); await handle(input);
    expect(input.payload.a.left.byteLength).toBe(0); const start=posts.find(post=>post.response.type==="output-start")!; expect(start.transfer).toEqual([(start.response as Extract<WorkerResponse,{type:"output-start"}>).header]);
    await handle({type:"pull-output",id:"stream",sequence:0,offset:0,frames:1}); const chunk=posts.find(post=>post.response.type==="output-chunk")!; expect(chunk.transfer).toEqual([(chunk.response as Extract<WorkerResponse,{type:"output-chunk"}>).pcm]); expect(freeSession).toHaveBeenCalledOnce();expect(freeJob).toHaveBeenCalledOnce();
  });
  it("holds later process requests until the final pull, and emits encode/done only then", async () => {
    const frees=vi.fn(); const header=Uint8Array.from({length:68},(_,i)=>i===0?82:i===1?73:i===2?70:i===3?70:i===8?87:i===9?65:i===10?86:i===11?69:i===60?100:i===61?97:i===62?116:i===63?97:0);new DataView(header.buffer).setUint32(64,6,true);
    const Job=vi.fn(function(){return {free:frees,process:()=>({sampleRate:48_000,channels:2,durationSeconds:1/48_000,outputFrames:1,detectedBeats:0,detectedBpm:undefined,beatConfidence:undefined,appliedGainDb:0,estimatedTruePeakDbtp:-1,wav_header:()=>header,pcm24_chunk:()=>Uint8Array.from([1,2,3,4,5,6]),free:frees})};});const posts:WorkerResponse[]=[];const handle=createWorkerRequestHandler({loadWasm:async()=>({WasmProcessJob:Job as never}),postMessage:r=>posts.push(r)});
    await handle(request("first")); await handle(request("second")); expect(posts.filter(r=>r.type==="output-start").map(r=>r.id)).toEqual(["first"]);expect(posts.filter(r=>r.type==="progress"&&["encode","done"].includes(r.event.stage))).toHaveLength(0);
    await handle({type:"pull-output",id:"first",sequence:0,offset:0,frames:1}); await new Promise(resolve=>setTimeout(resolve,0));expect(posts.filter(r=>r.type==="output-start").map(r=>r.id)).toEqual(["first","second"]);expect(posts.filter(r=>r.type==="progress"&&["encode","done"].includes(r.event.stage)).map(r=>(r as Extract<WorkerResponse,{type:"progress"}>).event.stage)).toEqual(["encode","done"]);
  });

  it("rejects duplicate/malformed pulls and cleans up an active cancellation", async () => {
    const free=vi.fn();const header=new Uint8Array(68);header.set([82,73,70,70],0);header.set([87,65,86,69],8);header.set([100,97,116,97],60);new DataView(header.buffer).setUint32(64,12,true);const Job=vi.fn(function(){return {free,process:()=>({sampleRate:48_000,channels:2,durationSeconds:2/48_000,outputFrames:2,detectedBeats:0,detectedBpm:undefined,beatConfidence:undefined,appliedGainDb:0,estimatedTruePeakDbtp:-1,wav_header:()=>header,pcm24_chunk:()=>new Uint8Array(6),free})};});const posts:WorkerResponse[]=[];const handle=createWorkerRequestHandler({loadWasm:async()=>({WasmProcessJob:Job as never}),postMessage:r=>posts.push(r)});await handle(request("bad"));await handle({type:"pull-output",id:"bad",sequence:0,offset:1,frames:1});expect(posts.at(-1)).toMatchObject({type:"error",id:"bad"});expect(free).toHaveBeenCalledTimes(2);await handle(request("cancel"));await handle({type:"cancel",id:"cancel"});expect(posts.at(-1)).toMatchObject({type:"error",id:"cancel"});expect(free).toHaveBeenCalledTimes(4);
  });
  it("cancels a queued request promptly and frees a job when its progress callback fails", async () => {
    const header=new Uint8Array(68);header.set([82,73,70,70],0);header.set([87,65,86,69],8);header.set([100,97,116,97],60);new DataView(header.buffer).setUint32(64,6,true);const free=vi.fn();let invokeBadProgress=false;const Job=vi.fn(function(){return {free,process:(progress?: (stage:string,fraction:number)=>void)=>{if(invokeBadProgress)progress?.("not-a-stage",.5);return {sampleRate:48_000,channels:2,durationSeconds:1/48_000,outputFrames:1,detectedBeats:0,detectedBpm:undefined,beatConfidence:undefined,appliedGainDb:0,estimatedTruePeakDbtp:-1,wav_header:()=>header,pcm24_chunk:()=>new Uint8Array(6),free};}};});const posts:WorkerResponse[]=[];const handle=createWorkerRequestHandler({loadWasm:async()=>({WasmProcessJob:Job as never}),postMessage:r=>posts.push(r)});await handle(request("active"));await handle(request("queued"));await handle({type:"cancel",id:"queued"});expect(posts.at(-1)).toMatchObject({type:"error",id:"queued"});await handle({type:"cancel",id:"active"});invokeBadProgress=true;await handle(request("callback"));expect(posts.at(-1)).toMatchObject({type:"error",id:"callback"});expect(free).toHaveBeenCalled();
  });

  it("cancels a request while WASM is loading and starts the next request after loading settles", async () => {
    let resolveWasm!: (module: unknown) => void;
    const loadWasm = vi.fn(() => new Promise((resolve) => { resolveWasm = resolve; }));
    const posts: WorkerResponse[] = [];
    const free = vi.fn();
    const Job = vi.fn(function () {
      return {
        free,
        process: () => ({
          sampleRate: 48_000,
          channels: 2,
          durationSeconds: 1 / 48_000,
          outputFrames: 1,
          detectedBeats: 0,
          detectedBpm: undefined,
          beatConfidence: undefined,
          appliedGainDb: 0,
          estimatedTruePeakDbtp: -1,
          wav_header: () => new Uint8Array(68),
          pcm24_chunk: () => new Uint8Array(6),
          free,
        }),
      };
    });
    const handle = createWorkerRequestHandler({
      loadWasm: loadWasm as () => Promise<never>,
      postMessage: (response) => posts.push(response),
    });

    void handle(request("cancel-during-load"));
    await handle({ type: "cancel", id: "cancel-during-load" });
    void handle(request("after-load"));
    resolveWasm({ WasmProcessJob: Job });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(posts).toContainEqual(expect.objectContaining({ type: "error", id: "cancel-during-load" }));
    expect(posts.filter((post) => post.type === "output-start").map((post) => post.id)).toEqual(["after-load"]);
    expect(Job).toHaveBeenCalledTimes(1);
    await handle({ type: "pull-output", id: "after-load", sequence: 0, offset: 0, frames: 1 });
    expect(posts.at(-1)).toMatchObject({ type: "result", id: "after-load" });
  });
});
