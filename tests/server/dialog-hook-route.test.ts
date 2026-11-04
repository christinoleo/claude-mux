import { beforeEach, describe, expect, it, vi } from "vitest";

const holds = vi.hoisted(() => ({
  hold: vi.fn(async () => ({ held: true })),
  toolFinished: vi.fn(),
  turnEnded: vi.fn(),
  answer: vi.fn(() => "answered"),
  any: true,
}));
const getSession = vi.fn((_id: string): object | null => ({ id: "s1" }));

vi.mock("$shared/server/dialog-holds.js", () => ({ dialogHolds: holds }));
vi.mock("$shared/db/sessions-json.js", () => ({ getSession }));

const hook = await import("../../web/src/routes/api/hooks/dialog/+server.js");
const ended = await import("../../web/src/routes/api/hooks/dialog/ended/+server.js");
const press = await import("../../web/src/routes/api/dialog-holds/[id]/+server.js");

const EVENT = { hook_event_name: "PermissionRequest", session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } };

function postHook(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const request = new Request("http://127.0.0.1/api/hooks/dialog", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return hook.POST({ request } as never) as Promise<Response>;
}

function postEnded(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const request = new Request("http://127.0.0.1/api/hooks/dialog/ended", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return ended.POST({ request } as never) as Promise<Response>;
}

function postPress(body: unknown, headers: Record<string, string> = { origin: "http://127.0.0.1:3456" }): Promise<Response> {
  const request = new Request("http://127.0.0.1:3456/api/dialog-holds/h1", {
    method: "POST",
    headers: { host: "127.0.0.1:3456", ...headers },
    body: JSON.stringify(body),
  });
  return press.POST({ request, params: { id: "h1" } } as never) as Promise<Response>;
}

beforeEach(() => {
  vi.clearAllMocks();
  holds.any = true;
  getSession.mockReturnValue({ id: "s1" });
});

describe("POST /api/hooks/dialog", () => {
  it("holds a PermissionRequest, and answers with what the hold decides", async () => {
    const res = await postHook(EVENT);
    expect(await res.json()).toEqual({ held: true });
    expect(holds.hold.mock.calls[0]).toEqual([
      { session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } },
      expect.any(AbortSignal),
    ]);
  });

  it("passes for a session this machine does not know", async () => {
    getSession.mockReturnValue(null);
    expect(await (await postHook(EVENT)).json()).toEqual({});
    expect(holds.hold).not.toHaveBeenCalled();
  });

  it("refuses a page, which must never hold or end a dialog", async () => {
    expect((await postHook(EVENT, { origin: "http://127.0.0.1" })).status).toBe(403);
    expect(holds.hold).not.toHaveBeenCalled();
  });

  it("refuses what is not a call, or a session id that leaves the directory", async () => {
    expect((await postHook({ nope: 1 })).status).toBe(400);
    expect((await postHook({ ...EVENT, session_id: "../../etc" })).status).toBe(400);
  });
});

describe("POST /api/hooks/dialog/ended", () => {
  it.each(["PostToolUse", "PostToolUseFailure"])("takes %s on the main thread as the tool finishing", async (name) => {
    await postEnded({ ...EVENT, hook_event_name: name });
    expect(holds.toolFinished).toHaveBeenCalledWith("s1", "Bash", { command: "ls" });
  });

  it("leaves a subagent's tools out of it, as no subagent's call is held", async () => {
    await postEnded({ ...EVENT, hook_event_name: "PostToolUse", agent_id: "a1" });
    expect(holds.toolFinished).not.toHaveBeenCalled();
  });

  it("takes Stop as the end of the turn", async () => {
    await postEnded({ hook_event_name: "Stop", session_id: "s1" });
    expect(holds.turnEnded).toHaveBeenCalledWith("s1");
  });

  it("does not read a request with nothing held, as these carry a tool's whole response", async () => {
    holds.any = false;
    expect((await postEnded("not even json")).status).toBe(200);
    expect(holds.toolFinished).not.toHaveBeenCalled();
  });

  it("refuses a page, which must never end a dialog", async () => {
    expect((await postEnded({ hook_event_name: "Stop", session_id: "s1" }, { origin: "http://127.0.0.1" })).status).toBe(403);
    expect(holds.turnEnded).not.toHaveBeenCalled();
  });
});

describe("POST /api/dialog-holds/[id]", () => {
  it("passes a person's press to the hold it names", async () => {
    const res = await postPress({ decision: "allow", answers: { q: "a" } });
    expect(res.status).toBe(200);
    expect(holds.answer).toHaveBeenCalledWith("h1", { decision: "allow", answers: { q: "a" } });
  });

  it("refuses a request with no Origin, which no page sends", async () => {
    expect((await postPress({ decision: "allow" }, {})).status).toBe(403);
    expect(holds.answer).not.toHaveBeenCalled();
  });

  it("refuses another page, and takes this server's own", async () => {
    expect((await postPress({ decision: "allow" }, { origin: "https://evil.example" })).status).toBe(403);
    expect(holds.answer).not.toHaveBeenCalled();
    expect((await postPress({ decision: "allow" }, { origin: "http://127.0.0.1:3456" })).status).toBe(200);
  });

  it("refuses anything but a decision", async () => {
    expect((await postPress({ decision: "maybe" })).status).toBe(400);
    expect(holds.answer).not.toHaveBeenCalled();
  });

  it("says when the dialog ended first, and when answers are missing", async () => {
    holds.answer.mockReturnValueOnce("gone");
    expect((await postPress({ decision: "allow" })).status).toBe(409);
    holds.answer.mockReturnValueOnce("incomplete");
    expect((await postPress({ decision: "allow" })).status).toBe(400);
  });
});
