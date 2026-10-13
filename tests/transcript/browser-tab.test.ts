import { describe, it, expect } from "vitest";
import { lastBrowserPageIn, selectedPage } from "../../src/transcript/browser-tab.js";

const use = (id: string, name: string, input: unknown = {}) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id: string, text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }], ...extra }] } });

describe("selectedPage", () => {
  it("reads the selected page off the list, titled or bare", () => {
    expect(selectedPage("## Pages\n1: https://a.example/\n2: https://b.example/x [selected]")).toBe("https://b.example/x");
    expect(selectedPage("ok\n## Pages\n1: Inbox (3) (https://mail.example/u/0) [selected]\n2: https://b.example/")).toBe(
      "https://mail.example/u/0"
    );
  });

  it("does not mistake a bracket in a bare URL for a title's", () => {
    expect(selectedPage("## Pages\n1: https://en.wikipedia.org/wiki/Mercury_(planet) [selected]")).toBe(
      "https://en.wikipedia.org/wiki/Mercury_(planet)"
    );
    expect(selectedPage("## Pages\n1: Mercury (planet) (https://en.wikipedia.org/wiki/Mercury_(planet)) [selected]")).toBe(
      "https://en.wikipedia.org/wiki/Mercury_(planet)"
    );
  });

  it("finds none where the result lists no pages or marks none", () => {
    expect(selectedPage("Could not connect to Chrome.")).toBeNull();
    expect(selectedPage("## Pages\n1: https://a.example/")).toBeNull();
  });
});

describe("lastBrowserPageIn", () => {
  it("follows the latest page list from the server's tools", () => {
    const lines = [
      use("t1", "mcp__brave-windows__new_page", { url: "https://a.example/" }),
      result("t1", "## Pages\n1: https://old.example/\n2: https://a.example/ [selected]"),
      use("t2", "mcp__brave-windows__select_page", { pageId: 1 }),
      result("t2", "## Pages\n1: Old (https://old.example/) [selected]\n2: https://a.example/"),
    ];
    expect(lastBrowserPageIn(lines.slice(0, 2), "brave-windows")).toBe("https://a.example/");
    expect(lastBrowserPageIn(lines, "brave-windows")).toBe("https://old.example/");
  });

  it("falls back to the URL a new_page asked for when its result lists nothing", () => {
    const lines = [use("t1", "mcp__brave-windows__new_page", { url: "https://a.example/" }), result("t1", "Opened.")];
    expect(lastBrowserPageIn(lines, "brave-windows")).toBe("https://a.example/");
  });

  it("ignores failed calls, other servers and lines that are not JSON", () => {
    const lines = [
      use("t1", "mcp__brave-windows__new_page", { url: "https://a.example/" }),
      result("t1", "## Pages\n1: https://a.example/ [selected]"),
      "{ torn line",
      use("t2", "mcp__brave-windows__new_page", { url: "https://b.example/" }),
      result("t2", "Could not connect to Chrome.", { is_error: true }),
      use("t3", "mcp__chrome-devtools__new_page", { url: "https://local.example/" }),
      result("t3", "## Pages\n1: https://local.example/ [selected]"),
    ];
    expect(lastBrowserPageIn(lines, "brave-windows")).toBe("https://a.example/");
    expect(lastBrowserPageIn([], "brave-windows")).toBeNull();
  });
});
