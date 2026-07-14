export const SAMPLE_RATE = 48_000;
export const SOURCE_A_FRAMES = SAMPLE_RATE / 4;
export const IMPULSE_RESPONSE_FRAMES = SAMPLE_RATE / 10;
export const CLICK_TRACK_FRAMES = SAMPLE_RATE * 8;

function clampPcm16(sample: number): number {
  if (sample <= -1) return -32_768;
  if (sample >= 1) return 32_767;
  return Math.round(sample * 32_767);
}

export function encodePcm16Wav(channels: readonly Float32Array[]): Buffer {
  if (channels.length === 0 || channels.length > 2) {
    throw new Error("Fixtures support one or two channels");
  }
  const frames = channels[0]!.length;
  if (frames === 0 || channels.some((channel) => channel.length !== frames)) {
    throw new Error("Fixture channels must be non-empty and equal length");
  }

  const bytesPerSample = 2;
  const blockAlign = channels.length * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const output = Buffer.alloc(44 + dataBytes);
  output.write("RIFF", 0, "ascii");
  output.writeUInt32LE(36 + dataBytes, 4);
  output.write("WAVE", 8, "ascii");
  output.write("fmt ", 12, "ascii");
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(channels.length, 22);
  output.writeUInt32LE(SAMPLE_RATE, 24);
  output.writeUInt32LE(SAMPLE_RATE * blockAlign, 28);
  output.writeUInt16LE(blockAlign, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36, "ascii");
  output.writeUInt32LE(dataBytes, 40);

  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (const channel of channels) {
      output.writeInt16LE(clampPcm16(channel[frame]!), offset);
      offset += bytesPerSample;
    }
  }
  return output;
}

export function makeSourceAWav(): Buffer {
  const samples = new Float32Array(SOURCE_A_FRAMES);
  samples[0] = 0.8;
  for (let index = 1; index < samples.length; index += 1) {
    samples[index] = 0.16 * Math.sin((2 * Math.PI * 440 * index) / SAMPLE_RATE);
  }
  return encodePcm16Wav([samples]);
}

export function makeImpulseResponseWav(): Buffer {
  const samples = new Float32Array(IMPULSE_RESPONSE_FRAMES);
  samples[0] = 1;
  samples[Math.round(SAMPLE_RATE * 0.035)] = 0.35;
  samples[Math.round(SAMPLE_RATE * 0.07)] = -0.2;
  return encodePcm16Wav([samples]);
}

export function makeClickTrackWav(): Buffer {
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
  return encodePcm16Wav([samples]);
}

export interface WavHeader {
  audioFormat: number;
  isPcm: boolean;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataBytes: number;
  frames: number;
}

export function readWavHeader(bytes: Uint8Array): WavHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number, length: number): string =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (text(0, 4) !== "RIFF" || text(8, 4) !== "WAVE") {
    throw new Error("Expected RIFF/WAVE output");
  }

  let audioFormat: number | undefined;
  let isPcm: boolean | undefined;
  let channels: number | undefined;
  let sampleRate: number | undefined;
  let bitsPerSample: number | undefined;
  let dataBytes: number | undefined;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = text(offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const payload = offset + 8;
    if (chunkId === "fmt ") {
      audioFormat = view.getUint16(payload, true);
      channels = view.getUint16(payload + 2, true);
      sampleRate = view.getUint32(payload + 4, true);
      bitsPerSample = view.getUint16(payload + 14, true);
      if (audioFormat === 1) {
        isPcm = true;
      } else if (audioFormat === 0xfffe && chunkSize >= 40) {
        const pcmSubformat = new Uint8Array([
          0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00,
          0xaa, 0x00, 0x38, 0x9b, 0x71,
        ]);
        isPcm = pcmSubformat.every(
          (value, index) => bytes[payload + 24 + index] === value,
        );
      } else {
        isPcm = false;
      }
    } else if (chunkId === "data") {
      dataBytes = chunkSize;
      break;
    }
    offset = payload + chunkSize + (chunkSize % 2);
  }

  if (
    audioFormat === undefined ||
    isPcm === undefined ||
    channels === undefined ||
    sampleRate === undefined ||
    bitsPerSample === undefined ||
    dataBytes === undefined
  ) {
    throw new Error("WAV is missing fmt or data chunks");
  }
  const bytesPerFrame = channels * (bitsPerSample / 8);
  return {
    audioFormat,
    isPcm,
    channels,
    sampleRate,
    bitsPerSample,
    dataBytes,
    frames: dataBytes / bytesPerFrame,
  };
}
