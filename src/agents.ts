import type { SessionAgent } from "./db/index.js";

export const AGENT_IDS = ["claude", "gemini", "copilot"] as const;

export interface AgentMeta {
  icon: string;
  color: string;
  label: string;
  command: string;
  argv: string[];
}

export const AGENTS: Record<SessionAgent, AgentMeta> = {
  claude: {
    icon: "mdi:creation",
    color: "#d97757",
    label: "Claude Code",
    command: "claude --dangerously-skip-permissions",
    argv: ["env", "-u", "CLAUDECODE", "claude", "--dangerously-skip-permissions"],
  },
  gemini: {
    icon: "mdi:google",
    color: "#4285f4",
    label: "Gemini CLI",
    command: "gemini --yolo",
    argv: ["gemini", "--yolo"],
  },
  copilot: {
    icon: "mdi:github",
    color: "#ddd",
    label: "GitHub Copilot CLI",
    command: "copilot --allow-all-tools",
    argv: ["copilot", "--allow-all-tools"],
  },
};

export function parseAgent(value: unknown): SessionAgent {
  return AGENT_IDS.includes(value as SessionAgent) ? (value as SessionAgent) : "claude";
}
