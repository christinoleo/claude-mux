/**
 * Dialogs held open for the dashboard. A `PermissionRequest` hook call stays
 * unanswered while the terminal's dialog is on screen, so whichever of a person
 * here or a person there answers first decides; Claude Code ignores a later
 * decision. Passing, which leaves the terminal dialog as the only way to answer,
 * is what every ending but a person's press comes to.
 *
 * The only way to `allow` is `answer()`, which nothing but a press on the
 * dashboard's card calls: this could otherwise approve a critical-path removal
 * with nobody there. That is what this code does, not a wall: a process of the
 * same user can forge a request, as it can type into the pane with `tmux`.
 */

import { randomUUID } from "crypto";
import { isDeepStrictEqual } from "util";
import { parseAskQuestions } from "../transcript/parser.js";
import type { DialogHold } from "../types/ws-messages.js";

export const HOLD_LIMIT_MS = 10 * 60_000;

/**
 * Reads of the pane in a row without the dialog it had drawn before it counts
 * as answered. More than one, as a redraw can drop it for a tick.
 */
const MISSED_READS = 3;

/** What a hold's view carries of a plan or a tool's input: it rides every broadcast. */
const MAX_DETAIL = 16_000;

const QUESTION_TOOL = "AskUserQuestion";
const PLAN_TOOL = "ExitPlanMode";

type HookOutput = Record<string, unknown>;

/** Leaves the dialog on screen. */
const PASS: HookOutput = {};

export type DialogAnswer =
  | { decision: "allow"; answers?: Record<string, string>; annotations?: Record<string, { notes: string }> }
  | { decision: "deny"; message?: string };

export interface HeldCall {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  agent_id?: string;
}

interface Hold {
  view: DialogHold;
  call: HeldCall;
  settle: (output: HookOutput) => void;
  drawn: boolean;
  missed: number;
}

/** A person must not approve text they could not see in full and not be told. */
function clip(text: string): string {
  if (text.length <= MAX_DETAIL) return text;
  return `${text.slice(0, MAX_DETAIL)}\n… ${text.length - MAX_DETAIL} more characters, shown only in the terminal`;
}

function viewOf({ tool_name: tool, tool_input: input }: HeldCall): DialogHold | null {
  const id = randomUUID();
  if (tool === QUESTION_TOOL) {
    const questions = parseAskQuestions(input);
    return questions.length > 0 ? { id, kind: "question", questions } : null;
  }
  if (tool === PLAN_TOOL) {
    return { id, kind: "plan", detail: clip(String(input.plan ?? "")) };
  }
  // A command is the whole request. Elsewhere one field would hide what is approved: a Write's content, say.
  const detail = tool === "Bash" && typeof input.command === "string" ? input.command : JSON.stringify(input, null, 2);
  return { id, kind: "approval", tool, detail: clip(detail) };
}

/**
 * Whether the call can only be answered at the terminal, or its dialog would
 * not be there to answer. No hook answers an MCP tool marked
 * `requiresUserInteraction`, and the payload does not say which tools are. A
 * background subagent's or a fork's dialog is not drawn until the hook returns,
 * so a hold would hide it from a person at the terminal, and the payload does
 * not tell those from a foreground subagent, whose dialog is.
 */
function notHoldable({ tool_name, agent_id }: HeldCall): boolean {
  return !!agent_id || tool_name.startsWith("mcp__");
}

/**
 * Whether a finished call is the held one, as `PermissionRequest` has no
 * `tool_use_id`. A question and a plan come back from the tool with fields
 * added (the answers), and only one of either is open at a time.
 */
function sameCall(a: HeldCall, tool: string, input: unknown): boolean {
  if (a.tool_name !== tool) return false;
  return tool === QUESTION_TOOL || tool === PLAN_TOOL || isDeepStrictEqual(a.tool_input, input);
}

function decided(decision: Record<string, unknown>): HookOutput {
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } };
}

export class DialogHolds {
  private holds = new Map<string, Hold>();

  /** Resolves with what the hook answers Claude Code; a call that cannot be held passes at once. */
  hold(call: HeldCall, signal?: AbortSignal): Promise<HookOutput> {
    const view = notHoldable(call) ? null : viewOf(call);
    if (!view || signal?.aborted) return Promise.resolve(PASS);

    return new Promise((resolve) => {
      const release = () => this.settle(view.id, PASS);
      const timer = setTimeout(release, HOLD_LIMIT_MS);
      // A person's Esc or "No" ends the call, and with it this connection.
      signal?.addEventListener("abort", release, { once: true });
      this.holds.set(view.id, {
        view,
        call,
        drawn: false,
        missed: 0,
        settle: (output) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", release);
          resolve(output);
        },
      });
    });
  }

  private settle(id: string, output: HookOutput): void {
    const hold = this.holds.get(id);
    if (!hold) return;
    this.holds.delete(id);
    hold.settle(output);
  }

  private ofSession(sessionId: string): Hold[] {
    return [...this.holds.values()].filter((h) => h.call.session_id === sessionId);
  }

  /** A person's press. `gone` when the dialog ended first, `incomplete` for answers Claude Code would silently drop. */
  answer(id: string, answer: DialogAnswer): "answered" | "gone" | "incomplete" {
    const hold = this.holds.get(id);
    if (!hold) return "gone";
    if (answer.decision === "deny") {
      const message = answer.message?.trim() || "The user said no from the dashboard.";
      this.settle(id, decided({ behavior: "deny", message }));
      return "answered";
    }
    const { view, call } = hold;
    if (view.kind === "approval") {
      this.settle(id, decided({ behavior: "allow" }));
      return "answered";
    }
    // `allow` alone leaves these two dialogs open: they take their input back.
    const updatedInput = { ...call.tool_input };
    if (view.kind === "question") {
      const answers = answer.answers ?? {};
      const asked = view.questions.map((q) => q.question);
      const complete =
        asked.every((q) => answers[q]?.trim()) && Object.keys(answers).every((q) => asked.includes(q));
      if (!complete) return "incomplete";
      updatedInput.answers = answers;
      // A note on a picked option: Claude Code reads it here and shows Claude `"Q"="A" notes: …`.
      const notes = Object.entries(answer.annotations ?? {})
        .map(([q, a]) => [q, { notes: a.notes.trim() }] as const)
        .filter(([q, a]) => asked.includes(q) && a.notes);
      if (notes.length > 0) updatedInput.annotations = Object.fromEntries(notes);
    }
    this.settle(id, decided({ behavior: "allow", updatedInput }));
    return "answered";
  }

  /** A tool ran or failed: if it was held, a person let it through at the terminal. */
  toolFinished(sessionId: string, tool: string, input: unknown): void {
    const hold = this.ofSession(sessionId).find((h) => sameCall(h.call, tool, input));
    if (hold) this.settle(hold.view.id, PASS);
  }

  /** The turn ended, as it does when a dialog's countdown denies it: no dialog of it is left. */
  turnEnded(sessionId: string): void {
    for (const hold of this.ofSession(sessionId)) this.settle(hold.view.id, PASS);
  }

  /**
   * What the poll read off the pane. A long command approved at the terminal
   * reports nothing until it finishes, so a dialog that was drawn and is gone
   * ends the hold. One the pane never showed proves nothing, so that one waits.
   */
  paneRead(sessionId: string, dialogDrawn: boolean): void {
    for (const hold of this.ofSession(sessionId)) {
      if (dialogDrawn) {
        hold.drawn = true;
        hold.missed = 0;
      } else if (hold.drawn && ++hold.missed >= MISSED_READS) {
        this.settle(hold.view.id, PASS);
      }
    }
  }

  /** Whether anything is held, so what can only end a hold need not read its request. */
  get any(): boolean {
    return this.holds.size > 0;
  }

  /** The dialog on screen: they are drawn one at a time, oldest first. */
  view(sessionId: string): DialogHold | null {
    return this.ofSession(sessionId)[0]?.view ?? null;
  }
}

type GlobalWithHolds = typeof globalThis & { __claudeMuxDialogHolds?: DialogHolds };
const g = globalThis as GlobalWithHolds;

/** One per process, as the routes and the poll are loaded apart under Vite. */
export const dialogHolds: DialogHolds = g.__claudeMuxDialogHolds ?? (g.__claudeMuxDialogHolds = new DialogHolds());
