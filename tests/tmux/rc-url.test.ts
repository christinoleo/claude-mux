import { describe, it, expect } from "vitest";
import { detectRemoteControlUrl } from "../../src/tmux/pane.js";

/** The dialog `/rc` draws, captured from a pane. */
const RC_DIALOG = [
  "  Remote Control",
  "  This session is available in the Claude mobile app and at https://claude.ai/code/session_015aRvjsPasoSn9UGH9VU2fh.",
  "    Disconnect this session",
  "    Show QR code  Scan with your phone to open this session",
  "  ❯ Continue",
  "  Enter to select · Esc to continue",
].join("\n");

describe("detectRemoteControlUrl", () => {
  it("reads the session URL without the sentence's full stop", () => {
    expect(detectRemoteControlUrl(RC_DIALOG)).toBe(
      "https://claude.ai/code/session_015aRvjsPasoSn9UGH9VU2fh"
    );
  });

  it("finds nothing in a pane without one", () => {
    expect(detectRemoteControlUrl("❯ \n──────\n  [░░░░] 0% ctx")).toBeNull();
  });
});
