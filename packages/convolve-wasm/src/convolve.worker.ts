import wasmUrl from "./wasm/convolve_core_bg.wasm?url&no-inline";

import { createWorkerRequestHandler } from "./worker-runtime";
import type { WasmModuleLike } from "./worker-runtime";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol";

async function loadWasm(): Promise<WasmModuleLike> {
  const wasm = await import("./wasm/convolve_core.js");
  await wasm.default(wasmUrl);
  return wasm;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;
const handleRequest = createWorkerRequestHandler({
  loadWasm,
  postMessage(response: WorkerResponse, transfer: Transferable[] = []) {
    scope.postMessage(response, transfer);
  },
});

let queue = Promise.resolve();
scope.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  if (event.data?.type !== "process") return;
  queue = queue.then(() => handleRequest(event.data));
});
