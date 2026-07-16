import {
  CONVOLVE,
  ConvolveError,
  type BeatPanSource,
  type ConvolveMetadata,
} from "@agunal/convolve-wasm";

import "./styles.css";
import "./footer-icons.css";

function element<T extends Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Missing required element: ${selector}`);
  return value;
}

const audioA = element<HTMLInputElement>("#audio-a");
const audioB = element<HTMLInputElement>("#audio-b");
const appendReverse = element<HTMLInputElement>("#append-reverse");
const beatPan = element<HTMLSelectElement>("#beat-pan");
const panTransitionMs = element<HTMLInputElement>("#pan-transition-ms");
const reverseCrossfadeMs = element<HTMLInputElement>(
  "#reverse-crossfade-ms",
);
const targetDbtp = element<HTMLInputElement>("#target-dbtp");
const run = element<HTMLButtonElement>("#run");
const status = element<HTMLOutputElement>("#status");
const preview = element<HTMLAudioElement>("#preview");
const download = element<HTMLAnchorElement>("#download");

let resultUrl: string | undefined;

function numericValue(input: HTMLInputElement): number {
  return Number(input.value);
}

function selectedBeatPan(): BeatPanSource {
  if (beatPan.value === "a" || beatPan.value === "b") return beatPan.value;
  return null;
}

function setStatus(state: "idle" | "processing" | "done" | "error", text: string): void {
  status.dataset.state = state;
  status.textContent = text;
}

function clearMetadata(): void {
  delete status.dataset.outputFrames;
  delete status.dataset.detectedBeats;
  delete status.dataset.detectedBpm;
}

function exposeMetadata(metadata: ConvolveMetadata): void {
  status.dataset.outputFrames = String(metadata.outputFrames);
  status.dataset.detectedBeats = String(metadata.detectedBeats);
  status.dataset.detectedBpm =
    metadata.detectedBpm === null ? "" : metadata.detectedBpm.toFixed(2);
}

function revokeResultUrl(): void {
  if (resultUrl !== undefined) URL.revokeObjectURL(resultUrl);
  resultUrl = undefined;
}

run.addEventListener("click", async () => {
  const a = audioA.files?.[0];
  const b = audioB.files?.[0];
  clearMetadata();
  if (!a || !b) {
    setStatus("error", "INVALID_INPUT: Select both Audio A and Audio B.");
    return;
  }

  run.disabled = true;
  download.removeAttribute("href");
  download.removeAttribute("download");
  download.setAttribute("aria-disabled", "true");
  preview.removeAttribute("src");
  preview.load();
  revokeResultUrl();
  setStatus("processing", "Preparing audio…");

  try {
    const result = await CONVOLVE({ a, b }, appendReverse.checked, {
      beatPan: selectedBeatPan(),
      panTransitionMs: numericValue(panTransitionMs),
      reverseCrossfadeMs: numericValue(reverseCrossfadeMs),
      targetDbtp: numericValue(targetDbtp),
      onProgress: ({ stage, fraction }) => {
        const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
        setStatus("processing", `${stage} · ${percent}%`);
      },
    });

    resultUrl = URL.createObjectURL(result.wav);
    preview.src = resultUrl;
    preview.load();
    download.href = resultUrl;
    download.download = "convolved-audio.wav";
    download.setAttribute("aria-disabled", "false");
    exposeMetadata(result.metadata);
    const beats = `${result.metadata.detectedBeats} detected beat${
      result.metadata.detectedBeats === 1 ? "" : "s"
    }`;
    setStatus(
      "done",
      `Done · ${result.metadata.outputFrames} frames · ${beats} · ${result.metadata.estimatedTruePeakDbtp.toFixed(2)} dBTP`,
    );
  } catch (error) {
    if (error instanceof ConvolveError) {
      setStatus("error", `${error.code}: ${error.message}`);
    } else {
      const message = error instanceof Error ? error.message : "Unknown error";
      setStatus("error", `PROCESSING_FAILED: ${message}`);
    }
  } finally {
    run.disabled = false;
  }
});

window.addEventListener("beforeunload", revokeResultUrl);
