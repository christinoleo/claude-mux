/**
 * The usage contract, re-exported from the server modules that define it.
 *
 * Hand-copying these into each component is how a server field silently stops
 * reaching the UI, so components import from here instead. The relative reach
 * into `src/` matches what the API routes and the transcript store already do.
 */
export type {
	UsageCell,
	UsageDay,
	UsageModel,
	UsageProject,
	UsageReport
} from '../../../../src/usage/aggregate.js';
export type { FleetMachine, FleetResponse } from '../../../../src/usage/fleet.js';
export type {
	QuotaLimit,
	QuotaResult,
	QuotaUnavailable
} from '../../../../src/usage/quota.js';
export type { UsageResponse } from '../../../../src/usage/report.js';
