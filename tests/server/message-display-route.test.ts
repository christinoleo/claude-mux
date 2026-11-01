import { beforeEach, describe, expect, it, vi } from "vitest";

const acceptLiveText = vi.fn(() => true);

vi.mock("$lib/server/ws-managers.js", () => ({
  transcriptWsManager: { acceptLiveText },
}));

const { POST } = await import("../../web/src/routes/api/hooks/message-display/+server.js");

const BATCH = { session_id: "11111111-2222", message_id: "m", index: 0, delta: "one\n", final: false };

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const request = new Request("http://127.0.0.1/api/hooks/message-display", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return POST({ request } as never) as Promise<Response>;
}

beforeEach(() => {
  acceptLiveText.mockClear();
  acceptLiveText.mockReturnValue(true);
});

describe("POST /api/hooks/message-display", () => {
  it("stores a batch and answers with nothing to change on screen", async () => {
    const res = await post({ ...BATCH, hook_event_name: "MessageDisplay" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(acceptLiveText).toHaveBeenCalledWith(BATCH);
  });

  it("refuses a request that carries an Origin, before reading it", async () => {
    const res = await post(BATCH, { origin: "http://127.0.0.1" });
    expect(res.status).toBe(403);
    expect(acceptLiveText).not.toHaveBeenCalled();
  });

  it("refuses a session this machine does not know", async () => {
    acceptLiveText.mockReturnValue(false);
    expect((await post(BATCH)).status).toBe(404);
  });

  it.each([
    ["a body that is not JSON", "{"],
    ["a batch with no delta", { ...BATCH, delta: undefined }],
    ["an index that is not a whole number", { ...BATCH, index: 1.5 }],
    ["a session id that leaves the sessions directory", { ...BATCH, session_id: "../../etc/passwd" }],
  ])("refuses %s", async (_name, body) => {
    expect((await post(body)).status).toBe(400);
    expect(acceptLiveText).not.toHaveBeenCalled();
  });

  it("takes a batch whose final is null as not final", async () => {
    expect((await post({ ...BATCH, final: null })).status).toBe(200);
  });
});
