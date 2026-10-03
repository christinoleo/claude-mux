import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

/**
 * The page has one stacking order, the `--z-*` tokens in web/src/app.css.
 * Popovers kept opening under the mobile drawer because each layer picked its
 * own number (drawer 60, popover 50, dialogs patched to 70 one at a time), so
 * any z-index that can compete with another layer must use a token. A raw
 * number up to 10 is left alone: that orders siblings inside one component.
 */
const WEB_SRC = join(__dirname, "../../web/src");
const LOCAL_MAX = 10;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(svelte|css|ts)$/.test(name) ? [path] : [];
  });
}

function rawLayers(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/z-index:\s*(\d+)/g)) {
    if (Number(m[1]) > LOCAL_MAX) found.push(m[0]);
  }
  // Tailwind: z-50, z-[70], -z-20. A token reads z-(--z-…) and is not matched.
  for (const m of source.matchAll(/(?<![\w-])-?z-(\d+|\[\d+\])(?![\w-])/g)) {
    if (Number(m[1].replace(/[[\]]/g, "")) > LOCAL_MAX) found.push(m[0]);
  }
  return found;
}

describe("z-index", () => {
  it("takes every page-level layer from the --z-* tokens in app.css", () => {
    const offenders = files(WEB_SRC).flatMap((path) =>
      rawLayers(readFileSync(path, "utf-8")).map((hit) => `${relative(WEB_SRC, path)}: ${hit}`)
    );
    expect(offenders).toEqual([]);
  });

  it("catches a raw layer in either syntax", () => {
    expect(rawLayers("z-index: 60;")).toEqual(["z-index: 60"]);
    expect(rawLayers('class="fixed z-50 grid"')).toEqual(["z-50"]);
    expect(rawLayers('class="z-[70]"')).toEqual(["z-[70]"]);
    expect(rawLayers("z-index: 3; class=\"z-(--z-floating)\" z-index: var(--z-drawer);")).toEqual([]);
  });
});
