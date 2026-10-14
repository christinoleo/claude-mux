import { statfsSync } from 'fs';
import { homedir } from 'os';

/** The block counts of `statfs` that `df` reads its "Use%" from. */
export interface BlockCounts {
	blocks: number;
	bfree: number;
	bavail: number;
}

/**
 * Share of a filesystem in use, as `df` reports it: the blocks reserved for
 * root count as neither used nor available, so a disk an ordinary user can no
 * longer write to reads 100%.
 */
export function usedPercent({ blocks, bfree, bavail }: BlockCounts): number {
	const used = blocks - bfree;
	const usable = used + bavail;
	return usable > 0 ? Math.round((used / usable) * 100) : 0;
}

/** Use of the filesystem holding the home directory, or null where it cannot be read. */
export function homeDiskPercent(path: string = homedir()): number | null {
	try {
		return usedPercent(statfsSync(path));
	} catch {
		return null;
	}
}
