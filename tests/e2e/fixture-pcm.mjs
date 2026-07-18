// These PCM16 frames are the shared source of truth for the browser fixtures
// and the generated-WASM hash harness. Keep the Float32Array assignment before
// quantization: it matches the original fixture construction exactly.
export const SAMPLE_RATE = 48_000;
export const SOURCE_A_FRAMES = SAMPLE_RATE / 4;
export const IMPULSE_RESPONSE_FRAMES = SAMPLE_RATE / 10;
export const CLICK_TRACK_FRAMES = SAMPLE_RATE * 8;

function clampPcm16(sample) {
  if (sample <= -1) return -32_768;
  if (sample >= 1) return 32_767;
  return Math.round(sample * 32_767);
}

function quantize(samples) {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    pcm[index] = clampPcm16(samples[index]);
  }
  return pcm;
}

export function sourceAPcm16() {
  const samples = new Float32Array(SOURCE_A_FRAMES);
  samples[0] = 0.8;
  for (let index = 1; index < samples.length; index += 1) {
    samples[index] = 0.16 * Math.sin((2 * Math.PI * 440 * index) / SAMPLE_RATE);
  }
  return quantize(samples);
}

export function impulseResponsePcm16() {
  const samples = new Float32Array(IMPULSE_RESPONSE_FRAMES);
  samples[0] = 1;
  samples[Math.round(SAMPLE_RATE * 0.035)] = 0.35;
  samples[Math.round(SAMPLE_RATE * 0.07)] = -0.2;
  return quantize(samples);
}

export function clickTrackPcm16() {
  const samples = new Float32Array(CLICK_TRACK_FRAMES);
  const period = SAMPLE_RATE / 2;
  const clickFrames = Math.round(SAMPLE_RATE * 0.005);
  for (let beat = 0; beat < samples.length; beat += period) {
    for (
      let offset = 0;
      offset < clickFrames && beat + offset < samples.length;
      offset += 1
    ) {
      const phase = offset / Math.max(1, clickFrames - 1);
      samples[beat + offset] = 0.9 * 0.5 * (1 - Math.cos(2 * Math.PI * phase));
    }
  }
  return quantize(samples);
}