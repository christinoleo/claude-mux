#!/usr/bin/env bun
import { $ } from 'bun';
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEEP_PREVIOUS = 1;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist-electron');
const DOWNLOADS = join(ROOT, 'releases');

if (!existsSync(DOWNLOADS)) mkdirSync(DOWNLOADS, { recursive: true });

console.log('building electron AppImage');
await $`bunx electron-builder --linux AppImage`.cwd(ROOT);

const built = readdirSync(DIST).filter((f) => f.endsWith('.AppImage'));
if (built.length === 0) throw new Error('no AppImage produced');
const latestYml = readdirSync(DIST).find((f) => f === 'latest-linux.yml');
if (!latestYml) throw new Error('latest-linux.yml missing');

const stale = readdirSync(DOWNLOADS)
	.filter((f) => /^claude-mux-.*\.AppImage$/.test(f))
	.map((f) => ({ f, m: statSync(join(DOWNLOADS, f)).mtimeMs }))
	.sort((a, b) => b.m - a.m)
	.slice(KEEP_PREVIOUS);
for (const { f } of stale) unlinkSync(join(DOWNLOADS, f));

for (const f of [...built, latestYml]) {
	renameSync(join(DIST, f), join(DOWNLOADS, f));
}

console.log('released', built[0]);
console.log('  appimage:', join(DOWNLOADS, built[0]));
console.log('  manifest:', join(DOWNLOADS, latestYml));
