// Run from the repo root: bun run docs/research/fixtures/queue-jsonl/parser-check.ts
// Shows what the Transcript parser does with an absorbed message, using synthetic lines only.
import { TranscriptBuilder } from "../../../../src/transcript/parser.ts";

const base = { sessionId: "s", cwd: "/x" };
const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
const absorbed = (uuid: string, s: number, prompt: string) => ({
  ...base,
  type: "attachment",
  uuid,
  timestamp: at(s),
  attachment: { type: "queued_command", prompt, origin: { kind: "human" } },
});
const typed = (uuid: string, s: number, content: string) => ({
  ...base,
  type: "user",
  uuid,
  timestamp: at(s),
  message: { role: "user", content },
});

const builder: any = new TranscriptBuilder();
for (const line of [
  typed("u1", 0, "start"),
  absorbed("a1", 5, "ok"),
  typed("u2", 30, "ok thanks, now do the next thing"),
]) {
  builder.feed(JSON.stringify(line));
  const entries = builder.getEntries?.() ?? builder.entries;
  console.log(
    line.uuid,
    JSON.stringify(entries.map((e: any) => ({ kind: e.kind, text: e.text, delivered: e.delivered ?? false }))),
  );
}
