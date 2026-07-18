export const MIB = 1024 * 1024;

const SAMPLE_RATE = 48_000;
const BYTES_PER_STEREO_FRAME = 2 * Float32Array.BYTES_PER_ELEMENT;
const WAV_BYTES_PER_FRAME = 6;
const WAV_HEADER_BYTES = 68;
const PCM_CHUNK_BYTES = 393_216;
const FFT_BYTES_PER_FRAME = 24;
const RUNTIME_RESERVE_BYTES = 32 * MIB;
const MIN_BUDGET_BYTES = 64 * MIB;
const MAX_BUDGET_BYTES = 384 * MIB;
const BUDGET_BYTES_PER_GIB = 48 * MIB;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export interface MemoryBudget {
  budgetBytes: number;
  deviceMemoryGiB: number | null;
}

export interface FullPipelineMemoryInput {
  aFrames: number;
  bFrames: number;
  encodedInputBytes: number;
  appendReverse: boolean;
  reverseCrossfadeFrames: number;
  beatPan: boolean;
}

export interface MemoryPlan {
  outputFrames: number;
  finalFrames: number;
  fftFrames: number;
  estimatedBytes: number;
}

interface DeviceMemoryNavigator extends Navigator {
  readonly deviceMemory?: number;
}

function safeInteger(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : MAX_SAFE;
}

function safeAdd(...values: number[]): number {
  let total = 0;
  for (const rawValue of values) {
    const value = safeInteger(rawValue);
    if (value === MAX_SAFE || total > MAX_SAFE - value) return MAX_SAFE;
    total += value;
  }
  return total;
}

function safeMultiply(leftValue: number, rightValue: number): number {
  const left = safeInteger(leftValue);
  const right = safeInteger(rightValue);
  if (left === MAX_SAFE || right === MAX_SAFE) return MAX_SAFE;
  if (left !== 0 && right > Math.floor(MAX_SAFE / left)) return MAX_SAFE;
  return left * right;
}

function nextPowerOfTwo(value: number): number {
  const target = safeInteger(value);
  if (target === MAX_SAFE || target === 0) return MAX_SAFE;
  let result = 1;
  while (result < target) {
    if (result > Math.floor(MAX_SAFE / 2)) return MAX_SAFE;
    result *= 2;
  }
  return result;
}

export function defaultMemoryBudget(
  deviceMemoryGiB: number | undefined,
): MemoryBudget {
  if (
    deviceMemoryGiB === undefined ||
    !Number.isFinite(deviceMemoryGiB) ||
    deviceMemoryGiB <= 0
  ) {
    return {
      budgetBytes: MAX_BUDGET_BYTES,
      deviceMemoryGiB: null,
    };
  }
  const scaled = Math.round(deviceMemoryGiB * BUDGET_BYTES_PER_GIB);
  return {
    budgetBytes: Math.min(
      MAX_BUDGET_BYTES,
      Math.max(MIN_BUDGET_BYTES, scaled),
    ),
    deviceMemoryGiB,
  };
}

export function browserMemoryBudget(): MemoryBudget {
  const deviceMemoryGiB =
    typeof navigator === "undefined"
      ? undefined
      : (navigator as DeviceMemoryNavigator).deviceMemory;
  return defaultMemoryBudget(deviceMemoryGiB);
}

export function millisecondsToFrames(milliseconds: number): number {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return MAX_SAFE;
  return safeInteger(Math.round((milliseconds * SAMPLE_RATE) / 1000));
}

export function estimateFullPipelineMemory(
  input: FullPipelineMemoryInput,
): MemoryPlan {
  const inputFrames = safeAdd(input.aFrames, input.bFrames);
  const outputFrames =
    inputFrames === MAX_SAFE || inputFrames === 0
      ? MAX_SAFE
      : inputFrames - 1;
  const requestedCrossfade = safeInteger(input.reverseCrossfadeFrames);
  const effectiveCrossfade =
    input.appendReverse &&
    outputFrames !== MAX_SAFE &&
    requestedCrossfade !== MAX_SAFE
      ? Math.min(requestedCrossfade, Math.max(0, outputFrames - 1))
      : 0;
  const doubledOutput = safeMultiply(outputFrames, 2);
  const finalFrames = input.appendReverse
    ? doubledOutput === MAX_SAFE
      ? MAX_SAFE
      : doubledOutput - effectiveCrossfade
    : outputFrames;
  const fftFrames = nextPowerOfTwo(outputFrames);

  const decodedStereoBytes = safeMultiply(
    inputFrames,
    BYTES_PER_STEREO_FRAME,
  );
  const forwardAudioBytes = safeMultiply(
    outputFrames,
    BYTES_PER_STEREO_FRAME,
  );
  const fftWorkingBytes = safeMultiply(fftFrames, FFT_BYTES_PER_FRAME);
  const wavBytes = safeAdd(
    safeMultiply(finalFrames, WAV_BYTES_PER_FRAME),
    WAV_HEADER_BYTES,
  );

  return {
    outputFrames,
    finalFrames,
    fftFrames,
    estimatedBytes: safeAdd(
      input.encodedInputBytes,
      safeMultiply(decodedStereoBytes, 3),
      forwardAudioBytes,
      fftWorkingBytes,
      wavBytes,
      safeMultiply(PCM_CHUNK_BYTES, 2),
      RUNTIME_RESERVE_BYTES,
    ),
  };
}
