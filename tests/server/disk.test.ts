import { describe, it, expect } from 'vitest';
import { homedir } from 'os';
import { homeDiskPercent, usedPercent } from '../../src/server/disk.js';

describe('usedPercent', () => {
	it('reads use as df does, leaving root-reserved blocks out of the whole', () => {
		// 100 blocks, 30 free, of which 25 an ordinary user may take: 70 used of 95.
		expect(usedPercent({ blocks: 100, bfree: 30, bavail: 25 })).toBe(74);
	});

	it('rounds a fraction up, as df does, so a meter never reads under its threshold', () => {
		// 794 of 1000 is 79.4%: df says 80%, and so does the meter.
		expect(usedPercent({ blocks: 1000, bfree: 206, bavail: 206 })).toBe(80);
	});

	it('reads a disk with nothing left for a user as full', () => {
		expect(usedPercent({ blocks: 100, bfree: 5, bavail: 0 })).toBe(100);
	});

	it('reads an empty filesystem as unused', () => {
		expect(usedPercent({ blocks: 0, bfree: 0, bavail: 0 })).toBe(0);
	});
});

describe('homeDiskPercent', () => {
	it('reads the home filesystem as a share between 0 and 100', async () => {
		const percent = await homeDiskPercent(homedir());
		expect(percent).not.toBeNull();
		expect(percent).toBeGreaterThanOrEqual(0);
		expect(percent).toBeLessThanOrEqual(100);
	});

	it('answers null for a path that does not exist', async () => {
		expect(await homeDiskPercent('/no/such/place/at/all')).toBeNull();
	});
});
