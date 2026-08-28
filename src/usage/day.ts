/**
 * Wall-clock day bucketing, kept in its own module so the browser can import
 * it without pulling the pricing tables into the bundle.
 *
 * The client must cut days exactly as the server did or its lookups miss, so
 * there is deliberately one implementation of this rule.
 */

const QUARTER_HOUR_MS = 15 * 60 * 1000;

/**
 * Formats an instant as a `YYYY-MM-DD` day in `timeZone`.
 *
 * `Intl.DateTimeFormat` is the only reliable way to resolve a wall-clock day
 * in an arbitrary IANA zone. `en-CA` yields ISO-ordered parts.
 */
export function makeDayFormatter(timeZone: string): (timestampMs: number) => string {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    // An unknown zone degrades to UTC rather than failing the whole report.
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  /*
   * Formatting is the hot path: a month of history asks for the same 40-odd
   * dates ten thousand times. Every IANA offset is a whole number of quarter
   * hours, so a 15-minute bucket can never straddle a day boundary — which
   * makes it a sound cache key and cuts the work by more than an order of
   * magnitude.
   */
  const cache = new Map<number, string>();
  return (timestampMs) => {
    const bucket = Math.floor(timestampMs / QUARTER_HOUR_MS);
    const hit = cache.get(bucket);
    if (hit !== undefined) return hit;
    const day = format.format(new Date(timestampMs));
    cache.set(bucket, day);
    return day;
  };
}

/** The host's own zone, or UTC when the runtime will not say. */
export function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
