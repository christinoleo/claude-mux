/**
 * Merges per-machine usage reports into one.
 *
 * Cost adds up across machines — tokens spent on one host were not spent on
 * another. Subscription quota does not: the plan belongs to the account, so it
 * is read from a single host and shown once. That asymmetry is why quota lives
 * in its own endpoint rather than travelling with this.
 *
 * A machine that fails to answer is reported as such rather than dropped. A
 * total quietly missing a host is worse than a total that says so.
 */

import { unpricedModels, type UsageCell, type UsageDay, type UsageModel, type UsageProject, type UsageReport } from "./aggregate.js";
import { addTotals, EMPTY_TOTALS } from "./pricing.js";
import { buildUsageReport, type UsageResponse } from "./report.js";

export interface MachineInput {
  hostname: string;
  /** Null when the machine could not be reached. */
  report: UsageReport | null;
  error?: string;
}

export interface FleetMachine {
  hostname: string;
  ok: boolean;
  costUsd: number;
  error?: string;
}

export interface FleetReport extends UsageReport {
  machines: FleetMachine[];
}

export function mergeReports(inputs: readonly MachineInput[], timeZone: string): FleetReport {
  const days = new Map<string, UsageDay>();
  const projects = new Map<string, UsageProject>();
  const models = new Map<string, UsageModel>();
  const machines: FleetMachine[] = [];

  let costUsd = 0;
  let cacheSavingsUsd = 0;
  let totals = EMPTY_TOTALS;
  let sessions = 0;
  let records = 0;

  for (const input of inputs) {
    if (input.report === null) {
      machines.push({ hostname: input.hostname, ok: false, costUsd: 0, error: input.error });
      continue;
    }
    const report = input.report;
    machines.push({ hostname: input.hostname, ok: true, costUsd: report.costUsd });

    costUsd += report.costUsd;
    cacheSavingsUsd += report.cacheSavingsUsd;
    totals = addTotals(totals, report.totals);
    // Session ids are unique per machine, so these never double count.
    sessions += report.sessions;
    records += report.records;

    for (const day of report.days) {
      const tagged: UsageCell[] = day.cells.map((cell) => ({ ...cell, machine: input.hostname }));
      const existing = days.get(day.date);
      if (existing) {
        existing.costUsd += day.costUsd;
        existing.totals = addTotals(existing.totals, day.totals);
        existing.cells.push(...tagged);
      } else {
        days.set(day.date, {
          date: day.date,
          costUsd: day.costUsd,
          totals: day.totals,
          cells: tagged,
        });
      }
    }

    // A repo checked out on two machines is one project; the machine dimension
    // is what tells them apart when the reader asks for it.
    for (const project of report.projects) {
      const existing = projects.get(project.key);
      if (existing) {
        existing.costUsd += project.costUsd;
        existing.tokens += project.tokens;
      } else {
        projects.set(project.key, { ...project });
      }
    }

    for (const model of report.models) {
      const existing = models.get(model.model);
      if (existing) {
        existing.costUsd += model.costUsd;
        existing.tokens += model.tokens;
        existing.priced = existing.priced || model.priced;
      } else {
        models.set(model.model, { ...model });
      }
    }
  }

  return {
    timeZone,
    costUsd,
    cacheSavingsUsd,
    totals,
    days: [...days.values()]
      .map((day) => ({ ...day, cells: day.cells.sort((a, b) => b.costUsd - a.costUsd) }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    projects: [...projects.values()].sort((a, b) => b.costUsd - a.costUsd),
    models: [...models.values()].sort((a, b) => b.costUsd - a.costUsd),
    sessions,
    records,
    machines: machines.sort((a, b) => a.hostname.localeCompare(b.hostname)),
  };
}

export interface FleetPeer {
  hostname: string;
  url: string;
}

export interface FleetDiscovery {
  servers: FleetPeer[];
  self: string;
  error?: string;
}

export interface FleetOptions {
  days: number;
  fromMs?: number;
  timeZone?: string;
  discover: () => Promise<FleetDiscovery>;
  fetch: typeof globalThis.fetch;
  /** This host's own report. Injectable so the fan-out is testable. */
  loadLocal?: () => Promise<UsageResponse>;
  /** Per-peer budget. A peer scans its own transcripts before answering. */
  timeoutMs?: number;
}

export interface FleetResponse extends FleetReport {
  windowDays: number;
  generatedAtMs: number;
  rates: UsageResponse["rates"];
  scan: UsageResponse["scan"];
  unpricedModels: string[];
  discoveryError?: string;
}

const DEFAULT_PEER_TIMEOUT_MS = 8000;

/**
 * Cost across every claude-mux on the tailnet.
 *
 * Each peer scans its own transcripts and returns buckets, so what crosses the
 * network is kilobytes of aggregate rather than raw transcript lines. Discovery
 * and the local scan are independent, so they run together — a peer listed but
 * dead would otherwise stall the local work behind its timeout.
 */
export async function buildFleetReport(options: FleetOptions): Promise<FleetResponse> {
  const loadLocal =
    options.loadLocal ??
    (() => buildUsageReport({ fromMs: options.fromMs, timeZone: options.timeZone }));
  const [discovery, local] = await Promise.all([options.discover(), loadLocal()]);

  const selfName = discovery.self || "local";
  const timeZone = options.timeZone ?? local.timeZone;
  const query = `days=${options.days}&tz=${encodeURIComponent(timeZone)}`;
  const timeout = options.timeoutMs ?? DEFAULT_PEER_TIMEOUT_MS;

  const peers = discovery.servers.filter((server) => server.hostname !== selfName);
  const fetched = await Promise.all(
    peers.map(async (peer): Promise<MachineInput> => {
      try {
        const response = await options.fetch(`${peer.url}/api/usage?${query}`, {
          signal: AbortSignal.timeout(timeout),
        });
        if (!response.ok) {
          return { hostname: peer.hostname, report: null, error: `HTTP ${response.status}` };
        }
        return { hostname: peer.hostname, report: (await response.json()) as UsageReport };
      } catch (err) {
        return {
          hostname: peer.hostname,
          report: null,
          error: err instanceof Error ? err.message : "unreachable",
        };
      }
    })
  );

  const merged = mergeReports([{ hostname: selfName, report: local }, ...fetched], timeZone);
  return {
    ...merged,
    windowDays: options.days,
    generatedAtMs: Date.now(),
    // Rates and scan describe this host's own work; a peer reports its own.
    rates: local.rates,
    scan: local.scan,
    unpricedModels: unpricedModels(merged),
    ...(discovery.error ? { discoveryError: discovery.error } : {}),
  };
}
