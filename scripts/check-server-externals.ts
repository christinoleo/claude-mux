/**
 * Fail the release when the built web server imports a package the published
 * claude-mux will not have.
 *
 * SvelteKit leaves a web `dependencies` entry as a bare import in the server
 * bundle, but `npm i -g claude-mux` installs only the root package's
 * dependencies, so such an import breaks every page that reaches it (0.30.0
 * served `/` as a 500 because `marked` was one). Web packages belong in web
 * `devDependencies`, where Vite bundles them.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { builtinModules } from "module";
import { join } from "path";

const root = join(import.meta.dir, "..");
const serverDir = join(root, "dist/web/server");
const allowed = new Set([
  ...Object.keys(JSON.parse(readFileSync(join(root, "package.json"), "utf-8")).dependencies ?? {}),
  ...builtinModules,
]);

function* jsFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* jsFiles(path);
    else if (name.endsWith(".js")) yield path;
  }
}

// Static imports open their line in Vite's output; a dynamic one may sit mid-line.
const IMPORT = /^\s*(?:import|export)\b[^;'"]*?from\s*["']([^"'./$][^"']*)["']|^\s*import\s*["']([^"'./$][^"']*)["']|\bimport\(\s*["']([^"'./$][^"']*)["']\s*\)/gm;

/** The source with comment lines dropped, so JSDoc's `import('x').Type` is not read as an import. */
function code(file: string): string {
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/.test(line))
    .join("\n");
}

const missing = new Map<string, string>();
for (const file of jsFiles(serverDir)) {
  for (const m of code(file).matchAll(IMPORT)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec.startsWith("node:")) continue;
    const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    if (!allowed.has(pkg) && !missing.has(pkg)) missing.set(pkg, file.slice(root.length + 1));
  }
}

if (missing.size) {
  for (const [pkg, file] of missing) console.error(`server bundle imports "${pkg}" (${file}), which the published package does not install`);
  console.error("Move it to web devDependencies so Vite bundles it, or to the root dependencies.");
  process.exit(1);
}
console.log("server bundle: every bare import is installed with the package");
