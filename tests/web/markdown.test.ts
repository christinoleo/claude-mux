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
  const render = (text: string) => renderMarkdown(text, { files: href });

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

describe("renderMarkdown with GitHub links", () => {
  const render = (text: string, bare = false) => renderMarkdown(text, { github: { bare } });
  const pull = "https://github.com/christinoleo/claude-mux/pull/72";

  it("marks a bare URL to a pull request or issue, keeping it a plain link", () => {
    expect(render(`See ${pull}.`)).toBe(
      `<p>See <a class="gh-ref" href="${pull}" target="_blank" rel="noopener" data-repo="christinoleo/claude-mux" data-number="72">${pull}</a>.</p>\n`,
    );
    expect(render("https://github.com/o/r/issues/7")).toContain('data-repo="o/r" data-number="7"');
  });

  it("keeps the words the author wrote", () => {
    const html = render(`[the **file** PR](${pull})`);
    expect(html).toContain("data-words>the <strong>file</strong> PR</a>");
  });

  it("does not take a name for the target as the author's words", () => {
    expect(render(`[#72](${pull})`)).not.toContain("data-words");
    expect(render(`[christinoleo/claude-mux#72](${pull})`)).not.toContain("data-words");
    expect(render(`[${pull}](${pull})`)).not.toContain("data-words");
  });

  it("reads through what GitHub hangs after the number", () => {
    expect(render(`${pull}/files`)).toContain('data-number="72"');
    expect(render(`${pull}#issuecomment-1`)).toContain('data-number="72"');
  });

  it("leaves other links alone", () => {
    for (const text of [
      "https://github.com/christinoleo/claude-mux",
      "https://github.com/christinoleo/claude-mux/pulls",
      "https://github.com/christinoleo/claude-mux/commit/94a3a79",
      "https://github.com/christinoleo/claude-mux/pull/0",
      "https://example.com/o/r/pull/3",
      "[x](https://gitlab.com/o/r/issues/3)",
      "`https://github.com/o/r/pull/3`",
      "```\nhttps://github.com/o/r/pull/3\n```",
    ]) {
      expect(render(text, true), text).not.toContain("gh-ref");
    }
  });

  it("marks a bare #n only where the session has a repo to look it up in", () => {
    expect(render("Closes #70.")).toBe("<p>Closes #70.</p>\n");
    expect(render("Closes #70.", true)).toBe('<p>Closes <a class="gh-ref" data-number="70">#70</a>.</p>\n');
    expect(render("- (#12)\n- #13, #14", true).match(/data-number/g)).toHaveLength(3);
  });

  it("takes no #n out of a word, an entity, a link or code", () => {
    for (const text of ["a#12", "#12a", "#12-x", "&#123;", "#0", "# 12", "#111827", "`#12`", "[#12](https://example.com)", "x/#12"]) {
      expect(render(text, true), text).not.toContain("gh-ref");
    }
  });

  it("marks both files and GitHub links in one message", () => {
    const html = renderMarkdown(`src/a.ts fixes #3, see ${pull}`, { files: (p) => `/f/${p}`, github: { bare: true } });
    expect(html).toContain('data-file="src/a.ts"');
    expect(html).toContain('<a class="gh-ref" data-number="3">#3</a>');
    expect(html).toContain('data-repo="christinoleo/claude-mux"');
  });

  it("marks nothing unless asked", () => {
    expect(renderMarkdown(`#3 ${pull}`)).not.toContain("gh-ref");
  });
});

describe("renderMarkdown with githubBody", () => {
  const media = (url: string) => `/proxy?u=${encodeURIComponent(url)}`;
  const gh = (text: string) => renderMarkdown(text, { github: { bare: true }, githubBody: { media } });

  it("draws an alert whose marker stands alone on the first line", () => {
    const html = gh("> [!WARNING]\n> Mind the gap");
    expect(html).toContain('<div class="gh-alert gh-alert-warning"><p class="gh-alert-title">Warning</p>');
    expect(html).toContain("Mind the gap");
    expect(html).not.toContain("[!WARNING]");
  });

  it("leaves a marker with text after it on its line as a quote", () => {
    expect(gh("> [!NOTE] inline")).toContain("<blockquote>");
  });

  it("keeps details, summary and images, and drops comments", () => {
    const html = gh('<details>\n<summary>Logs</summary>\n\nbody\n\n</details>\n\n<img src="https://github.com/user-attachments/assets/1" width="40" onerror="x()"> <!-- bot:marker -->');
    expect(html).toContain("<details>");
    expect(html).toContain("<summary>Logs</summary>");
    expect(html).toContain('<img src="/proxy?u=https%3A%2F%2Fgithub.com%2Fuser-attachments%2Fassets%2F1" width="40" loading="lazy">');
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("bot:marker");
  });

  it("shows a tag it does not keep as text", () => {
    expect(gh('<script>alert(1)</script> <a href="javascript:x()">x</a>')).toContain("&lt;script&gt;");
    expect(gh('<a href="javascript:x()">x</a>')).not.toContain("javascript:");
  });

  it("passes markdown images through media and sends links to a new tab", () => {
    const html = gh("![shot](https://github.com/user-attachments/assets/2) [docs](https://example.com)");
    expect(html).toContain('src="/proxy?u=');
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener">docs</a>');
  });

  it("still marks references to issues as chips", () => {
    expect(gh("see #12")).toContain('<a class="gh-ref" data-number="12">#12</a>');
  });
});
