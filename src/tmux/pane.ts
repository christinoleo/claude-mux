import { execFileSync, execFile } from "child_process";
import { promisify } from "util";
import { isInTmux } from "./detect.js";

const execFileAsync = promisify(execFile);

/**
 * Get the title of a tmux pane.
 * @param target - The tmux target in format "session:window.pane"
 * @returns The pane title, or null if failed
 */
export function getPaneTitle(target: string): string | null {
  try {
    const result = execFileSync("tmux", ["display-message", "-p", "-t", target, "#{pane_title}"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 1000,
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Capture the contents of a tmux pane.
 * @param target - The tmux target in format "session:window.pane"
 * @returns The pane contents as a string, or null if capture failed
 */
export function capturePaneContent(target: string): string | null {
  if (!isInTmux()) {
    return null;
  }

  try {
    const result = execFileSync("tmux", ["capture-pane", "-p", "-t", target], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 1000,
    });
    return result;
  } catch {
    return null;
  }
}

/**
 * Async version of getPaneTitle. Does not block the event loop.
 */
export async function getPaneTitleAsync(target: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("tmux", ["display-message", "-p", "-t", target, "#{pane_title}"], {
      encoding: "utf-8",
      timeout: 1000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Batch-fetch all pane titles in a single tmux command.
 * Returns a Map of "session:window.pane" -> title (or null if pane has no title).
 */
export async function getAllPaneTitles(): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  try {
    const { stdout } = await execFileAsync("tmux", [
      "list-panes", "-a", "-F", "#{session_name}:#{window_index}.#{pane_index}\t#{pane_title}"
    ], { encoding: "utf-8", timeout: 2000 });

    for (const line of stdout.trim().split("\n")) {
      if (!line) continue;
      const tabIdx = line.indexOf("\t");
      if (tabIdx === -1) continue;
      const target = line.slice(0, tabIdx);
      const title = line.slice(tabIdx + 1).trim();
      result.set(target, title || null);
    }
  } catch {
    // tmux not available or no panes
  }
  return result;
}

/**
 * Async version of capturePaneContent. Does not block the event loop.
 */
export async function capturePaneContentAsync(target: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("tmux", ["capture-pane", "-p", "-t", target], {
      encoding: "utf-8",
      timeout: 1000,
    });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Async version of checkForInterruption. Does not block the event loop.
 */
export async function checkForInterruptionAsync(tmuxTarget: string): Promise<{ state: 'idle'; current_action: null; prompt_text: null } | null> {
  const content = await capturePaneContentAsync(tmuxTarget);
  if (!content) return null;

  const interruption = detectRecentInterruption(content);
  if (interruption) {
    return { state: 'idle', current_action: null, prompt_text: null };
  }
  return null;
}

/**
 * Check if the pane content shows Claude is actively working.
 * Looks for interrupt hints which appear when Claude is processing.
 */
export function isPaneShowingWorking(content: string): boolean {
  if (!content) return false;

  // These patterns appear when Claude is actively working
  return (
    content.includes("Esc to interrupt") ||
    content.includes("esc to interrupt") ||
    content.includes("ctrl+c to interrupt")
  );
}

/**
 * Check if the pane shows a spinner (e.g. during compaction).
 * Claude Code uses braille spinner characters (U+2800–U+28FF) in the status area.
 * Checks the bottom few lines of the pane where the spinner would appear.
 */
export function isPaneShowingSpinner(content: string): boolean {
  if (!content) return false;
  const bottomLines = content.split('\n').slice(-5).join('');
  // Braille spinner characters: ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ etc. (U+2800-U+28FF)
  return /[\u2800-\u28FF]/.test(bottomLines);
}

/**
 * Check if the pane content shows Claude is at the prompt (idle).
 * Claude is idle if "Esc to interrupt" is NOT present.
 */
export function isPaneShowingPrompt(content: string): boolean {
  if (!content) return false;

  // If "Esc to interrupt" is present, Claude is still working
  if (isPaneShowingWorking(content)) {
    return false;
  }

  return true;
}

/**
 * Detect if the pane shows user interruption or cancellation.
 * Only detects FRESH signals from the most recent interaction.
 *
 * Structure of Claude Code pane:
 *   ❯ user command           ← interaction start (● or ❯)
 *     ⎿  Interrupted...      ← signal we're looking for
 *   ─────────────────────    ← TOP separator
 *   ❯ [user input]           ← prompt area (may have text)
 *   ─────────────────────    ← BOTTOM separator
 *     status line
 *
 * Algorithm:
 * 1. Find the two separators around the prompt area
 * 2. Scan backwards from TOP separator to find ● or ❯ (interaction start)
 * 3. Check the slice between interaction start and TOP separator for signals
 *
 * @returns 'interrupted' if user pressed Esc during work,
 *          'declined' if user cancelled a prompt,
 *          null if no interruption detected
 */
export function detectRecentInterruption(content: string): 'interrupted' | 'declined' | null {
  if (!content) return null;

  const lines = content.split('\n');

  // If there's active UI (menu or working), don't detect old interruptions
  const bottomLines = lines.slice(-5).join('\n');
  if (
    bottomLines.includes('Esc to cancel') ||
    bottomLines.includes('Esc to interrupt') ||
    bottomLines.includes('ctrl+c to interrupt')
  ) {
    return null;
  }

  // Find the BOTTOM separator (last separator in the pane)
  let bottomSepIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('─────')) {
      bottomSepIdx = i;
      break;
    }
  }
  if (bottomSepIdx === -1) return null;

  // Find the TOP separator (second-to-last separator, above the prompt)
  let topSepIdx = -1;
  for (let i = bottomSepIdx - 1; i >= 0; i--) {
    if (lines[i].startsWith('─────')) {
      topSepIdx = i;
      break;
    }
  }
  if (topSepIdx === -1) return null;

  // Scan backwards from TOP separator to find the interaction start (● or ❯)
  let interactionStartIdx = -1;
  const maxScan = Math.max(0, topSepIdx - 15);
  for (let i = topSepIdx - 1; i >= maxScan; i--) {
    const line = lines[i];
    if (line.startsWith('●') || line.startsWith('❯')) {
      interactionStartIdx = i;
      break;
    }
  }
  if (interactionStartIdx === -1) return null;

  // Check the slice from interaction start to TOP separator for signals
  const slice = lines.slice(interactionStartIdx, topSepIdx).join('\n');

  if (slice.includes('Interrupted')) return 'interrupted';
  if (slice.includes('User declined to answer')) return 'declined';

  return null;
}

/**
 * Detect a Remote Control URL in pane content.
 * Strips ANSI escape codes before matching.
 * Returns the URL or null if not found.
 */
export function detectRemoteControlUrl(content: string): string | null {
  if (!content) return null;

  // Strip ANSI escape sequences
  const clean = content.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

  // Match claude.ai/code URLs (RC session URLs)
  const match = clean.match(/https:\/\/claude\.ai\/code[^\s)\]>]*/);
  return match ? match[0] : null;
}

/**
 * Check if a tmux pane shows a recent interruption/cancellation.
 * Returns the session update to apply, or null if no update needed.
 *
 * @param tmuxTarget - The tmux target in format "session:window.pane"
 * @returns Session fields to update if interruption detected, null otherwise
 */
export function checkForInterruption(tmuxTarget: string): { state: 'idle'; current_action: null; prompt_text: null } | null {
  const content = capturePaneContent(tmuxTarget);
  if (!content) return null;

  const interruption = detectRecentInterruption(content);
  if (interruption) {
    return { state: 'idle', current_action: null, prompt_text: null };
  }
  return null;
}
