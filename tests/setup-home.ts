/**
 * Every test worker gets a HOME of its own, empty, before any test file loads.
 *
 * Much of the code finds its state from `os.homedir()` when a module loads
 * (`~/.claude-mux`, `~/.claude/settings.json`, `~/.claude.json`), and a test
 * that mocks one of those paths can still reach the others through a module
 * it did not mock. With HOME pointed here, whatever a test misses lands in a
 * throwaway directory instead of the machine's real state (#223).
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll } from "vitest";

const home = mkdtempSync(join(tmpdir(), "claude-mux-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
// git refuses to commit without an identity, and the real one lived in the real HOME.
process.env.GIT_AUTHOR_NAME ??= "claude-mux tests";
process.env.GIT_AUTHOR_EMAIL ??= "tests@claude-mux.invalid";
process.env.GIT_COMMITTER_NAME ??= "claude-mux tests";
process.env.GIT_COMMITTER_EMAIL ??= "tests@claude-mux.invalid";

afterAll(() => rmSync(home, { recursive: true, force: true }));
