// Feeds captured screens to claude-mux's own pane readers.
// usage: bun read-screens.ts <path to src/tmux/pane.ts> <screen file>...
const [paneModule, ...files] = process.argv.slice(2);
const { isPaneShowingIdlePrompt, readActivityLine, detectRecentInterruption } = await import(paneModule);
for (const f of files) {
  const c = await Bun.file(f).text();
  console.log(f.split("/runs/").pop(), JSON.stringify({ idlePrompt: isPaneShowingIdlePrompt(c), activity: readActivityLine(c), interruption: detectRecentInterruption(c) }));
}
