import { ConvolveError } from "@takana-labs/convolve-wasm";

const MIB = 1024 * 1024;

function byteDetail(
  details: Record<string, unknown> | undefined,
  key: string,
): number | null {
  const value = details?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function formatConvolveError(error: ConvolveError): string {
  if (error.code === "INPUT_TOO_LARGE") {
    const estimatedBytes = byteDetail(error.details, "estimatedBytes");
    const limitBytes = byteDetail(error.details, "limitBytes");
    if (estimatedBytes !== null && limitBytes !== null) {
      const estimatedMib = Math.round(estimatedBytes / MIB);
      const limitMib = Math.floor(limitBytes / MIB);
      const suggestions = ["shorter files"];
      if (error.details?.beatPan === "a" || error.details?.beatPan === "b") {
        suggestions.push("turn off beat panning");
      }
      if (error.details?.appendReverse === true) {
        suggestions.push("disable reverse append");
      }
      const guidance =
        suggestions.length === 1
          ? suggestions[0]
          : suggestions.length === 2
            ? `${suggestions[0]} or ${suggestions[1]}`
            : `${suggestions[0]}, ${suggestions[1]}, or ${suggestions[2]}`;
      return (
        `INPUT_TOO_LARGE: This render needs about ${estimatedMib} MiB, ` +
        `above this device's ${limitMib} MiB safe limit. Try ${guidance}.`
      );
    }
  }

  return `${error.code}: ${error.message}`;
}
