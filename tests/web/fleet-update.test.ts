import { describe, expect, it } from "vitest";
import {
  lastLine,
  updateAll,
  updateMachine,
  updateOrder,
  type Answer,
  type StepProgress,
  type UpdateIO,
} from "../../web/src/lib/fleet-update.js";

/** A machine that answers from a script: each GET takes the next answer, the last one repeating. */
function scripted(post: Answer, gets: Answer[]) {
  const asked: string[] = [];
  let clock = 0;
  const io: UpdateIO = {
    async request(url, method) {
      asked.push(`${method} ${url}`);
      if (method === "POST") return post;
      return gets.length > 1 ? gets.shift()! : gets[0];
    },
    async sleep(ms) {
      clock += ms;
    },
    now: () => clock,
  };
  return { io, asked };
}

const job = (state: string, output = "", extra: Record<string, unknown> = {}) => ({
  job: { state, startedAt: 7, output, exitCode: state === "ok" ? 0 : state === "failed" ? 1 : null, ...extra },
});

describe("updateOrder", () => {
  it("keeps the order given and puts the origin last", () => {
    const order = updateOrder([
      { id: "omarchy", origin: true },
      { id: "distilo", origin: false },
      { id: "engage", origin: false },
    ]);
    expect(order.map((m) => m.id)).toEqual(["distilo", "engage", "omarchy"]);
  });
});

describe("lastLine", () => {
  it("is the last line that says something", () => {
    expect(lastLine("Installing...\n\nRestarting claude-mux.service\n\n")).toBe("Restarting claude-mux.service");
    expect(lastLine("")).toBe("");
  });
});

describe("updateMachine", () => {
  it("follows the update through the restart to its result", async () => {
    const { io, asked } = scripted({ status: 202, body: job("running") }, [
      { status: 200, body: job("running", "Installing claude-mux@0.31.0...\n") },
      null,
      { status: 502, body: { error: "machine unreachable" } },
      { status: 200, body: { version: "0.31.0", ...job("ok", "Installing...\nUpdate complete.\n") } },
    ]);
    const seen: StepProgress["state"][] = [];
    const result = await updateMachine("/fleet/engage-id", (p) => seen.push(p.state), io);
    expect(result).toMatchObject({ state: "ok", version: "0.31.0", line: "Update complete." });
    expect(seen).toEqual(["starting", "running", "restarting", "restarting", "ok"]);
    expect(asked[0]).toBe("POST /fleet/engage-id/api/update");
  });

  it("waits for a job it started, not the one before", async () => {
    const { io } = scripted({ status: 202, body: job("running") }, [
      { status: 200, body: job("ok", "old run\n", { startedAt: 1 }) },
      { status: 200, body: job("failed", "npm ERR! 404\n") },
    ]);
    const result = await updateMachine("", () => {}, io);
    expect(result).toMatchObject({ state: "failed", line: "npm ERR! 404 (exit 1)" });
    expect(result.output).toBe("npm ERR! 404\n");
  });

  it("joins an update already running there", async () => {
    const { io } = scripted({ status: 409, body: job("running") }, [{ status: 200, body: job("ok", "done\n") }]);
    expect((await updateMachine("", () => {}, io)).state).toBe("ok");
  });

  it("says a machine without the update route has to be updated by hand", async () => {
    const { io } = scripted({ status: 404, body: {} }, []);
    expect(await updateMachine("/fleet/x", () => {}, io)).toMatchObject({ state: "failed", line: expect.stringMatching(/claude-mux update/) });
  });

  it("passes on the relay's refusal", async () => {
    const { io } = scripted({ status: 404, body: { error: "unknown machine" } }, []);
    expect(await updateMachine("/fleet/x", () => {}, io)).toMatchObject({ state: "failed", line: "unknown machine" });
    const refused = scripted({ status: 403, body: { error: "cross-origin request refused" } }, []);
    expect(await updateMachine("/fleet/x", () => {}, refused.io)).toMatchObject({ line: "cross-origin request refused" });
  });

  it("gives up on a machine that never comes back", async () => {
    const { io } = scripted({ status: 202, body: job("running") }, [null]);
    const result = await updateMachine("", () => {}, io, { pollMs: 1_000, timeoutMs: 60_000 });
    expect(result).toMatchObject({ state: "failed", line: "No result after 1 min" });
  });
});

describe("updateAll", () => {
  it("updates one machine at a time, origin last, and carries on past a failure", async () => {
    const ran: string[] = [];
    let running = 0;
    const results = await updateAll(
      [
        { id: "omarchy", origin: true },
        { id: "engage", origin: false },
        { id: "distilo", origin: false },
      ],
      async (m) => {
        running++;
        expect(running).toBe(1);
        ran.push(m.id);
        await new Promise((r) => setTimeout(r, 1));
        running--;
        if (m.id === "engage") throw new Error("boom");
        return { state: "ok", line: "", output: "", version: "0.31.0" };
      }
    );
    expect(ran).toEqual(["engage", "distilo", "omarchy"]);
    expect(results.map((r) => [r.machine.id, r.result.state])).toEqual([
      ["engage", "failed"],
      ["distilo", "ok"],
      ["omarchy", "ok"],
    ]);
    expect(results[0].result.line).toMatch(/boom/);
  });
});
