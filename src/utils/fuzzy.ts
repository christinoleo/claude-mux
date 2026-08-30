export interface FuzzyMatch {
  /** Higher is better. */
  score: number;
  /** Indices of the characters in `text` that the query matched. */
  positions: number[];
}

/**
 * Subsequence fuzzy match with the matched character positions.
 * Prefers: prefix match, matches at word boundaries, contiguous runs, shorter names.
 * Returns null when the query is not a subsequence of the text.
 * Pass `wantPositions: false` when only the score is used — it skips collecting them.
 */
export function fuzzyMatch(text: string, q: string, wantPositions = true): FuzzyMatch | null {
  if (!q) return { score: 0, positions: [] };
  const t = text.toLowerCase();
  const needle = q.toLowerCase();
  // Fast path: substring
  const idx = t.indexOf(needle);
  if (idx !== -1) {
    const positions = wantPositions
      ? Array.from({ length: needle.length }, (_, i) => idx + i)
      : [];
    return { score: 1000 - idx * 5 - t.length, positions };
  }
  const positions: number[] = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (let qi = 0; qi < needle.length; qi++) {
    const ch = needle[qi];
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    score += found === prev + 1 ? 10 : 1;
    if (found === 0 || /[^a-z0-9]/.test(t[found - 1] ?? "")) score += 5;
    if (wantPositions) positions.push(found);
    prev = found;
    ti = found + 1;
  }
  return { score: score - t.length * 0.1, positions };
}

/** Score only — skips collecting match positions. Higher is better; null = no match. */
export function fuzzyScore(text: string, q: string): number | null {
  return fuzzyMatch(text, q, false)?.score ?? null;
}

/** Split `text` into alternating plain/matched runs for highlighting. */
export function highlightRuns(text: string, positions: number[]): { text: string; hit: boolean }[] {
  if (positions.length === 0) return [{ text, hit: false }];
  const runs: { text: string; hit: boolean }[] = [];
  let cut = 0;
  for (let i = 0; i < positions.length; ) {
    // positions is ascending, so a run of matched chars is one slice
    const from = positions[i];
    let to = from;
    while (i + 1 < positions.length && positions[i + 1] === to + 1) {
      to = positions[++i];
    }
    i++;
    if (from > cut) runs.push({ text: text.slice(cut, from), hit: false });
    runs.push({ text: text.slice(from, to + 1), hit: true });
    cut = to + 1;
  }
  if (cut < text.length) runs.push({ text: text.slice(cut), hit: false });
  return runs;
}

/**
 * Ranking shared by the web command list and spoken-command resolution: a
 * fuzzy match on the name (boosted so any name hit beats any description
 * hit), else a substring match on the description — substring only, because
 * a subsequence over long prose matches everything. Lives here rather than
 * beside the command scanner so the browser bundle never sees "fs".
 */
export function scoreCommand(
  cmd: { name: string; description: string },
  query: string
): number | null {
  const nameScore = fuzzyScore(cmd.name, query);
  if (nameScore != null) return nameScore + 500;
  const descIdx = query ? cmd.description.toLowerCase().indexOf(query.toLowerCase()) : -1;
  return descIdx === -1 ? null : 100 - descIdx * 0.5;
}
