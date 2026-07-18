import type { DecodedInputPair, DecodedStereoAudio } from "./decode";
import { ConvolveError } from "./errors";
import type { NormalizedConvolveOptions } from "./options";
import type { ConvolveMetadata, ConvolveProgress, ConvolveResult } from "./types";
import { PCM24_CHUNK_FRAMES, WAV_HEADER_BYTES, type WorkerProcessOptions, type WorkerRequest, type WorkerResponse } from "./worker-protocol";

export interface WorkerLike { postMessage(message: WorkerRequest, transfer?: Transferable[]): void; addEventListener(type:"message",listener:(event:MessageEvent<WorkerResponse>)=>void):void; addEventListener(type:"error",listener:(event:ErrorEvent)=>void):void; terminate?():void; }
export type WorkerFactory=()=>WorkerLike;
interface PendingRequest { resolve:(result:ConvolveResult)=>void; reject:(error:unknown)=>void; onProgress?: (event:ConvolveProgress)=>void; output?: OutputAssembly; }
interface OutputAssembly { metadata:ConvolveMetadata; controller:ReadableStreamDefaultController<Uint8Array>; blob:Promise<Blob>; sequence:number; offset:number; }
function defaultWorkerFactory():WorkerLike{return new Worker("__CONVOLVE_WORKER_URL__",{type:"module"}) as WorkerLike;}
function transferableChannel(samples:Float32Array):Float32Array{return samples.buffer instanceof ArrayBuffer&&samples.byteOffset===0&&samples.byteLength===samples.buffer.byteLength?samples:new Float32Array(samples);}
function transferableAudio(audio:DecodedStereoAudio):DecodedStereoAudio{return {sampleRate:48_000,frames:audio.frames,left:transferableChannel(audio.left),right:transferableChannel(audio.right)};}
function asArrayBuffer(samples:Float32Array):ArrayBuffer{if(!(samples.buffer instanceof ArrayBuffer))throw new ConvolveError("PROCESSING_FAILED","Audio channel storage is not transferable");return samples.buffer;}
function protocolError(message:string):ConvolveError{return new ConvolveError("PROCESSING_FAILED",`Invalid worker output: ${message}`);}
const PCM_SUBFORMAT_GUID = [1, 0, 0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113];
function matchesBytes(header: ArrayBuffer, offset: number, expected: readonly number[]): boolean { const bytes=new Uint8Array(header,offset,expected.length); return expected.every((value,index)=>bytes[index]===value); }
function isFiniteNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function validateMetadata(metadata:ConvolveMetadata):void{
 const maxFrames=Math.floor((0xffff_ffff-60)/6);
 if(metadata.sampleRate!==48_000||metadata.channels!==2)throw protocolError("unsupported output format metadata");
 if(!Number.isSafeInteger(metadata.outputFrames)||metadata.outputFrames<1||metadata.outputFrames>maxFrames)throw protocolError("invalid output frame count metadata");
 if(!isFiniteNumber(metadata.durationSeconds)||metadata.durationSeconds!==metadata.outputFrames/48_000)throw protocolError("inconsistent duration metadata");
 if(!Number.isSafeInteger(metadata.detectedBeats)||metadata.detectedBeats<0)throw protocolError("invalid detected beat count metadata");
 if(metadata.detectedBpm!==null&&!isFiniteNumber(metadata.detectedBpm))throw protocolError("invalid BPM metadata");
 if(metadata.beatConfidence!==null&&!isFiniteNumber(metadata.beatConfidence))throw protocolError("invalid beat confidence metadata");
 if(!isFiniteNumber(metadata.appliedGainDb)||!isFiniteNumber(metadata.estimatedTruePeakDbtp))throw protocolError("invalid gain or peak metadata");
}
function validateHeader(header:ArrayBuffer, frames:number):void{
 if(header.byteLength!==WAV_HEADER_BYTES)throw protocolError("unexpected WAV header length");
 const v=new DataView(header);
 const dataBytes=frames*6;
 if(!matchesBytes(header,0,[82,73,70,70])||v.getUint32(4,true)!==60+dataBytes||!matchesBytes(header,8,[87,65,86,69])||!matchesBytes(header,12,[102,109,116,32]))throw protocolError("invalid RIFF/WAVE header");
 if(v.getUint32(16,true)!==40||v.getUint16(20,true)!==0xfffe||v.getUint16(22,true)!==2||v.getUint32(24,true)!==48_000||v.getUint32(28,true)!==288_000||v.getUint16(32,true)!==6||v.getUint16(34,true)!==24||v.getUint16(36,true)!==22||v.getUint16(38,true)!==24||v.getUint32(40,true)!==3||!matchesBytes(header,44,PCM_SUBFORMAT_GUID)||!matchesBytes(header,60,[100,97,116,97])||v.getUint32(64,true)!==dataBytes)throw protocolError("invalid WAVE_FORMAT_EXTENSIBLE PCM24 header");
}

export class WorkerClient { private worker:WorkerLike|undefined; private nextRequestId=1; private readonly pending=new Map<string,PendingRequest>(); constructor(private readonly workerFactory:WorkerFactory=defaultWorkerFactory){}
 process(decoded:DecodedInputPair,appendReverse:boolean,options:NormalizedConvolveOptions):Promise<ConvolveResult>{const worker=this.getWorker();const id=`convolve-${this.nextRequestId++}`;const a=transferableAudio(decoded.a),b=transferableAudio(decoded.b);const {onProgress,...workerOptions}=options;const request:WorkerRequest={type:"process",id,payload:{a,b,appendReverse,options:workerOptions satisfies WorkerProcessOptions}};const transfer:Transferable[]=[asArrayBuffer(a.left),asArrayBuffer(a.right),asArrayBuffer(b.left),asArrayBuffer(b.right)];return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject,onProgress});try{worker.postMessage(request,transfer);}catch(cause){this.pending.delete(id);reject(cause instanceof ConvolveError?cause:new ConvolveError("PROCESSING_FAILED","Could not transfer audio to the processing worker",undefined,cause));}});}
 private getWorker():WorkerLike{if(this.worker)return this.worker;const worker=this.workerFactory();worker.addEventListener("message",event=>this.handleMessage(event.data));worker.addEventListener("error",event=>{if(this.worker!==worker)return;const message=event.message||"The processing worker failed";this.worker=undefined;try{worker.terminate?.();}finally{this.rejectAll(new ConvolveError("PROCESSING_FAILED",message,{fileName:event.filename,lineNumber:event.lineno,columnNumber:event.colno}));}});this.worker=worker;return worker;}
 private post(message:WorkerRequest):void{try{this.getWorker().postMessage(message);}catch(cause){this.fail(message.id,cause instanceof ConvolveError?cause:new ConvolveError("PROCESSING_FAILED","Could not communicate with the processing worker",undefined,cause));}}
 private handleMessage(response:WorkerResponse):void{const pending=this.pending.get(response.id);if(!pending)return;try{if(response.type==="progress"){pending.onProgress?.(response.event);return;}if(response.type==="error"){this.fail(response.id,new ConvolveError(response.error.code,response.error.message,response.error.details));return;}if(response.type==="output-start"){if(pending.output)throw protocolError("duplicate output-start");validateMetadata(response.metadata);validateHeader(response.header,response.metadata.outputFrames);let controller!:ReadableStreamDefaultController<Uint8Array>;const stream=new ReadableStream<Uint8Array>({start(value){controller=value;}});const blob=new Response(stream,{headers:{"Content-Type":"audio/wav"}}).blob(); void blob.catch(() => undefined); controller.enqueue(new Uint8Array(response.header));pending.output={metadata:response.metadata,controller,blob,sequence:0,offset:0};this.pull(response.id,pending.output);return;}if(response.type==="output-chunk"){const output=pending.output;if(!output)throw protocolError("chunk before output-start");if(response.sequence!==output.sequence||response.offset!==output.offset||response.frames<=0||response.frames>PCM24_CHUNK_FRAMES||response.pcm.byteLength!==response.frames*6||response.offset+response.frames>output.metadata.outputFrames)throw protocolError("out-of-order or malformed PCM chunk");output.controller.enqueue(new Uint8Array(response.pcm));output.sequence++;output.offset+=response.frames;if(output.offset<output.metadata.outputFrames)this.pull(response.id,output);return;}if(response.wav){ // legacy fallback used only with old worker assets
 this.pending.delete(response.id);pending.resolve({wav:new Blob([response.wav],{type:"audio/wav"}),metadata:response.metadata});return;}
 const output=pending.output;if(!output||output.offset!==output.metadata.outputFrames||!sameMetadata(output.metadata,response.metadata))throw protocolError("result arrived before complete output");output.controller.close();this.pending.delete(response.id);void output.blob.then(wav=>pending.resolve({wav,metadata:response.metadata}),cause=>pending.reject(cause));}catch(cause){this.fail(response.id,cause);}}
 private pull(id:string,output:OutputAssembly):void{const remaining=output.metadata.outputFrames-output.offset;this.post({type:"pull-output",id,sequence:output.sequence,offset:output.offset,frames:Math.min(PCM24_CHUNK_FRAMES,remaining)});}
 private fail(id:string,cause:unknown):void{const pending=this.pending.get(id);if(!pending)return;this.pending.delete(id);try{pending.output?.controller.error(cause);}finally{this.postCancel(id);pending.reject(cause);}}
 private postCancel(id:string):void{try{this.worker?.postMessage({type:"cancel",id});}catch{/* terminal failure is already reported */}}
 private rejectAll(error:ConvolveError):void{for(const [id,pending] of this.pending){try{pending.output?.controller.error(error);}finally{pending.reject(error);this.pending.delete(id);}}}
}
function sameMetadata(a:ConvolveMetadata,b:ConvolveMetadata):boolean{return a.sampleRate===b.sampleRate&&a.channels===b.channels&&a.outputFrames===b.outputFrames&&a.durationSeconds===b.durationSeconds&&a.detectedBeats===b.detectedBeats&&a.detectedBpm===b.detectedBpm&&a.beatConfidence===b.beatConfidence&&a.appliedGainDb===b.appliedGainDb&&a.estimatedTruePeakDbtp===b.estimatedTruePeakDbtp;}
