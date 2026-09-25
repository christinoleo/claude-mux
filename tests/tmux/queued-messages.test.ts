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

/**
 * Claude Code from September 2026 on: a queued row starts at column 0 like a
 * sent one, the queue sits above the spinner rather than the prompt box, and
 * it closes with the key that sends it early. Captured with `capture-pane -e`
 * from a 200-column pane.
 */
const SPINNER_QUEUE = [
  "\u001b[38;5;246m\u001b[49m \u001b[39m \u001b[1mBash\u001b[0m(python3 -c \"import time; time.sleep(45); print(1)\")",
  "\u001b[38;5;246m  ⎿  Running… (15s · timeout 2m)\u001b[39m",
  "     \u001b[38;5;246m(ctrl+b ctrl+b (twice) to run in background)\u001b[39m",
  "",
  "\u001b[38;5;239m\u001b[48;5;237m❯ \u001b[38;5;246mQ1 (Estrutura): agreed, go with your recommendation. This is a long queued message that should wrap across more than one line of the pane so we can see how continuation rows are drawn by the new \u001b[39m",
  "  \u001b[38;5;246mqueue UI in Claude Code.\u001b[39m",
  "\u001b[49m",
  "\u001b[38;5;239m\u001b[48;5;237m❯ \u001b[38;5;246msecond queued message\u001b[39m",
  "\u001b[49m  \u001b[38;5;246mctrl+x ctrl+s to send now\u001b[39m",
  "",
  "\u001b[38;5;174m·\u001b[39m \u001b[38;5;180mFermenting…\u001b[38;5;174m \u001b[38;5;246m(19s · ↓\u001b[39m \u001b[38;5;246m262 tokens)\u001b[39m",
  "\u001b[38;5;246m  ⎿  Tip: Hit shift+tab to cycle between manual mode, auto-accept edit mode, and plan mode\u001b[39m",
  "",
  "\u001b[38;5;244m────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "\u001b[38;5;246m❯ \u001b[2m\u001b[39mPress up to edit queued messages\u001b[0m",
  "\u001b[38;5;244m────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "\u001b[39m  \u001b[32m[██░░░░░░░░]\u001b[38;5;246m  \u001b[1m20%\u001b[0m\u001b[38;5;246m ctx  \u001b[2mHaiku 4.5\u001b[0m\u001b[38;5;246m  \u001b[36mcmux-q\u001b[39m",
  "  \u001b[38;5;211m⏵⏵\u001b[39m \u001b[38;5;211mbypass\u001b[39m \u001b[38;5;211mpermissions\u001b[39m \u001b[38;5;211mon\u001b[38;5;246m (shift+tab\u001b[39m \u001b[38;5;246mto\u001b[39m \u001b[38;5;246mcycle)\u001b[39m \u001b[38;5;246m·\u001b[39m \u001b[38;5;246m←\u001b[39m \u001b[38;5;246mfor\u001b[39m \u001b[38;5;246magents\u001b[39m",
].join("\n");

describe("readQueuedMessages, queue above the spinner", () => {
  it("reads each queued message, joining a wrapped one", () => {
    expect(readQueuedMessages(SPINNER_QUEUE)).toEqual([
      "Q1 (Estrutura): agreed, go with your recommendation. This is a long queued message that should wrap across more than one line of the pane so we can see how continuation rows are drawn by the new queue UI in Claude Code.",
      "second queued message",
    ]);
  });

  it("leaves out a message already sent, which is drawn in full white", () => {
    const sent = "\x1b[38;5;239m\x1b[48;5;237m❯ \x1b[38;5;231malready sent\x1b[39m";
    const content = SPINNER_QUEUE.replace(/^.*Bash\(python3.*$/m, (line) => `${sent}\n\x1b[49m\n${line}`);
    expect(readQueuedMessages(content)).toHaveLength(2);
    const lines = SPINNER_QUEUE.split("\n");
    const firstRow = lines.findIndex((l) => l.includes("Q1 (Estrutura)"));
    const direct = [...lines.slice(0, firstRow), sent, "\x1b[49m", ...lines.slice(firstRow)].join("\n");
    expect(readQueuedMessages(direct)).toHaveLength(2);
  });
});
