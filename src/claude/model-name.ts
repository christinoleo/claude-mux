/**
 * The name Claude Code shows for a model, from the id the API logs.
 *
 * The transcript records the model on every assistant line as the API names
 * it — `claude-fable-5-1`, `claude-haiku-4-5-20251001` — and the dashboard
 * wants what the terminal's own status line says: "Fable 5.1", "Haiku 4.5".
 * The id is a family word, a version broken into dash-separated parts, and
 * sometimes a release date; the name is the family capitalised and the
 * version joined with dots. Anything that does not fit that shape is shown
 * as it is, so an id from a newer family still means something.
 */

/** A trailing 8-digit release date, as in `claude-haiku-4-5-20251001`. */
const RELEASE_DATE = /-\d{8}$/;

/** A `[1m]` suffix Claude Code appends for the long-context variant. */
const CONTEXT_SUFFIX = /\[(\d+[mk])\]$/i;

export function modelDisplayName(id: string | null | undefined): string | null {
  if (!id) return null;
  let rest = id.trim();
  if (!rest) return null;

  let context = "";
  const suffix = rest.match(CONTEXT_SUFFIX);
  if (suffix) {
    context = ` (${suffix[1].toUpperCase()})`;
    rest = rest.slice(0, -suffix[0].length);
  }

  // Bedrock and Vertex ids carry a region or vendor prefix: `us.anthropic.claude-…`.
  rest = rest.slice(rest.lastIndexOf(".") + 1).replace(RELEASE_DATE, "");
  const parts = rest.split("-").filter(Boolean);
  if (parts[0]?.toLowerCase() === "claude") parts.shift();

  const family = parts.shift();
  if (!family || !/^[a-z]+$/i.test(family)) return id;
  const version = parts.filter((part) => /^\d+$/.test(part));
  const tail = parts.filter((part) => !/^\d+$/.test(part));
  if (version.length !== parts.length - tail.length) return id;

  const name = family[0].toUpperCase() + family.slice(1).toLowerCase();
  const pieces = [name];
  if (version.length > 0) pieces.push(version.join("."));
  if (tail.length > 0) pieces.push(tail.join("-"));
  return pieces.join(" ") + context;
}
