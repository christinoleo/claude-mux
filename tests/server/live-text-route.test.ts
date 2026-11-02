import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ dev: false }));
const setLiveText = vi.fn((_enabled: boolean, writer: { dev: boolean }) => !writer.dev);
const readLiveText = vi.fn((writer: { dev: boolean }) => ({ enabled: true, switchable: !writer.dev }));

vi.mock("$app/environment", () => ({
  get dev() {
    return env.dev;
  },
}));
vi.mock("$lib/server/instance", () => ({ listenPort: () => 4567 }));
vi.mock("$shared/server/live-text-switch.js", () => ({ setLiveText, readLiveText }));

const { GET, POST } = await import("../../web/src/routes/api/live-text/+server.js");

function post(body: unknown): Promise<Response> {
  const request = new Request("http://127.0.0.1/api/live-text", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return POST({ request } as never) as Promise<Response>;
}

beforeEach(() => {
  env.dev = false;
  setLiveText.mockClear();
});

describe("/api/live-text", () => {
  it("reads the switch", async () => {
    expect(await (await (GET({} as never) as Promise<Response>)).json()).toEqual({ enabled: true, switchable: true });
  });

  it("writes with this server's own port and answers with the switch", async () => {
    const res = await post({ enabled: true });
    expect(res.status).toBe(200);
    expect(setLiveText).toHaveBeenCalledWith(true, { dev: false, port: 4567 });
    expect(await res.json()).toEqual({ enabled: true, switchable: true });
  });

  it("answers 409 on a dev server", async () => {
    env.dev = true;
    const res = await post({ enabled: true });
    expect(res.status).toBe(409);
    expect(setLiveText).toHaveBeenCalledWith(true, { dev: true, port: 4567 });
  });

  it("refuses anything but true or false, before touching the file", async () => {
    for (const body of ["nope", { enabled: "yes" }, {}]) expect((await post(body)).status).toBe(400);
    expect(setLiveText).not.toHaveBeenCalled();
  });

  it("refuses another page's origin, and takes this server's own and a relay's", async () => {
    const send = (origin: string) =>
      POST({
        request: new Request("http://127.0.0.1:3456/api/live-text", {
          method: "POST",
          headers: { origin, host: "127.0.0.1:3456", "content-type": "text/plain" },
          body: JSON.stringify({ enabled: true }),
        }),
      } as never) as Promise<Response>;

    expect((await send("https://evil.example")).status).toBe(403);
    expect(setLiveText).not.toHaveBeenCalled();
    expect((await send("http://127.0.0.1:3456")).status).toBe(200);
  });

  it("says so when the settings cannot be changed", async () => {
    setLiveText.mockImplementationOnce(() => {
      throw new SyntaxError("bad json");
    });
    const res = await post({ enabled: true });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("settings.json");
  });
});
