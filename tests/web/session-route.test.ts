import { describe, it, expect } from "vitest";
import { isPastPath, localRef, machineBase, parseSessionPath, pastPath, relayBase, sessionPath } from "../../web/src/lib/session-route.js";
import { paneUrl, singleUrl } from "../../web/src/lib/split-refs.js";

const servers = [
  { id: "a1", hostname: "engage", url: "https://engage.example.ts.net:3456" },
  { id: "b2", hostname: "omarchy", url: "https://omarchy.example.ts.net:3456" },
];

describe("sessionPath", () => {
  it("keeps the origin's own sessions at /session/<target>", () => {
    expect(sessionPath({ host: null, target: "main:1.0" })).toBe("/session/main%3A1.0");
  });

  it("names another machine's session by its machine", () => {
    expect(sessionPath({ host: "engage", target: "main:1.0" })).toBe("/m/engage/session/main%3A1.0");
  });

  it("appends what follows the session, such as a subagent", () => {
    expect(sessionPath({ host: "engage", target: "w:2.1" }, "/agent/abc")).toBe(
      "/m/engage/session/w%3A2.1/agent/abc"
    );
  });
});

describe("parseSessionPath", () => {
  it("reads an old link as the origin's session", () => {
    expect(parseSessionPath("/session/main%3A1.0")).toEqual({
      ref: { host: null, target: "main:1.0" },
      rest: "",
    });
  });

  it("reads the machine a link names", () => {
    expect(parseSessionPath("/m/engage/session/main%3A1.0")).toEqual({
      ref: { host: "engage", target: "main:1.0" },
      rest: "",
    });
  });

  it("keeps the rest of a subagent's path", () => {
    expect(parseSessionPath("/m/engage/session/main%3A1.0/agent/x1")).toEqual({
      ref: { host: "engage", target: "main:1.0" },
      rest: "/agent/x1",
    });
  });

  it("reads a split's first pane as written", () => {
    expect(parseSessionPath("/session/distilo%40q%3A0.0")?.ref.target).toBe("distilo@q:0.0");
  });

  it("is null for pages that are not a session's", () => {
    expect(parseSessionPath("/")).toBeNull();
    expect(parseSessionPath("/usage")).toBeNull();
    expect(parseSessionPath("/m/engage")).toBeNull();
    expect(parseSessionPath("/session/")).toBeNull();
    expect(parseSessionPath("/session/%E0%A4%A")).toBeNull();
  });

  it("round-trips what sessionPath builds", () => {
    for (const ref of [
      { host: null, target: "claude-mux-claude-17:1.1" },
      { host: "engage", target: "a b:0.0" },
    ]) {
      expect(parseSessionPath(sessionPath(ref))?.ref).toEqual(ref);
    }
  });
});

describe("machineBase", () => {
  it("answers the origin itself directly", () => {
    expect(machineBase(null, servers, "omarchy")).toBe("");
    expect(machineBase("omarchy", servers, "omarchy")).toBe("");
    expect(machineBase("OMARCHY", servers, "omarchy")).toBe("");
  });

  it("reaches another machine through the relay, by its id", () => {
    expect(machineBase("engage", servers, "omarchy")).toBe("/fleet/a1");
  });

  it("accepts the id in place of the name", () => {
    expect(machineBase("a1", servers, "omarchy")).toBe("/fleet/a1");
  });

  it("is null for a machine discovery has not reported", () => {
    expect(machineBase("distilo", servers, "omarchy")).toBeNull();
  });

  it("is null for a machine known only from a list cached before ids", () => {
    expect(machineBase("old", [{ id: "", hostname: "old", url: "x" }], "omarchy")).toBeNull();
  });
});

describe("relayBase", () => {
  it("tries a machine discovery has not reported by its name", () => {
    expect(relayBase("distilo", servers, "omarchy")).toBe("/fleet/distilo");
    expect(relayBase("engage", servers, "omarchy")).toBe("/fleet/a1");
    expect(relayBase(null, servers, "omarchy")).toBe("");
  });
});

describe("localRef", () => {
  it("drops this machine's own name and keeps another's", () => {
    expect(localRef({ host: "Omarchy", target: "m:1.0" }, servers, "omarchy")).toEqual({ host: null, target: "m:1.0" });
    expect(localRef({ host: "engage", target: "m:1.0" }, servers, "omarchy")).toEqual({ host: "engage", target: "m:1.0" });
  });
});

describe("singleUrl", () => {
  it("opens another machine's session on this page, not on that machine's", () => {
    expect(singleUrl({ host: "engage", target: "m:1.0" }, servers, "omarchy")).toBe("/m/engage/session/m%3A1.0");
  });

  it("drops this machine's own name", () => {
    expect(singleUrl({ host: "omarchy", target: "m:1.0" }, servers, "omarchy")).toBe("/session/m%3A1.0");
    expect(singleUrl({ host: null, target: "m:1.0" }, servers, "omarchy")).toBe("/session/m%3A1.0");
  });

  it("keeps the name of a machine nobody knows yet, for its page to report", () => {
    expect(singleUrl({ host: "distilo", target: "m:1.0" }, servers, "omarchy")).toBe("/m/distilo/session/m%3A1.0");
  });
});

describe("paneUrl", () => {
  it("frames each machine's session as a page of this origin", () => {
    expect(paneUrl({ host: "engage", target: "m:1.0" }, servers, "omarchy")).toBe("/m/engage/session/m%3A1.0?embed=1");
    expect(paneUrl({ host: null, target: "m:1.0" }, servers, "omarchy")).toBe("/session/m%3A1.0?embed=1");
    expect(paneUrl({ host: "omarchy", target: "m:1.0" }, servers, "omarchy")).toBe("/session/m%3A1.0?embed=1");
  });

  it("treats this machine's own name in any case as this machine", () => {
    const listed = [...servers, { id: "c3", hostname: "Distilo", url: "x" }];
    expect(paneUrl({ host: "c3", target: "m:1.0" }, listed, "distilo")).toBe("/session/m%3A1.0?embed=1");
  });
});

describe('pastPath', () => {
	it("names another machine's past session by its machine, and is told apart from a session's page", () => {
		expect(pastPath(null, 'abc-1')).toBe('/past/abc-1');
		expect(pastPath('engage', 'abc-1')).toBe('/m/engage/past/abc-1');
		expect(isPastPath('/m/engage/past/abc-1')).toBe(true);
		expect(isPastPath('/past/abc-1')).toBe(true);
		expect(isPastPath('/session/main:1.0')).toBe(false);
		expect(parseSessionPath('/past/abc-1')).toBeNull();
	});
});
