import {
  CLICK_TRACK_FRAMES,
  IMPULSE_RESPONSE_FRAMES,
  SAMPLE_RATE,
  SOURCE_A_FRAMES,
  clickTrackPcm16,
  impulseResponsePcm16,
  sourceAPcm16,
} from "./fixture-pcm.mjs";

export {
  CLICK_TRACK_FRAMES,
  IMPULSE_RESPONSE_FRAMES,
  SAMPLE_RATE,
  SOURCE_A_FRAMES,
};

function clampPcm16(sample: number): number {
  if (sample <= -1) return -32_768;
  if (sample >= 1) return 32_767;
  return Math.round(sample * 32_767);
}

export function encodePcm16Wav(channels: readonly (Float32Array | Int16Array)[]): Buffer {
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
      output.writeInt16LE(
        channel instanceof Int16Array
          ? channel[frame]!
          : clampPcm16(channel[frame]!),
        offset,
      );
      offset += bytesPerSample;
    }
  }
  return output;
}

export function makeSourceAWav(): Buffer {
  return encodePcm16Wav([sourceAPcm16()]);
}

export function makeImpulseResponseWav(): Buffer {
  return encodePcm16Wav([impulseResponsePcm16()]);
}

export function makeClickTrackWav(): Buffer {
  return encodePcm16Wav([clickTrackPcm16()]);
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
