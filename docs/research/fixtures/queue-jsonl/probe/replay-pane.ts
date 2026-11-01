// Replays saved pane captures through claude-mux's real reader. Run from the repo root.
import { readQueuedMessages } from "../../../../../src/tmux/pane.ts";
import { readdirSync, readFileSync } from "fs";

const root = process.env.PROBE159_DIR + "/run/";
for (const name of process.argv.slice(2)) {
  console.log("##", name);
  const timeline = JSON.parse(readFileSync(root + name + "/timeline.json", "utf8"));
  const base = timeline.tl.find((e: { kind: string }) => e.kind === "mark")?.t ?? timeline.t0;
  let previous = "";
  for (const file of readdirSync(root + name + "/caps").sort()) {
    const raw = readFileSync(root + name + "/caps/" + file, "utf8");
    const queue = JSON.stringify(readQueuedMessages(raw).map((m: string) => m.slice(0, 40)));
    if (queue !== previous) console.log((parseFloat(file) - base).toFixed(2), queue);
    previous = queue;
  }
}
