import { describe, it, expect } from "vitest";
import {
  ancestors,
  fuzzyFilter,
  fuzzyScore,
  shikiLanguage,
  toolFileTarget,
} from "../../web/src/lib/side-panel/files.js";

describe("shikiLanguage", () => {
  it("names a grammar by extension or file name, else null", () => {
    expect(shikiLanguage("src/cli.ts")).toBe("typescript");
    expect(shikiLanguage("web/App.svelte")).toBe("svelte");
    expect(shikiLanguage("README.md")).toBe("markdown");
    expect(shikiLanguage("Dockerfile.dev")).toBe("docker");
    expect(shikiLanguage(".gitignore")).toBe("shellscript");
    expect(shikiLanguage("LICENSE")).toBeNull();
  });
});

describe("paths", () => {
  it("lists the directories that hold a path", () => {
    expect(ancestors("a/b/c.ts")).toEqual(["a", "a/b"]);
    expect(ancestors("c.ts")).toEqual([]);
  });
});

describe("fuzzy match", () => {
  it("needs every character in order", () => {
    expect(fuzzyScore("cli", "src/cli.ts")).not.toBeNull();
    expect(fuzzyScore("ilc", "src/cli.ts")).toBeNull();
  });

  it("ranks a match in the file name over one spread through the path", () => {
    const paths = ["src/commands/list.ts", "src/cli.ts", "web/src/lib/components/ContextGauge.svelte"];
    expect(fuzzyFilter("cli", paths)[0]).toBe("src/cli.ts");
    expect(fuzzyFilter("gauge", paths)).toEqual(["web/src/lib/components/ContextGauge.svelte"]);
  });
});

describe("toolFileTarget", () => {
  it("opens a Read at its offset", () => {
    expect(
      toolFileTarget({ name: "Read", input: JSON.stringify({ file_path: "/r/a.ts", offset: 40 }) })
    ).toEqual({ path: "/r/a.ts", line: 40 });
    expect(toolFileTarget({ name: "Read", input: JSON.stringify({ file_path: "/r/a.ts" }) })).toEqual({
      path: "/r/a.ts",
      line: null,
    });
  });

  it("opens an edit at the first line it changed", () => {
    const entry = {
      name: "Edit",
      input: JSON.stringify({ file_path: "/r/a.ts" }),
      patch: { file: "/r/a.ts", hunks: [{ header: "@@ -10,7 +10,8 @@", lines: [" a", " b", "-c", "+C", "+D", " e"] }] },
    };
    expect(toolFileTarget(entry)).toEqual({ path: "/r/a.ts", line: 12 });
  });

  it("reads the path out of input cut off mid-way", () => {
    expect(toolFileTarget({ name: "Write", input: '{"file_path": "/r/b.md", "content": "# He' })).toEqual({
      path: "/r/b.md",
      line: null,
    });
  });

  it("ignores other tools", () => {
    expect(toolFileTarget({ name: "Bash", input: '{"command":"ls"}' })).toBeNull();
  });
});
