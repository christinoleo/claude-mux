/**
 * Trading `! claude auth login` for `/login`.
 *
 * Run as a shell command, `claude auth login` asks for its code on a field no
 * keys reach: while it runs, whatever is typed lands in Claude Code's own box
 * and is queued as a message to Claude. `/login` takes the code in a field of
 * its own, which the sign-in card types into. So the command is stopped and
 * `/login` run in its place, the way a person at the pane would: Escape stops
 * the command and hands it back to the box in shell mode, Ctrl+U empties the
 * line and Backspace leaves shell mode. Each step reads the pane back before
 * the next, so `/login` never goes in while the command still runs or behind
 * text left in the box, where it would be queued or run together with it.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { readLoginScreen } from "../tmux/login.js";
import { capturePaneContentAsync, isPromptBoxClear, stripAnsi } from "../tmux/pane.js";

const execFileAsync = promisify(execFile);

export type ShellLoginResult = { ok: true } | { ok: false; error: string };

/** How the pane is read and typed into; tests hand in their own. */
export type PaneIo = {
  /** A capture with colour, or null when the pane cannot be read. */
  read: () => Promise<string | null>;
  /** Keys by tmux name, sent in order. */
  keys: (...names: string[]) => Promise<void>;
  /** Text typed as it is. */
  type: (text: string) => Promise<void>;
};

export function tmuxPane(target: string): PaneIo {
  const send = async (args: string[]) => {
    await execFileAsync("tmux", ["send-keys", "-t", target, ...args], { timeout: 1000 });
  };
  return {
    read: () => capturePaneContentAsync(target, true),
    keys: (...names) => send(names),
    type: (text) => send(["-l", text]),
  };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read the pane until `test` holds, for up to `ms`. */
async function waitFor(io: PaneIo, test: (raw: string) => boolean, ms: number, every: number): Promise<boolean> {
  for (const until = Date.now() + ms; ; ) {
    const raw = await io.read();
    if (raw !== null && test(raw)) return true;
    if (Date.now() > until) return false;
    await pause(every);
  }
}

const isShellLogin = (raw: string) => readLoginScreen(stripAnsi(raw))?.step === "shell";

/** Stop a running `! claude auth login` and start `/login` in its place. */
export async function shellLoginToLogin(io: PaneIo, every = 120): Promise<ShellLoginResult> {
  const raw = await io.read();
  if (raw === null) return { ok: false, error: "Could not read the pane" };
  if (!isShellLogin(raw)) return { ok: false, error: "No `claude auth login` is waiting in this pane" };

  await io.keys("Escape");
  if (!(await waitFor(io, (r) => !isShellLogin(r), 3000, every))) {
    return { ok: false, error: "The command did not stop" };
  }
  // Claude Code puts the command back into the box, in shell mode, as it stops it.
  await io.keys("C-u");
  await io.keys("BSpace");
  if (!(await waitFor(io, isPromptBoxClear, 2000, every))) {
    return { ok: false, error: "The box did not empty; open the terminal to sign in" };
  }
  await io.type("/login");
  await io.keys("Enter");
  return { ok: true };
}
