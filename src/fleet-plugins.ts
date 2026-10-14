/**
 * Plugins kept in step across the fleet (spec #92, "Plugins").
 *
 * Each machine reports its Claude Code marketplaces, with the commit each is
 * at and the latest commit its source has, and its installed plugins, with
 * their version (`PluginsReport`, read by `src/server/plugins.ts`). The fleet
 * is "in line" when every marketplace is at its latest commit and every
 * plugin enabled on any machine is enabled on all, leaving out the plugins
 * marked "only here" (a fleet preference, `onlyHereKey()` in `src/fleet-prefs.ts`).
 *
 * One marketplace goes by different names on different machines (it was
 * added under another name, or its repo was renamed), so it is matched by its
 * source repo, and a plugin by its name and its marketplace's repo
 * (`pluginKey()`). "Bring in line" on a machine is `alignPlan()`: update its
 * marketplaces, install what it lacks from the marketplace it has under
 * whatever name (or from the repo, which adds the marketplace), and enable
 * what it has turned off.
 */

import { z } from "zod/v4";
import { normaliseRemote } from "./fleet-projects.js";

const MarketplaceReportSchema = z.object({
  /** Its name on the reporting machine, which plugin ids carry. */
  name: z.string(),
  /** Its source repo as `owner/name` (GitHub's current name when it could be asked), or its git URL; null for a local one. */
  repo: z.string().nullable(),
  /** The commit it is at; null when that cannot be told. */
  commit: z.string().nullable(),
  /** The latest commit its source has; null when that could not be asked. */
  latest: z.string().nullable(),
});

const PluginReportSchema = z.object({
  /** `name@marketplace`, as the `claude plugin` CLI names it on the reporting machine. */
  id: z.string(),
  version: z.string().nullable(),
  enabled: z.boolean(),
});

export const PluginsReportSchema = z.object({
  marketplaces: z.array(MarketplaceReportSchema),
  plugins: z.array(PluginReportSchema),
  /** When the report was read (ms, the reporting machine's clock). */
  readAt: z.number(),
});

export type MarketplaceReport = z.infer<typeof MarketplaceReportSchema>;
export type PluginReport = z.infer<typeof PluginReportSchema>;
export type PluginsReport = z.infer<typeof PluginsReportSchema>;

/** A plugin id split into its name and its marketplace's name. */
function splitPluginId(id: string): { name: string; marketplace: string } {
  const at = id.lastIndexOf("@");
  return at > 0 ? { name: id.slice(0, at), marketplace: id.slice(at + 1) } : { name: id, marketplace: "" };
}

/** A marketplace's key across machines: its repo, lower-cased, or its name when it has none. */
/**
 * A marketplace's key across machines: its repo, or its name when it has
 * none. A git URL is normalised, and a GitHub one reduced to `owner/name`,
 * so it meets the same marketplace added from GitHub elsewhere.
 */
export function marketplaceKey(m: Pick<MarketplaceReport, "name" | "repo">): string {
  if (!m.repo) return `name:${m.name}`;
  const remote = /[:@]/.test(m.repo) ? (normaliseRemote(m.repo) ?? m.repo) : m.repo;
  return remote.toLowerCase().replace(/^github\.com\//, "");
}

/** A plugin as the fleet matches it: its name and its marketplace's key on the machine reporting it. */
function pluginIdentity(id: string, marketplaces: readonly MarketplaceReport[]) {
  const { name, marketplace } = splitPluginId(id);
  const m = marketplaces.find((x) => x.name === marketplace);
  const mpKey = m ? marketplaceKey(m) : `name:${marketplace}`;
  return { key: `${name}@${mpKey}`, name, marketplace, mpKey, repo: m?.repo ?? null };
}

/** A plugin's key across machines. */
export function pluginKey(id: string, marketplaces: readonly MarketplaceReport[]): string {
  return pluginIdentity(id, marketplaces).key;
}

/** A machine as the comparison reads it: its id and its report, null while it has sent none. */
export interface MachinePlugins {
  id: string;
  report: PluginsReport | null;
}

export interface PluginRow {
  key: string;
  name: string;
  /** The marketplace's name, as the first machine holding it calls it. */
  marketplace: string;
  /** The marketplace's key across machines (`MarketplaceRow.key`). */
  marketplaceKey: string;
  /** Its marketplace's repo, null for a marketplace with none. */
  repo: string | null;
  /** Per machine id: what it has, or null where it is not installed. */
  on: Record<string, { id: string; version: string | null; enabled: boolean } | null>;
  onlyHere: boolean;
  /** The machines it is wanted on and missing from or turned off on; empty when marked only here. */
  lacking: string[];
}

export interface MarketplaceRow {
  key: string;
  name: string;
  repo: string | null;
  /** The latest commit any machine heard its source has. */
  latest: string | null;
  /** Per machine id: the commit it is at, or null where it is not added. */
  on: Record<string, { name: string; commit: string | null } | null>;
  /** The machines that have it at another commit than the latest. */
  behind: string[];
}

export interface MachineStanding {
  inLine: boolean;
  missing: PluginRow[];
  disabled: PluginRow[];
  behind: MarketplaceRow[];
}

export interface PluginComparison {
  plugins: PluginRow[];
  marketplaces: MarketplaceRow[];
  /** Per machine id that has sent a report; one that has not is neither in line nor flagged. */
  machines: Record<string, MachineStanding>;
}

/**
 * Where the fleet's plugins differ. `onlyHere` holds the keys of the plugins
 * marked only here. A machine that has sent no report is left out of the
 * union and never flagged; a plugin installed only turned off counts for no
 * machine but is still listed.
 */
export function comparePlugins(machines: readonly MachinePlugins[], onlyHere: Pick<ReadonlySet<string>, "has">): PluginComparison {
  const known = machines.filter((m): m is MachinePlugins & { report: PluginsReport } => m.report !== null);
  const ids = known.map((m) => m.id);

  const marketplaces = new Map<string, MarketplaceRow>();
  // The latest commit as the most recent report heard it.
  const latestAt = new Map<string, number>();
  for (const m of known) {
    for (const mp of m.report.marketplaces) {
      const key = marketplaceKey(mp);
      let row = marketplaces.get(key);
      if (!row) {
        row = { key, name: mp.name, repo: mp.repo, latest: null, on: emptyOn(ids), behind: [] };
        marketplaces.set(key, row);
      }
      row.on[m.id] = { name: mp.name, commit: mp.commit };
      if (mp.latest && m.report.readAt >= (latestAt.get(key) ?? -Infinity)) {
        row.latest = mp.latest;
        latestAt.set(key, m.report.readAt);
      }
    }
  }
  for (const row of marketplaces.values()) {
    row.behind = ids.filter((id) => {
      const at = row.on[id];
      return !!at && !!row.latest && !!at.commit && at.commit !== row.latest;
    });
  }

  const plugins = new Map<string, PluginRow>();
  for (const m of known) {
    for (const p of m.report.plugins) {
      const { key, name, marketplace, mpKey, repo } = pluginIdentity(p.id, m.report.marketplaces);
      let row = plugins.get(key);
      if (!row) {
        row = { key, name, marketplace, marketplaceKey: mpKey, repo, on: emptyOn(ids), onlyHere: onlyHere.has(key), lacking: [] };
        plugins.set(key, row);
      }
      // One machine may have it twice (a renamed marketplace added again); an enabled copy stands.
      if (!row.on[m.id]?.enabled) row.on[m.id] = { id: p.id, version: p.version, enabled: p.enabled };
    }
  }
  for (const row of plugins.values()) {
    const wanted = !row.onlyHere && ids.some((id) => row.on[id]?.enabled);
    row.lacking = wanted ? ids.filter((id) => !row.on[id]?.enabled) : [];
  }

  const pluginRows = [...plugins.values()].sort(byName);
  const marketplaceRows = [...marketplaces.values()].sort(byName);
  const standings: Record<string, MachineStanding> = {};
  for (const m of known) {
    const lacking = pluginRows.filter((r) => r.lacking.includes(m.id));
    const missing = lacking.filter((r) => !r.on[m.id]);
    const disabled = lacking.filter((r) => !!r.on[m.id]);
    const behind = marketplaceRows.filter((r) => r.behind.includes(m.id));
    standings[m.id] = { inLine: lacking.length === 0 && behind.length === 0, missing, disabled, behind };
  }
  return { plugins: pluginRows, marketplaces: marketplaceRows, machines: standings };
}

/** One plugin to install: by its name from a marketplace the machine has, or from the marketplace's repo. */
type InstallStep = { name: string; marketplace: string } | { name: string; repo: string };

/** What "Bring in line" runs on one machine: marketplace update, then each install and enable. */
export interface AlignPlan {
  install: InstallStep[];
  /** Ids, as the machine names them, of plugins it has turned off. */
  enable: string[];
  /** Plugins it lacks from a marketplace it does not have and that has no repo to add it from. */
  unreachable: string[];
}

/** What bringing machine `id` in line takes, read off a comparison that includes it. */
export function alignPlan(comparison: PluginComparison, id: string): AlignPlan {
  const plan: AlignPlan = { install: [], enable: [], unreachable: [] };
  const standing = comparison.machines[id];
  if (!standing) return plan;
  for (const row of standing.disabled) {
    const have = row.on[id];
    if (have) plan.enable.push(have.id);
  }
  for (const row of standing.missing) {
    const local = comparison.marketplaces.find((m) => m.key === row.marketplaceKey)?.on[id];
    if (local) plan.install.push({ name: row.name, marketplace: local.name });
    else if (row.repo) plan.install.push({ name: row.name, repo: row.repo });
    else plan.unreachable.push(`${row.name}@${row.marketplace}`);
  }
  return plan;
}

/** Names that may reach the `claude plugin` CLI as an argument. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** An `owner/name` repo, or an https or ssh git URL. */
const SAFE_REPO = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+|https:\/\/[^\s]+|git@[^\s:]+:[^\s]+)$/;

/**
 * One request of "Bring in line". The page sends the marketplace update and
 * each install and enable as a request of its own, so none runs long enough
 * for the relay to give up on it, and the page can show where it is.
 */
export const AlignPlanSchema = z.object({
  /** Run `claude plugin marketplace update` first. */
  update: z.boolean().default(false),
  install: z
    .array(
      z.union([
        z.object({ name: z.string().regex(SAFE_NAME), marketplace: z.string().regex(SAFE_NAME) }),
        z.object({ name: z.string().regex(SAFE_NAME), repo: z.string().regex(SAFE_REPO) }),
      ]),
    )
    .max(200),
  enable: z
    .array(z.string().refine((id) => {
      const { name, marketplace } = splitPluginId(id);
      return SAFE_NAME.test(name) && SAFE_NAME.test(marketplace);
    }))
    .max(200),
});

export type AlignRequest = z.infer<typeof AlignPlanSchema>;

function emptyOn<T>(ids: readonly string[]): Record<string, T | null> {
  return Object.fromEntries(ids.map((id) => [id, null]));
}

function byName(a: { name: string; key: string }, b: { name: string; key: string }): number {
  return a.name.localeCompare(b.name) || a.key.localeCompare(b.key);
}
