export type BeatPanSource = "a" | "b" | null;

export type ConvolveStage =
  | "decode-a"
  | "decode-b"
  | "load-wasm"
  | "validate"
  | "convolve"
  | "beat-detect"
  | "beat-pan"
  | "append-reverse"
  | "normalize"
  | "encode"
  | "done";

export interface ConvolveProgress {
  stage: ConvolveStage;
  fraction: number;
}

export interface ConvolveOptions {
  beatPan?: BeatPanSource;
  panTransitionMs?: number;
  reverseCrossfadeMs?: number;
  targetDbtp?: number;
  onProgress?: (event: ConvolveProgress) => void;
}

export interface ConvolveMetadata {
  sampleRate: 48_000;
  channels: 2;
  durationSeconds: number;
  outputFrames: number;
  detectedBeats: number;
  detectedBpm: number | null;
  beatConfidence: number | null;
  appliedGainDb: number;
  estimatedTruePeakDbtp: number;
}

export interface ConvolveResult {
  wav: Blob;
  metadata: ConvolveMetadata;
}
