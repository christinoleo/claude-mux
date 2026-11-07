/**
 * Every test file gets a HOME of its own, empty, before it loads anything.
 *
 * Much of the code finds its state from `os.homedir()` when a module loads
 * (`~/.claude-mux`, `~/.claude/settings.json`, `~/.claude.json`), and a test
 * that mocks one of those paths can still reach the others through a module
 * it did not mock. With HOME pointed here, whatever a test misses lands in a
 * throwaway directory instead of the machine's real state (#223).
 *
 * The environment the run was started from is cut off the same way: the XDG
 * directories (git's and gh's config live there), the tmux server the shell
 * sits in, and the `CLAUDE_MUX_*` overrides a pane exports, which name the
 * real port and release directory and win over HOME.
 */

import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll } from "vitest";

const home = mkdtempSync(join(tmpdir(), "claude-mux-test-home-"));
const env = process.env;
env.HOME = home;
env.USERPROFILE = home;
env.XDG_CONFIG_HOME = join(home, ".config");
env.XDG_DATA_HOME = join(home, ".local", "share");
env.XDG_STATE_HOME = join(home, ".local", "state");
env.XDG_CACHE_HOME = join(home, ".cache");
env.GIT_CONFIG_NOSYSTEM = "1";
env.GIT_CONFIG_GLOBAL = join(home, ".gitconfig");
// With no config to read, git needs an identity to commit.
env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = "claude-mux tests";
env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = "tests@claude-mux.invalid";
delete env.TMUX;
delete env.TMUX_PANE;
env.TMUX_TMPDIR = join(home, "tmux");
mkdirSync(env.TMUX_TMPDIR);
for (const key of Object.keys(env)) if (key.startsWith("CLAUDE_MUX_")) delete env[key];

afterAll(() => rmSync(home, { recursive: true, force: true }));
