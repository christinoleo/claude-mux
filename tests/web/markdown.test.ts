import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../../web/src/lib/markdown.js";

describe("renderMarkdown", () => {
  it("breaks a plain paragraph's lines the way the TUI prints them", () => {
    expect(renderMarkdown("1\n2\n3")).toBe("<p>1<br>2<br>3</p>\n");
  });

  it("breaks lines inside emphasis and quotes too", () => {
    expect(renderMarkdown("**a\nb**")).toBe("<p><strong>a<br>b</strong></p>\n");
    expect(renderMarkdown("> a\n> b")).toBe("<blockquote>\n<p>a<br>b</p>\n</blockquote>\n");
  });

  it("leaves a list item and its continuation line as one line", () => {
    const html = renderMarkdown("- first item\n  continued here\n- second");
    expect(html).not.toContain("<br>");
    expect(html).toContain("<li>first item\ncontinued here</li>");
  });

  it("leaves code alone", () => {
    expect(renderMarkdown("```\na\nb\n```")).toBe("<pre><code>a\nb\n</code></pre>\n");
    expect(renderMarkdown("x `a\nb` y")).not.toContain("<br>");
  });

  it("renders raw HTML as text", () => {
    expect(renderMarkdown("<b>hi</b>")).toBe("<p>&lt;b&gt;hi&lt;/b&gt;</p>\n");
  });
});

describe("renderMarkdown with file links", () => {
  const href = (path: string, line: number | null) => `?file=${path}${line ? `&line=${line}` : ""}`;
  const render = (text: string) => renderMarkdown(text, href);

  it("links a path in backticks and keeps it code", () => {
    expect(render("see `web/src/lib/markdown.ts`")).toBe(
      '<p>see <a class="file-link" href="?file=web/src/lib/markdown.ts" data-file="web/src/lib/markdown.ts"><code>web/src/lib/markdown.ts</code></a></p>\n'
    );
  });

  it("carries the line, and shows the text as written", () => {
    expect(render("`src/tmux/pane.ts:120`")).toBe(
      '<p><a class="file-link" href="?file=src/tmux/pane.ts&amp;line=120" data-file="src/tmux/pane.ts" data-line="120"><code>src/tmux/pane.ts:120</code></a></p>\n'
    );
  });

  it("links a path in plain text, and leaves the sentence's full stop out", () => {
    expect(render("Fixed in src/tmux/pane.ts:120.")).toBe(
      '<p>Fixed in <a class="file-link" href="?file=src/tmux/pane.ts&amp;line=120" data-file="src/tmux/pane.ts" data-line="120">src/tmux/pane.ts:120</a>.</p>\n'
    );
  });

  it("links inside lists, tables, headings and emphasis", () => {
    expect(render("- `a/b.ts`\n- c/d.ts")).toContain('data-file="c/d.ts"');
    expect(render("- `a/b.ts`\n- c/d.ts")).toContain('data-file="a/b.ts"');
    expect(render("| f |\n|---|\n| `a/b.ts` |")).toContain('data-file="a/b.ts"');
    expect(render("## `a/b.ts`")).toContain('data-file="a/b.ts"');
    expect(render("**a/b.ts**")).toContain('<strong><a class="file-link"');
  });

  it("leaves URLs, versions and prose alone", () => {
    for (const text of [
      "https://example.com/a/b.html",
      "`https://example.com/a/b.html`",
      "[src/a.ts](https://example.com/src/a.ts)",
      "v0.30.8",
      "`v0.30.8`",
      "and/or",
      "`and/or`",
    ]) {
      expect(render(text), text).not.toContain("file-link");
    }
  });

  it("leaves code blocks alone", () => {
    expect(render("```\nsrc/a.ts\n```")).not.toContain("file-link");
  });

  it("links nothing unless asked", () => {
    expect(renderMarkdown("`src/a.ts` and src/b.ts")).toBe("<p><code>src/a.ts</code> and src/b.ts</p>\n");
  });
});
