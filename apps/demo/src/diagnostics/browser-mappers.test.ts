import { describe, expect, it } from "vitest";

import { copyInputs } from "./browser-mappers";

describe("copyInputs", () => {
  it.each(["audio/private-recording.mp3", "audio/private-recording.flac", "audio/private-recording.7z"])(
    "rejects filename-shaped bare MIME essence %s",
    (mimeType) => {
      expect(copyInputs([{ slot: "a", mimeType, encodedBytes: 1 }])).toEqual([
        { slot: "a", mimeType: "", encodedBytes: 1 },
      ]);
    },
  );
});
