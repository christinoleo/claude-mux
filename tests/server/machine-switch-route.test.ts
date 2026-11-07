import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ dev: false }));
const tick = vi.fn(async () => {});
const setMachineSwitch = vi.fn((_on: boolean, writer: { dev: boolean }) => !writer.dev);
const readMachineSwitch = vi.fn((writer: { dev: boolean }) => ({ on: true, switchable: !writer.dev }));

vi.mock("$app/environment", () => ({
  get dev() {
    return env.dev;
  },
}));
vi.mock("$lib/server/instance", () => ({ listenPort: () => 4567 }));
vi.mock("$lib/server/worker-queue.js", () => ({ workerQueue: () => ({ tick }) }));
vi.mock("$shared/server/machine-switch.js", () => ({ setMachineSwitch, readMachineSwitch }));

const { GET, POST } = await import("../../web/src/routes/api/machine-switch/+server.js");

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const request = new Request("http://127.0.0.1:3456/api/machine-switch", {
    method: "POST",
    headers: { host: "127.0.0.1:3456", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return POST({ request } as never) as Promise<Response>;
}

beforeEach(() => {
  env.dev = false;
  setMachineSwitch.mockClear();
  tick.mockClear();
});

describe("/api/machine-switch", () => {
  it("reads the switch", async () => {
    expect(await (await (GET({} as never) as Promise<Response>)).json()).toEqual({ on: true, switchable: true });
  });

  it("turns it with this server's own port, and has the queue look again", async () => {
    const res = await post({ on: false });
    expect(res.status).toBe(200);
    expect(setMachineSwitch).toHaveBeenCalledWith(false, { dev: false, port: 4567 });
    expect(tick).toHaveBeenCalled();
  });

  it("answers 409 where this server may not turn it", async () => {
    env.dev = true;
    expect((await post({ on: true })).status).toBe(409);
  });

  it("refuses anything but true or false, and another page's origin, before touching anything", async () => {
    for (const body of ["nope", { on: "yes" }, { enabled: true }]) expect((await post(body)).status).toBe(400);
    expect((await post({ on: true }, { origin: "https://evil.example" })).status).toBe(403);
    expect(setMachineSwitch).not.toHaveBeenCalled();
  });

  it("says so when a file cannot be written", async () => {
    setMachineSwitch.mockImplementationOnce(() => {
      throw new Error("EACCES");
    });
    const res = await post({ on: true });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("EACCES");
  });
});
