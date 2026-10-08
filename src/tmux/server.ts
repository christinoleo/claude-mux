import { execFileSync, spawnSync } from "child_process";
import { readFileSync } from "fs";

/**
 * Where the tmux server lives decides what a restart of claude-mux takes down.
 *
 * tmux 3.4+ built with systemd support moves every pane into a transient scope
 * of its own, and marks that scope `PartOf=` whichever unit the tmux server
 * itself runs in. When claude-mux runs as `claude-mux.service` and is the one
 * that starts the server (the first `new-session` after boot), the server runs
 * in the service's cgroup, so every pane is `PartOf=claude-mux.service`:
 * stopping the service for an update stops every pane on the machine, every
 * Claude session with them, and the update too when it was typed in one.
 *
 * So when no server is running yet, the first session is started under a scope
 * of its own (`systemd-run --user --scope`), and the panes are then part of
 * that scope instead. Where systemd is absent or refuses, tmux runs as before.
 */

/** Whether a tmux server is already answering. */
export function tmuxServerRunning(env: NodeJS.ProcessEnv = process.env): boolean {
  return spawnSync("tmux", ["list-sessions"], { stdio: "ignore", env }).status === 0;
}

/** The cgroup a process runs in, or null off Linux / when it is gone. */
export function cgroupOf(pid: number | "self"): string | null {
  try {
    const line = readFileSync(`/proc/${pid}/cgroup`, "utf-8").split("\n").find((l) => l.startsWith("0::"));
    return line ? line.slice(3) : null;
  } catch {
    return null;
  }
}

/** The tmux server's pid, or null when none is running. */
export function tmuxServerPid(): number | null {
  try {
    const out = execFileSync("tmux", ["display-message", "-p", "#{pid}"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const pid = Number(out);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Whether stopping `unit` would take the tmux panes with it: the server runs
 * inside that unit's cgroup.
 */
export function tmuxServerInsideUnit(unit: string): boolean {
  const pid = tmuxServerPid();
  if (!pid) return false;
  const cgroup = cgroupOf(pid);
  return !!cgroup && cgroup.split("/").includes(unit);
}

/**
 * Run `tmux new-session …`. When this call is the one that starts the server,
 * start it in a systemd scope of its own so the panes do not belong to
 * whatever service called it.
 */
export function tmuxNewSession(args: string[], env: NodeJS.ProcessEnv = process.env): void {
  if (!tmuxServerRunning(env) && process.platform === "linux") {
    const scoped = spawnSync(
      "systemd-run",
      ["--user", "--scope", "--quiet", "--collect", `--unit=claude-mux-tmux-${Date.now()}`, "--", "tmux", "new-session", ...args],
      { stdio: "ignore", env }
    );
    if (scoped.status === 0) return;
    // A tmux that failed under the scope may have started the server anyway.
    if (tmuxServerRunning(env)) {
      execFileSync("tmux", ["new-session", ...args], { stdio: "ignore", env });
      return;
    }
  }
  execFileSync("tmux", ["new-session", ...args], { stdio: "ignore", env });
}
