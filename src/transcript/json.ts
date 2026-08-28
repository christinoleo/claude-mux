/**
 * Narrowing helpers for the untyped records that come out of Claude Code's
 * JSONL. Every field is optional in practice — the format is undocumented and
 * shifts between versions — so readers return null (or 0) rather than throw.
 */

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** A finite number off a record, or 0 — the sane default for a token count. */
export function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
