import { describe, it, expect } from "vitest";
import { isGithubMediaUrl } from "../../src/server/github-media.js";

describe("isGithubMediaUrl", () => {
  it("takes GitHub's attachments and content hosts", () => {
    expect(isGithubMediaUrl("https://github.com/user-attachments/assets/1b2c")).toBe(true);
    expect(isGithubMediaUrl("https://github.com/o/r/assets/123/abc")).toBe(true);
    expect(isGithubMediaUrl("https://github.com/o/r/raw/main/shot.png")).toBe(true);
    expect(isGithubMediaUrl("https://raw.githubusercontent.com/o/r/main/a.png")).toBe(true);
    expect(isGithubMediaUrl("https://private-user-images.githubusercontent.com/1/x.png?jwt=y")).toBe(true);
  });

  it("refuses anything else", () => {
    expect(isGithubMediaUrl("https://github.com/o/r/pull/1")).toBe(false);
    expect(isGithubMediaUrl("https://github.com/settings/tokens")).toBe(false);
    expect(isGithubMediaUrl("http://github.com/user-attachments/assets/1")).toBe(false);
    expect(isGithubMediaUrl("https://evil.com/user-attachments/assets/1")).toBe(false);
    expect(isGithubMediaUrl("https://x@github.com/user-attachments/assets/1")).toBe(false);
    expect(isGithubMediaUrl("https://camo.githubusercontent.com/abc")).toBe(false);
    expect(isGithubMediaUrl("not a url")).toBe(false);
  });
});
