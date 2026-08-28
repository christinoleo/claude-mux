/**
 * Folds usage records into priced day buckets.
 *
 * Pure: bucketing and pricing are testable without a filesystem or a network.
 */

import {
  addInto,
  EMPTY_TOTALS,
  lookupRate,
  priceWithRate,
  savingsWithRate,
  totalTokens,
  type ModelRate,
  type RateTable,
  type TokenTotals,
} from "./pricing.js";
import { makeDayFormatter } from "./day.js";
import type { UsageRecord } from "./transcripts.js";

/** A record already attributed to a project directory. */
export interface AttributedRecord extends UsageRecord {
  project: string;
}

/**
 * One day's cost for one project/model pair.
 *
 * The cross product rather than two separate breakdowns: the chart lets the
 * reader colour by one dimension while splitting by the other, which cannot be
 * reconstructed from per-dimension totals. Only non-empty pairs are emitted.
 */
export interface UsageCell {
  project: string;
  model: string;
  costUsd: number;
  tokens: number;
  /** Set only once a report is merged across machines. */
  machine?: string;
}

export interface UsageDay {
  /** `YYYY-MM-DD` in the reporting zone. */
  date: string;
  costUsd: number;
  totals: TokenTotals;
  cells: UsageCell[];
}

export interface UsageProject {
  key: string;
  /** The real cwd when one was seen, else the escaped directory. */
  label: string;
  costUsd: number;
  tokens: number;
}

export interface UsageModel {
  model: string;
  costUsd: number;
  tokens: number;
  priced: boolean;
}

export interface UsageReport {
  timeZone: string;
  costUsd: number;
  cacheSavingsUsd: number;
  totals: TokenTotals;
  days: UsageDay[];
  projects: UsageProject[];
  models: UsageModel[];
  sessions: number;
  records: number;
}

export { makeDayFormatter } from "./day.js";

export interface AggregateOptions {
  timeZone: string;
  /** Escaped project key -> real cwd, used only for labels. */
  projectLabels?: ReadonlyMap<string, string>;
  fromMs?: number;
  toMs?: number;
}

interface DayAccumulator {
  costUsd: number;
  totals: TokenTotals;
  cells: Map<string, UsageCell>;
}

/** Models in a report that no rate table could price. */
export function unpricedModels(report: UsageReport): string[] {
  return report.models.filter((model) => !model.priced).map((model) => model.model);
}

export function aggregateUsage(
  records: readonly AttributedRecord[],
  table: RateTable,
  options: AggregateOptions
): UsageReport {
  const dayOf = makeDayFormatter(options.timeZone);
  const days = new Map<string, DayAccumulator>();
  const projectCost = new Map<string, number>();
  const projectTokens = new Map<string, number>();
  const modelCost = new Map<string, number>();
  const modelTokens = new Map<string, number>();
  const sessions = new Set<string>();

  let costUsd = 0;
  let savings = 0;
  const totals = { ...EMPTY_TOTALS };
  let counted = 0;

  // One rate lookup per distinct model rather than two per record: resolving a
  // rate lowercases and trims the model name, which is not free across tens of
  // thousands of rows.
  const rates = new Map<string, ModelRate | null>();
  const rateFor = (model: string): ModelRate | null => {
    let rate = rates.get(model);
    if (rate === undefined) {
      rate = lookupRate(table, model);
      rates.set(model, rate);
    }
    return rate;
  };

  for (const record of records) {
    if (options.fromMs !== undefined && record.timestampMs < options.fromMs) continue;
    if (options.toMs !== undefined && record.timestampMs > options.toMs) continue;

    const rate = rateFor(record.model);
    const priced = priceWithRate(rate, record.totals, record.reportedCostUsd);
    const tokens = totalTokens(record.totals);
    const project = record.project;
    const date = dayOf(record.timestampMs);

    let day = days.get(date);
    if (!day) {
      // A fresh object: `addInto` mutates, and EMPTY_TOTALS is shared.
      day = { costUsd: 0, totals: { ...EMPTY_TOTALS }, cells: new Map() };
      days.set(date, day);
    }
    day.costUsd += priced.costUsd;
    addInto(day.totals, record.totals);

    const cellKey = `${project}\u0000${record.model}`;
    const cell = day.cells.get(cellKey);
    if (cell) {
      cell.costUsd += priced.costUsd;
      cell.tokens += tokens;
    } else {
      day.cells.set(cellKey, {
        project,
        model: record.model,
        costUsd: priced.costUsd,
        tokens,
      });
    }

    projectCost.set(project, (projectCost.get(project) ?? 0) + priced.costUsd);
    projectTokens.set(project, (projectTokens.get(project) ?? 0) + tokens);
    modelCost.set(record.model, (modelCost.get(record.model) ?? 0) + priced.costUsd);
    modelTokens.set(record.model, (modelTokens.get(record.model) ?? 0) + tokens);
    if (record.sessionId) sessions.add(record.sessionId);

    costUsd += priced.costUsd;
    savings += savingsWithRate(rate, record.totals);
    addInto(totals, record.totals);
    counted++;
  }

  const labels = options.projectLabels;
  return {
    timeZone: options.timeZone,
    costUsd,
    cacheSavingsUsd: savings,
    totals,
    days: [...days]
      .map(([date, day]) => ({
        date,
        costUsd: day.costUsd,
        totals: day.totals,
        cells: [...day.cells.values()].sort((a, b) => b.costUsd - a.costUsd),
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    projects: [...projectCost]
      .map(([key, cost]) => ({
        key,
        label: labels?.get(key) ?? key,
        costUsd: cost,
        tokens: projectTokens.get(key) ?? 0,
      }))
      .sort((a, b) => b.costUsd - a.costUsd),
    models: [...modelCost]
      .map(([model, cost]) => ({
        model,
        costUsd: cost,
        tokens: modelTokens.get(model) ?? 0,
        priced: rateFor(model) !== null,
      }))
      .sort((a, b) => b.costUsd - a.costUsd),
    sessions: sessions.size,
    records: counted,
  };
}
