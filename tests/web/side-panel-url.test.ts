import { describe, it, expect } from "vitest";
import { panelQuery, readPaneParams, readPanel } from "../../web/src/lib/side-panel/url.js";

const KINDS = ["project", "changes", "files"] as const;
const PANE_PARAMS = ["file", "turn", "line", "url"];
const q = (s: string) => new URLSearchParams(s);

describe("side panel URL", () => {
  it("reads only a known pane kind", () => {
    expect(readPanel(q("panel=files"), KINDS)).toBe("files");
    expect(readPanel(q("panel=nope"), KINDS)).toBeNull();
    expect(readPanel(q("view=terminal"), KINDS)).toBeNull();
  });

  it("reads the params a pane owns", () => {
    expect(readPaneParams(q("panel=files&file=src/cli.ts&line=12&view=terminal"), ["file", "line"])).toEqual({
      file: "src/cli.ts",
      line: "12",
    });
  });

  it("drops the other panes' params when switching, and keeps the page's own", () => {
    const next = panelQuery(q("view=terminal&embed=1&panel=changes&file=a.ts&turn=3"), "files", PANE_PARAMS, {
      line: "9",
    });
    expect(next.toString()).toBe("view=terminal&embed=1&panel=files&line=9");
  });

  it("keeps the pane's params when the same pane is opened again", () => {
    const next = panelQuery(q("panel=files&file=a.ts&line=4"), "files", PANE_PARAMS, { line: "5" });
    expect(next.toString()).toBe("panel=files&file=a.ts&line=5");
  });

  it("removes a param given as null", () => {
    const next = panelQuery(q("panel=files&file=a.ts&line=4"), "files", PANE_PARAMS, { line: null });
    expect(next.toString()).toBe("panel=files&file=a.ts");
  });

  it("closes the panel with every pane param", () => {
    expect(panelQuery(q("with=x&panel=web&url=dev"), null, PANE_PARAMS).toString()).toBe("with=x");
  });
});
