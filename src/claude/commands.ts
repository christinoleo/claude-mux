/**
 * Discover slash commands, skills, and subagents available to Claude Code.
 *
 * Sources scanned (mirrors Claude Code's own lookup):
 *   - built-in slash commands (static list)
 *   - built-in skills bundled in the Claude Code binary (static list)
 *   - ~/.claude/commands/**\/*.md          (user commands)
 *   - ~/.claude/skills/<name>/SKILL.md     (user skills)
 *   - ~/.claude/agents/*.md                (user subagents)
 *   - <cwd>/.claude/{commands,skills,agents} (project-scoped)
 *   - enabled plugins from ~/.claude/plugins/installed_plugins.json
 *     → <installPath>/{commands,skills,agents}, namespaced as `plugin:name`
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { fuzzyScore } from "../utils/fuzzy.js";
import { homedir } from "os";
import { basename, dirname, join, relative } from "path";

export type CommandKind = "builtin" | "command" | "skill" | "agent";

export interface DiscoveredCommand {
  /** Display name, e.g. "/linus", "/ak:p1", "@code-reviewer" */
  name: string;
  /** Text inserted into the prompt when selected */
  insert: string;
  kind: CommandKind;
  /** "builtin" | "user" | "project" | "plugin:<id>" */
  source: string;
  description: string;
  /** Absolute path of the defining file (absent for builtins) */
  path?: string;
}

const BUILTINS: Array<[string, string]> = [
  ["/clear", "Clear conversation history"],
  ["/compact", "Compact conversation (optional focus instructions)"],
  ["/config", "Open settings"],
  ["/cost", "Show token usage and cost"],
  ["/context", "Show context window usage"],
  ["/doctor", "Check Claude Code installation health"],
  ["/exit", "Exit Claude Code"],
  ["/fast", "Toggle fast mode"],
  ["/help", "Show help and available commands"],
  ["/init", "Initialize CLAUDE.md for this project"],
  ["/login", "Sign in"],
  ["/logout", "Sign out"],
  ["/mcp", "Manage MCP servers"],
  ["/memory", "Edit memory files"],
  ["/model", "Switch model"],
  ["/permissions", "View and manage permissions"],
  ["/plan", "Enter plan mode"],
  ["/rc", "Remote Control — pair this session with claude.ai"],
  ["/resume", "Resume a previous session"],
  ["/review", "Request a code review"],
  ["/status", "Show session status"],
  ["/terminal-setup", "Configure terminal key bindings"],
  ["/vim", "Toggle vim mode"],
  ["/agents", "Manage subagents"],
  ["/plugin", "Manage plugins"],
  ["/hooks", "Manage hooks"],
  ["/add-dir", "Add a working directory"],
  ["/bug", "Report a bug"],
  ["/release-notes", "Show release notes"],
  ["/rewind", "Rewind conversation / files to a checkpoint"],
  ["/skills", "List available skills"],
  ["/tasks", "Show background tasks"],
  ["/statusline", "Configure status line"],
  ["/workflows", "Show running workflows"],
];

/**
 * Skills bundled inside the Claude Code binary. They have no SKILL.md on disk —
 * the binary is a single self-contained executable — so the directory scans below
 * can never find them. Availability can vary by Claude Code version and account
 * gating; this list mirrors the ones shipped as of 2.1.x.
 */
const BUILTIN_SKILLS: Array<[string, string]> = [
  ["/artifact-capabilities", "Runtime capabilities a published Artifact page can be granted"],
  ["/artifact-design", "Design guidance and fundamentals for Artifacts"],
  ["/artifact-diagramming", "Diagramming know-how for Artifacts"],
  ["/claude-api", "Reference for the Claude API / Anthropic SDK"],
  ["/code-review", "Review the current diff or a PR for bugs and cleanups"],
  ["/dataviz", "Design system for charts, dashboards, and data visualization"],
  ["/design", "Create a multi-artboard design canvas published as an Artifact"],
  ["/fewer-permission-prompts", "Build an allowlist from past transcripts to cut permission prompts"],
  ["/keybindings-help", "Customize keyboard shortcuts in ~/.claude/keybindings.json"],
  ["/loop", "Run a prompt or slash command on a recurring interval"],
  ["/run", "Launch and drive this project's app to see a change working"],
  ["/schedule", "Create, update, list, or run scheduled cloud agents (routines)"],
  ["/security-review", "Complete a security review of the pending changes"],
  ["/simplify", "Review changed code for reuse, simplification, and efficiency, then fix"],
  ["/update-config", "Configure the Claude Code harness via settings.json"],
  ["/workflow-authoring", "Reference for writing a Workflow tool script"],
];

/** Parse a minimal YAML frontmatter block: returns name/description if present. */
function parseFrontmatter(content: string): { name?: string; description?: string } {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end === -1) return {};
  const block = content.slice(3, end);
  const out: { name?: string; description?: string } = {};
  const lines = block.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(name|description):\s*(.*)$/);
    if (!m) continue;
    const key = m[1] as "name" | "description";
    let val = m[2].trim();
    if (val === "|" || val === ">" || val === "|-" || val === ">-") {
      // Block scalar — gather indented continuation lines
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
        parts.push(lines[++i].trim());
      }
      val = parts.join(" ");
    } else {
      val = val.replace(/^(['"])(.*)\1$/, "$2");
    }
    out[key] = val;
  }
  return out;
}

function firstMeaningfulLine(content: string): string {
  const body = content.startsWith("---")
    ? content.slice(content.indexOf("\n---", 3) + 4)
    : content;
  for (const raw of body.split("\n")) {
    const line = raw.replace(/^#+\s*/, "").trim();
    if (line) return line.slice(0, 200);
  }
  return "";
}

function readMd(path: string): { name?: string; description: string } {
  try {
    const content = readFileSync(path, "utf-8");
    const fm = parseFrontmatter(content);
    return { name: fm.name, description: fm.description || firstMeaningfulLine(content) };
  } catch {
    return { description: "" };
  }
}

function walkMd(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkMd(p, out);
    else if (e.endsWith(".md")) out.push(p);
  }
  return out;
}

/** Commands dir: every .md file → command; subdirs namespace as `dir:name`. */
function scanCommands(dir: string, source: string, prefix = ""): DiscoveredCommand[] {
  return walkMd(dir).map((file) => {
    const rel = relative(dir, file).replace(/\.md$/, "");
    const parts = rel.split(/[\\/]/);
    const bare = parts.length > 1 ? `${parts.slice(0, -1).join(":")}:${parts.at(-1)}` : parts[0];
    const name = prefix ? `${prefix}:${bare}` : bare;
    const md = readMd(file);
    return {
      name: `/${name}`,
      insert: `/${name}`,
      kind: "command",
      source,
      description: md.description,
      path: file,
    };
  });
}

/** Skills dir: every SKILL.md under it (any depth) → skill named by frontmatter or folder. */
function scanSkills(dir: string, source: string, prefix = ""): DiscoveredCommand[] {
  return walkMd(dir)
    .filter((f) => basename(f) === "SKILL.md")
    .map((file) => {
      const md = readMd(file);
      const bare = md.name || basename(dirname(file));
      const name = prefix ? `${prefix}:${bare}` : bare;
      return {
        name: `/${name}`,
        insert: `/${name}`,
        kind: "skill",
        source,
        description: md.description,
        path: file,
      };
    });
}

/** Agents dir: every .md → subagent (invoked by name / @mention). */
function scanAgents(dir: string, source: string): DiscoveredCommand[] {
  return walkMd(dir).map((file) => {
    const md = readMd(file);
    const name = md.name || basename(file, ".md");
    return {
      name: `@${name}`,
      insert: `@${name}`,
      kind: "agent",
      source,
      description: md.description,
      path: file,
    };
  });
}

function scanRoot(root: string, source: string, prefix = ""): DiscoveredCommand[] {
  return [
    ...scanCommands(join(root, "commands"), source, prefix),
    ...scanSkills(join(root, "skills"), source, prefix),
    ...scanAgents(join(root, "agents"), source),
  ];
}

interface InstalledPlugins {
  plugins?: Record<string, Array<{ installPath?: string; scope?: string }>>;
}

function enabledPlugins(claudeDir: string): Array<{ id: string; name: string; installPath: string }> {
  const installedPath = join(claudeDir, "plugins", "installed_plugins.json");
  if (!existsSync(installedPath)) return [];
  let installed: InstalledPlugins;
  try {
    installed = JSON.parse(readFileSync(installedPath, "utf-8"));
  } catch {
    return [];
  }
  let enabled: Record<string, boolean> = {};
  try {
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf-8"));
    enabled = settings.enabledPlugins || {};
  } catch {
    // no settings → treat all installed as enabled
  }
  const out: Array<{ id: string; name: string; installPath: string }> = [];
  for (const [id, entries] of Object.entries(installed.plugins || {})) {
    if (id in enabled && enabled[id] === false) continue;
    const entry = entries?.[0];
    if (!entry?.installPath || !existsSync(entry.installPath)) continue;
    out.push({ id, name: id.split("@")[0], installPath: entry.installPath });
  }
  return out;
}

export function discoverCommands(cwd?: string): DiscoveredCommand[] {
  const claudeDir = join(homedir(), ".claude");
  const result: DiscoveredCommand[] = BUILTINS.map(([name, description]) => ({
    name,
    insert: name,
    kind: "builtin",
    source: "builtin",
    description,
  }));

  result.push(
    ...BUILTIN_SKILLS.map(([name, description]) => ({
      name,
      insert: name,
      kind: "skill" as const,
      source: "builtin",
      description,
    })),
  );

  result.push(...scanRoot(claudeDir, "user"));

  if (cwd && existsSync(join(cwd, ".claude"))) {
    result.push(...scanRoot(join(cwd, ".claude"), "project"));
  }

  for (const plugin of enabledPlugins(claudeDir)) {
    result.push(...scanRoot(plugin.installPath, `plugin:${plugin.name}`, plugin.name));
  }

  // Dedup by name, first wins (project > user? Claude Code prefers project; we scanned user first
  // so flip precedence here by keeping the last project entry)
  const byName = new Map<string, DiscoveredCommand>();
  for (const c of result) {
    const existing = byName.get(c.name);
    if (!existing || (existing.source === "user" && c.source === "project")) {
      byName.set(c.name, c);
    }
  }
  return [...byName.values()];
}

/**
 * Ranking shared by the web command list and spoken-command resolution: a
 * fuzzy match on the name (boosted so any name hit beats any description
 * hit), else a substring match on the description — substring only, because
 * a subsequence over long prose matches everything.
 */
export function scoreCommand(
  cmd: Pick<DiscoveredCommand, "name" | "description">,
  query: string
): number | null {
  const nameScore = fuzzyScore(cmd.name, query);
  if (nameScore != null) return nameScore + 500;
  const descIdx = query ? cmd.description.toLowerCase().indexOf(query.toLowerCase()) : -1;
  return descIdx === -1 ? null : 100 - descIdx * 0.5;
}
