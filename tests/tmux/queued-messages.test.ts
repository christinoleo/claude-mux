import { describe, it, expect } from "vitest";
import { readQueuedMessages } from "../../src/tmux/pane.js";

const SEP = "─".repeat(80);
const STATUS = "  [░░░░░░░░░░]  4% ctx  Opus 5  probe";

/** A row as Claude Code paints a queued message: indented, on a background. */
function queued(text: string): string {
  return `  \x1b[38;5;239m\x1b[48;5;237m❯ \x1b[38;5;231m${text}\x1b[39m${" ".repeat(4)}\x1b[49m`;
}

/** A wrapped continuation of the row above it. */
function wrapped(text: string): string {
  return `  \x1b[48;5;237m\x1b[38;5;231m${text}\x1b[39m\x1b[49m`;
}

function pane(above: string[]): string {
  return [...above, SEP, "\x1b[38;5;246m❯  \x1b[39m", SEP, STATUS].join("\n");
}

describe("readQueuedMessages", () => {
  it("reads the message waiting above the prompt box", () => {
    expect(readQueuedMessages(pane(["\x1b[39m● working on it", "", queued("gamma third queued")]))).toEqual([
      "gamma third queued",
    ]);
  });

  it("reads several queued messages oldest first", () => {
    const content = pane([queued("alpha about parsers"), queued("beta about the websocket layer")]);
    expect(readQueuedMessages(content)).toEqual(["alpha about parsers", "beta about the websocket layer"]);
  });

  it("joins a message that wrapped onto a second row", () => {
    const content = pane([queued("this queued message runs past the eighty"), wrapped("column boundary")]);
    expect(readQueuedMessages(content)).toEqual(["this queued message runs past the eighty column boundary"]);
  });

  it("ignores submitted messages in scrollback, which start at column 0", () => {
    const submitted = "\x1b[38;5;239m\x1b[48;5;237m❯ \x1b[38;5;231malready sent\x1b[39m";
    expect(readQueuedMessages(pane([submitted, ""]))).toEqual([]);
  });

  it("returns nothing when the queue is empty", () => {
    expect(readQueuedMessages(pane(["\x1b[39m● all done", ""]))).toEqual([]);
  });

  it("returns nothing without escape codes to match", () => {
    expect(readQueuedMessages(["  ❯ looks queued but has no colour", SEP, "❯ ", SEP].join("\n"))).toEqual([]);
  });

  it("returns nothing when the pane has no prompt box", () => {
    expect(readQueuedMessages("scrollback only")).toEqual([]);
  });

  it("truncates a very long queued message", () => {
    const [msg] = readQueuedMessages(pane([queued("y".repeat(400))]));
    expect(msg).toHaveLength(301);
    expect(msg.endsWith("…")).toBe(true);
  });
});
