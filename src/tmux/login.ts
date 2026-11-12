/**
 * Claude Code's sign-in, as the pane draws it.
 *
 * `/login` never reaches the transcript: the link, the field the code goes
 * into and the verdict on it exist only on screen, and the link is printed
 * wider than the pane, so tmux wraps it over several lines. Reading them here
 * lets the transcript offer the link as a link and take the code in a field
 * of its own.
 */

export type LoginScreen =
  /**
   * The code field is open: the link to sign in with, what is typed so far, and why the last code failed.
   * `shell` marks `! claude auth login` run as a shell command, whose field no keys reach: what is typed
   * while it runs lands in Claude Code's own box and is queued as a message.
   */
  | { step: "code"; url: string | null; typed: string; error: string | null; shell: boolean }
  /** The code was refused; Enter goes back to a fresh link and code field. */
  | { step: "failed"; error: string }
  /** The code was taken; Claude Code waits for Enter to carry on. */
  | { step: "done" }
  /** A turn failed for want of a sign-in, and nothing has happened since. */
  | { step: "expired" }
  | null;

/** The field's own label, followed by whatever has been typed into it. */
const CODE_FIELD = /Paste code here if prompted >\s?(.*)$/;

/** The line above the link (`/login`), or the words in front of it (`claude auth login`). */
const LINK_INTRO = /Browser didn't open\?|If the browser didn't open, visit:/i;

/** The link itself, which starts a line of its own or follows `visit:` on the same one. */
const LINK_START = /^(.*?)(https:\/\/\S+)$/;

/** Tool output's gutter: a shell command's output hangs off `⎿` and keeps its indent when it wraps. */
const TOOL_GUTTER = /^\s*⎿\s/;

/** A wrapped piece of the link: a line of URL characters, flush left. */
const LINK_REST = /^[A-Za-z0-9%&=_.~+/:?#-]+$/;

const CODE_ERROR = /(Invalid code\. Please make sure the full code was copied\.?|OAuth error: .+)$/;

const SIGNED_IN = /Login successful\. Press .*continue/i;

/** The sign-in's own retry prompt, drawn under the error that ended it. */
const RETRY = /Press Enter to retry/i;

/** What Claude Code answers a turn with when no sign-in is left. */
const EXPIRED = /Please run \/login|run \/login to restore|Not logged in · Please run \/login/i;

/** A message bullet: anything Claude Code printed into the conversation. */
const BULLET = /^\s*●\s/;

/** How far up from the foot the sign-in screen may begin. */
const LOGIN_REACH = 40;

/** Read the sign-in screen off a pane capture taken without colour. */
export function readLoginScreen(content: string): LoginScreen {
  if (!content) return null;
  const lines = content.split("\n");
  let last = lines.length - 1;
  while (last >= 0 && !lines[last].trim()) last--;
  if (last < 0) return null;
  const from = Math.max(0, last - LOGIN_REACH);

  for (let i = last; i >= from; i--) {
    if (SIGNED_IN.test(lines[i])) return { step: "done" };
    if (RETRY.test(lines[i])) {
      const above = lines.slice(Math.max(from, i - 3), i).map((l) => l.trim().match(CODE_ERROR)?.[1]).filter(Boolean);
      return { step: "failed", error: above.at(-1) ?? "The sign-in failed." };
    }
    const field = lines[i].match(CODE_FIELD);
    if (!field) continue;
    let error: string | null = null;
    for (let j = i + 1; j <= last; j++) {
      const m = lines[j].trim().match(CODE_ERROR);
      if (m) error = m[1];
    }
    return { step: "code", ...readLink(lines, from, i), typed: field[1].trim(), error };
  }

  // The notice counts only while it is the last thing Claude Code said: any
  // message after it means a turn has run since.
  for (let i = last; i >= from; i--) {
    if (!BULLET.test(lines[i])) continue;
    return EXPIRED.test(lines[i]) ? { step: "expired" } : null;
  }
  return null;
}

/**
 * The sign-in link between its introduction and the code field, joined back across the wrap, and whether
 * it sits in a shell command's output. `/login` prints the link alone on a line and tmux wraps it flush
 * left; `claude auth login` prints it after `visit:`, and its wrapped pieces keep the output's indent.
 */
function readLink(lines: string[], from: number, field: number): { url: string | null; shell: boolean } {
  let start = -1;
  let intro = -1;
  for (let i = field - 1; i >= from; i--) {
    if (LINK_START.test(lines[i])) start = i;
    if (LINK_INTRO.test(lines[i])) {
      intro = i;
      break;
    }
  }
  let shell = false;
  for (let i = field; i >= Math.max(from, intro); i--) if (TOOL_GUTTER.test(lines[i])) shell = true;
  if (start === -1) return { url: null, shell };
  const [, before, head] = lines[start].match(LINK_START)!;
  // A piece continues the link only at the column the link's own line starts its text at.
  const indent = shell ? (before.match(/^[\s⎿]*/)?.[0].length ?? 0) : 0;
  let url = head;
  for (let i = start + 1; i < field; i++) {
    const line = lines[i].replace(/\s+$/, "");
    if (line.slice(0, indent).trim()) break;
    const piece = line.slice(indent);
    if (!LINK_REST.test(piece)) break;
    url += piece;
  }
  return { url, shell };
}
