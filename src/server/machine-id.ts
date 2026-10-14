import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * This machine's id, kept in `path` and minted there the first time.
 *
 * The fleet keys a machine by this id, never by its name or address, so the
 * relay route `/fleet/<id>/api/...` and everything stored about a machine
 * survive a rename or a new tailnet IP. Every server process on the machine
 * reads the same file, so a host that answers under two tailnet names (a
 * Windows host forwarding its port into WSL) is still one machine.
 */
export function loadMachineId(path: string): string {
  const stored = readId(path);
  if (stored) return stored;
  const id = randomUUID();
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Created exclusively, so two servers starting together on a fresh host
    // (dev and prod) settle on whichever id was written first.
    writeFileSync(path, `${id}\n`, { flag: existsSync(path) ? "w" : "wx" });
  } catch {
    // Another process won the race, or the home is read-only.
  }
  return readId(path) ?? id;
}

function readId(path: string): string | null {
  try {
    const stored = readFileSync(path, "utf8").trim();
    return UUID.test(stored) ? stored : null;
  } catch {
    return null;
  }
}
