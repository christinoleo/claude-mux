import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { buildUsageReport, parseUsageQuery } from '../../../../../src/usage/report.js';

/**
 * Token cost for this host, read from the local Claude Code transcripts.
 *
 * The caller passes its own time zone so the chart matches the reader's
 * calendar rather than the server's.
 */
export const GET: RequestHandler = async ({ url }) => {
	const { days, ...query } = parseUsageQuery(url.searchParams);
	try {
		const report = await buildUsageReport(query);
		return json({ ...report, windowDays: days });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'usage scan failed';
		return json({ error: message }, { status: 500 });
	}
};
