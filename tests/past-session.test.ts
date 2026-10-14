import { describe, expect, it } from "vitest";
import { pastByRoot, pastLabel, type PastSession } from "../src/past-session.js";
import { settledKey } from "../src/fleet-prefs.js";

const past = (id: string, cwd: string | null, patch: Partial<PastSession> = {}): PastSession => ({
  id,
  cwd,
  branch: null,
  title: null,
  prompt: `prompt ${id}`,
  lastActivity: 0,
  ...patch,
});

describe("pastLabel", () => {
  it("is the title, else the first prompt, else the id", () => {
    expect(pastLabel(past("a", null, { title: "Settled section" }))).toBe("Settled section");
    expect(pastLabel(past("a", null))).toBe("prompt a");
    expect(pastLabel(past("abcdef0123", null, { prompt: null }))).toBe("Session abcdef01");
  });
});

describe("pastByRoot", () => {
  it("puts each under the deepest root holding its folder, leaving out live and homeless ones", () => {
    const roots = ["/p/app", "/p/app/web", "/p/other"];
    const grouped = pastByRoot(
      [past("1", "/p/app"), past("2", "/p/app/web/src"), past("3", "/p/app/.worktree/9"), past("4", "/elsewhere"), past("5", "/p/app"), past("6", null)],
      roots,
      new Set(["5"])
    );
    expect(Object.fromEntries([...grouped].map(([root, list]) => [root, list.map((p) => p.id)]))).toEqual({
      "/p/app": ["1", "3"],
      "/p/app/web": ["2"],
    });
  });
});

describe("settledKey", () => {
  it("names the machine and the session, so tmux targets repeating across machines never collide", () => {
    expect(settledKey("m1", "s1")).toBe("settled:m1:s1");
    expect(settledKey("m1", "s1")).not.toBe(settledKey("m2", "s1"));
  });
});
