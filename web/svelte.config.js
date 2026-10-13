import adapter from 'svelte-adapter-bun';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter({
			out: '../dist/web',
			precompress: false
		}),
		alias: {
			$shared: join(__dirname, '../src')
		},
		// A tab outlives the server it was loaded from: an update restarts the
		// server under it, and the old page then talks to routes that have moved
		// on. The page asks for the version now and then (see +layout.svelte).
		version: { pollInterval: 60_000 }
	}
};

export default config;
