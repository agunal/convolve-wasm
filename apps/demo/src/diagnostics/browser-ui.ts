import type { DiagnosticSnapshot } from "./recorder";

export interface TextElement extends EventTarget {
  hidden: boolean | string;
  textContent: string | null;
}

export function setText(element: TextElement | null, text: string): void {
  try {
    if (element) element.textContent = text;
  } catch {
    // UI reporting must not affect audio processing.
  }
}

export function setHidden(
  element: TextElement | null,
  hidden: boolean,
): void {
  try {
    if (element) element.hidden = hidden;
  } catch {
    // UI reporting must not affect audio processing.
  }
}

export function storageMessage(
  state: DiagnosticSnapshot["storageState"],
): string {
  switch (state) {
    case "available":
      return "Browser storage available. Diagnostic records stay on this device.";
    case "quota-exceeded":
      return "Storage quota exceeded. New diagnostics remain in the current tab only.";
    case "recovered-corruption":
      return "Invalid diagnostic storage was cleared. New records stay on this device.";
    case "unsupported-schema":
      return "Unsupported diagnostic storage was cleared. New records stay on this device.";
    case "unavailable":
      return "Browser storage unavailable. Diagnostics remain in the current tab only.";
  }
}

export function summaryMessage(snapshot: DiagnosticSnapshot): string {
  const count = snapshot.sessions.length;
  if (count === 0) return "No retained diagnostic sessions.";
  const latest = snapshot.sessions[count - 1];
  const noun = count === 1 ? "session" : "sessions";
  if (!latest) return `${count} retained diagnostic ${noun}.`;
  const checkpoints = latest.checkpoints.length;
  const checkpointNoun = checkpoints === 1 ? "checkpoint" : "checkpoints";
  const boundary = latest.checkpoints.at(-1)?.type ?? "none";
  const updatedAt = summaryTimestamp(latest.updatedAt);
  return `${count} retained diagnostic ${noun}. Latest: ${latest.status}; last boundary ${boundary}; updated ${updatedAt} (${checkpoints} ${checkpointNoun}).`;
}

function summaryTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 32 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) return "unknown time";
  return value;
}
