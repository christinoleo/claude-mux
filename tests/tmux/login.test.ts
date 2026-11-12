import { describe, it, expect } from "vitest";
import { readLoginScreen } from "../../src/tmux/login.js";

const URL_HEAD =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&response_type=code&scope=user%3Aprofile+user";
const URL_TAIL = "%3Amcp_servers&code_challenge=hOGM&state=2sFS";

/** /login's code step, captured from a pane: the link wraps at the pane's width. */
const CODE = [
  "❯ /login",
  "─".repeat(60),
  "  Login",
  "  Browser didn't open? Use the url below to sign in (c to copy)",
  URL_HEAD,
  URL_TAIL,
  "",
  "",
  "  Paste code here if prompted >",
  "",
  "  Esc to cancel",
].join("\n");

/** `! claude auth login` run as a shell command, captured from a 140-column pane: the link follows `visit:`
 * and its wrapped pieces keep the tool output's five-column indent. */
const SHELL = [
  "! claude auth login",
  "  ⎿  If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&resp",
  "     onse_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%",
  "     3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload+user%3Aplugins&code_challenge=MnU3_UPTFkubXQ0D6zK9TJ_l-",
  "     THaFiNLB4jG_bLpGBE&code_challenge_method=S256&state=fdJN4WSCuZFEkFtGK3tMPbtltbOGHVadOw5lrrfCJeI",
  "     Paste code here if prompted >",
  "     +1 lines (4s)",
  "     (ctrl+b ctrl+b (twice) to run in background)",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  Opus 5.5 [░░░░░ 5%] christinoleo@omarchy",
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
].join("\n");

describe("readLoginScreen", () => {
  it("reads the link whole across its wrap, and the empty code field", () => {
    expect(readLoginScreen(CODE)).toEqual({
      step: "code",
      url: URL_HEAD + URL_TAIL,
      typed: "",
      error: null,
      shell: false,
    });
  });

  it("reads the link a shell command prints, and marks the field as one no keys reach", () => {
    const screen = readLoginScreen(SHELL);
    expect(screen).toMatchObject({ step: "code", typed: "", error: null, shell: true });
    const url = screen?.step === "code" ? screen.url : null;
    expect(url).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true&/);
    expect(url).toContain("&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&");
    expect(url).toMatch(/&code_challenge_method=S256&state=[\w-]+$/);
    expect(url).not.toMatch(/\s/);
  });

  it("reads what is typed and why the last code failed", () => {
    const failed = CODE.replace("prompted >", "prompted > abc#def").replace(
      "  Esc to cancel",
      "  Invalid code. Please make sure the full code was copied.\n  Esc to cancel",
    );
    expect(readLoginScreen(failed)).toMatchObject({
      typed: "abc#def",
      error: "Invalid code. Please make sure the full code was copied.",
    });
  });

  it("reads a refused code and its retry prompt", () => {
    const failed = ["   Login", "   OAuth error: Request failed with status code 400", "   Press Enter to retry.", "   Esc to cancel"];
    expect(readLoginScreen(failed.join("\n"))).toEqual({
      step: "failed",
      error: "OAuth error: Request failed with status code 400",
    });
  });

  it("says the sign-in went through", () => {
    expect(readLoginScreen("  Login successful. Press Enter to continue…")).toEqual({ step: "done" });
  });

  it("offers a sign-in while the notice is the last thing said", () => {
    const expired = ["❯ hello", "● Login expired · Please run /login", "✻ Cooked for 0s", "─".repeat(40), "❯ ", "─".repeat(40)];
    expect(readLoginScreen(expired.join("\n"))).toEqual({ step: "expired" });
    const since = [...expired.slice(0, 3), "❯ again", "● Sure, here it is.", ...expired.slice(3)];
    expect(readLoginScreen(since.join("\n"))).toBeNull();
  });

  it("finds nothing on an ordinary pane", () => {
    expect(readLoginScreen(["● Done.", "─".repeat(40), "❯ ", "─".repeat(40)].join("\n"))).toBeNull();
  });
});
