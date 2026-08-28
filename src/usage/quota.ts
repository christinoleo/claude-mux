/**
 * Subscription quota, read from the account endpoint Claude Code itself calls.
 *
 * None of this is on disk: the transcripts carry token counts but no plan
 * state, and the status line receives only the context window. The only way to
 * learn how much of a five-hour or weekly window is spent is to ask, which is
 * what `GET /api/oauth/usage` answers for the signed-in account.
 *
 * Two rules govern the credential, and neither is negotiable:
 *
 *  - the file is only ever read, never written; and
 *  - an expired token is reported as unavailable, never refreshed.
 *
 * Refreshing is where a bug would cost the user their login, and running Claude
 * Code renews the token anyway. The endpoint is internal and undocumented, so
 * every failure degrades to "unavailable" rather than propagating.
 */

import { readFileSync } from "fs";
import { join } from "path";

import { asRecord, readNumber, readString } from "../transcript/json.js";
import { CLAUDE_DIR } from "../utils/paths.js";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const CREDENTIALS_PATH = join(CLAUDE_DIR, ".credentials.json");
const FETCH_TIMEOUT_MS = 8_000;
const CACHE_MS = 60_000;

export type Severity = "normal" | "warning" | "critical";

export interface QuotaLimit {
  /** Server's own name for the window, e.g. `session`, `weekly_all`. */
  kind: string;
  /** Windows sharing a reset, e.g. every `weekly` limit. */
  group: string;
  label: string;
  percent: number;
  severity: Severity;
  resetsAtMs: number | null;
  /** True when this is the limit currently constraining the account. */
  isActive: boolean;
}

export type QuotaUnavailable =
  | "no-credentials"
  | "token-expired"
  | "unauthorized"
  | "unreachable"
  | "no-limits";

export type QuotaResult =
  | {
      available: true;
      limits: QuotaLimit[];
      subscriptionType: string | null;
      fetchedAtMs: number;
    }
  | { available: false; reason: QuotaUnavailable };

interface Credentials {
  accessToken: string;
  expiresAt: number | null;
  subscriptionType: string | null;
}

function readCredentials(): Credentials | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8"));
    const oauth = asRecord(asRecord(parsed)?.claudeAiOauth);
    const accessToken = oauth ? readString(oauth.accessToken) : null;
    if (!oauth || accessToken === null || accessToken.length === 0) return null;
    const expiresAt = readNumber(oauth, "expiresAt");
    return {
      accessToken,
      expiresAt: expiresAt > 0 ? expiresAt : null,
      subscriptionType: readString(oauth.subscriptionType),
    };
  } catch {
    return null;
  }
}

function severityOf(value: unknown): Severity {
  return value === "warning" || value === "critical" ? value : "normal";
}

/**
 * Human name for a window.
 *
 * The endpoint also returns a number of code-named keys that come and go with
 * server-side experiments. Only `limits` is self-describing, so only `limits`
 * is read; an unrecognised kind is titled from its own name rather than
 * dropped, so a new window still surfaces.
 */
function labelFor(kind: string, scope: Record<string, unknown> | null): string {
  const model = scope ? asRecord(scope.model) : null;
  const modelName = model ? readString(model.display_name) : null;

  const base =
    kind === "session"
      ? "Session"
      : kind === "weekly_all"
        ? "Weekly"
        : kind === "weekly_scoped"
          ? "Weekly"
          : kind.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

  return modelName ? `${base} · ${modelName}` : base;
}

function parseLimits(payload: unknown): QuotaLimit[] {
  const root = asRecord(payload);
  const raw = root?.limits;
  if (!Array.isArray(raw)) return [];

  const limits: QuotaLimit[] = [];
  for (const entry of raw) {
    const limit = asRecord(entry);
    if (!limit) continue;
    const kind = readString(limit.kind);
    if (kind === null) continue;

    const resetsAt = readString(limit.resets_at);
    const parsedReset = resetsAt === null ? NaN : Date.parse(resetsAt);

    limits.push({
      kind,
      group: readString(limit.group) ?? kind,
      label: labelFor(kind, asRecord(limit.scope)),
      percent: readNumber(limit, "percent"),
      severity: severityOf(limit.severity),
      resetsAtMs: Number.isNaN(parsedReset) ? null : parsedReset,
      isActive: limit.is_active === true,
    });
  }
  return limits;
}

let cached: QuotaResult | null = null;
let cachedAtMs = 0;
/** The page and the sidebar widget both ask on load; one call answers both. */
let inFlight: Promise<QuotaResult> | null = null;

export async function fetchQuota(force = false): Promise<QuotaResult> {
  const now = Date.now();
  if (!force && cached && now - cachedAtMs < CACHE_MS) return cached;
  if (inFlight !== null) return inFlight;
  inFlight = readQuota(now);
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

async function readQuota(now: number): Promise<QuotaResult> {

  const store = (result: QuotaResult): QuotaResult => {
    cached = result;
    cachedAtMs = now;
    return result;
  };

  const credentials = readCredentials();
  if (credentials === null) return store({ available: false, reason: "no-credentials" });
  if (credentials.expiresAt !== null && credentials.expiresAt <= now) {
    // Deliberately not refreshed. Running Claude Code renews it.
    return store({ available: false, reason: "token-expired" });
  }

  try {
    const response = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "anthropic-beta": OAUTH_BETA,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return store({ available: false, reason: "unauthorized" });
    }
    if (!response.ok) return store({ available: false, reason: "unreachable" });

    const limits = parseLimits(await response.json());
    if (limits.length === 0) {
      // Plan limits do not apply on an API key, Bedrock or Vertex profile.
      return store({ available: false, reason: "no-limits" });
    }
    return store({
      available: true,
      limits,
      subscriptionType: credentials.subscriptionType,
      fetchedAtMs: now,
    });
  } catch {
    return store({ available: false, reason: "unreachable" });
  }
}

/** Drops the in-process cache. Exists for tests. */
export function resetQuotaCache(): void {
  cached = null;
  cachedAtMs = 0;
  inFlight = null;
}
