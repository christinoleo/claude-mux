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
