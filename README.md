<p align="center">
  <h1 align="center">claude-mux</h1>
  <p align="center">
    <strong>Real-time web dashboard for monitoring and controlling multiple Claude Code sessions</strong>
  </p>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/claude-mux"><img src="https://img.shields.io/npm/v/claude-mux?style=flat-square&color=blue" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/claude-mux"><img src="https://img.shields.io/npm/dm/claude-mux?style=flat-square&color=green" alt="npm downloads"></a>
  <a href="https://github.com/christinoleo/claude-mux/blob/main/LICENSE"><img src="https://img.shields.io/github/license/christinoleo/claude-mux?style=flat-square" alt="license"></a>
  <img src="https://img.shields.io/badge/bun-%3E%3D1.0-f472b6?style=flat-square" alt="bun version">
  <img src="https://img.shields.io/badge/platform-linux%20%7C%20macos-lightgrey?style=flat-square" alt="platform">
</p>

<p align="center">
  <a href="#features">Features</a> &bull;
  <a href="#installation">Installation</a> &bull;
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#cli-commands">CLI</a> &bull;
  <a href="#how-it-works">Architecture</a>
</p>

---

<p align="center">
  <img src="docs/images/desktop-dashboard.png" alt="Dashboard" width="100%">
  <br><em>Dashboard &mdash; sessions grouped by project with live state indicators</em>
</p>

<p align="center">
  <img src="docs/images/desktop-session.png" alt="Session View" width="100%">
  <br><em>Session view &mdash; real-time ANSI terminal output with action toolbar</em>
</p>

<details>
<summary><strong>Mobile</strong></summary>
<br>
<p align="center">
  <img src="docs/images/mobile-dashboard.png" alt="Mobile Dashboard" width="300">
  &nbsp;&nbsp;&nbsp;
  <img src="docs/images/mobile-session.png" alt="Mobile Session" width="300">
</p>
<p align="center"><em>Fully responsive &mdash; control sessions from your phone</em></p>
</details>

---

## Features

- **Live session monitoring** &mdash; WebSocket-powered, no polling. See state (busy/idle/waiting/permission) at a glance
- **Project grouping** &mdash; sessions organized by working directory with color-coded borders
- **ANSI terminal rendering** &mdash; real tmux colors via [ansi_up](https://github.com/drudru/ansi_up), toggleable
- **Session control** &mdash; send text, keys (Up/Down/Tab/Esc/Ctrl-C), Yes/No/Always quick buttons
- **Voice input** &mdash; local Whisper transcription (CPU or CUDA, auto-detected). Trigger with `F2`, `Pause`, or `Ctrl+\`` while the input is focused; press `Enter` to stop and submit, `Esc` or the `×` overlay to discard. Long-press the mic button for language, microphone, and auto-submit settings
- **Orchestrator pairing** &mdash; main + orchestrator sessions grouped together with role labels
- **Remote Control** &mdash; auto-detects Claude's `/rc` and opens it in a new window
- **Mobile-first** &mdash; touch toolbar, hamburger sidebar, swipe gestures
- **Screenshots panel** &mdash; view and dismiss captured screenshots
- **Dead pane detection** &mdash; visual indication when a tmux pane closes
- **Other tmux panes** &mdash; browse and view non-Claude panes too
- **Auth support** &mdash; optional password protection for LAN access
- **CLI scripting** &mdash; `send`, `wait`, `status`, `capture` commands for automation

---

## Installation

```bash
bun install -g claude-mux
# or: npm install -g claude-mux
```

<details>
<summary><strong>From source</strong></summary>

```bash
git clone https://github.com/christinoleo/claude-mux.git
cd claude-mux
bun install && bun run build
bun link  # makes 'claude-mux' available globally
```
</details>

---

## Quick Start

```bash
# 1. Install hooks into Claude Code
claude-mux setup

# 2. Start the web server
claude-mux serve --port 3456 --host 0.0.0.0

# 3. Open http://localhost:3456 (or your LAN IP)
# 4. Start any Claude Code session — it appears automatically
```

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `claude-mux serve` | Start web server (`--port`, `--host`, `--auth <password>`) |
| `claude-mux setup` | Install Claude Code hooks |
| `claude-mux uninstall` | Remove hooks and configuration |
| `claude-mux send <target> [text]` | Send text or `--keys` to a session |
| `claude-mux status <target>` | Get session state as JSON |
| `claude-mux wait <target>` | Block until session reaches `--state` (default: idle,waiting,permission) |
| `claude-mux new-session --cwd <path>` | Spawn a new detached Claude Code session |
| `claude-mux capture <target>` | Capture tmux pane output (`--lines N`) |
| `claude-mux` | TUI dashboard (legacy, requires tmux) |

---

## How It Works

```
Claude Code events  ──>  Hook script  ──>  JSON files (~/.claude-mux/sessions/)
                                                    |
                                           File watcher (500ms)
                                                    |
                                           WebSocket broadcast
                                                    |
                                           Browser  <──>  SvelteKit server
```

**Hooks** run inside Claude Code's process and write session state to JSON on every event (start, prompt, tool use, stop, notification). The **SvelteKit server** watches those files and pushes updates to connected browsers via WebSocket. Terminal output is captured directly from tmux panes.

---

## Troubleshooting

**Sessions not appearing** &mdash; Run `claude-mux setup`, then restart Claude Code sessions (hooks load at startup).

**Can't connect from another device** &mdash; Use `--host 0.0.0.0` and check your firewall.

**Status not updating** &mdash; Verify hooks: `grep claude-mux ~/.claude/settings.json`

**Voice transcription slow on first use** &mdash; The first invocation builds whisper.cpp and downloads a Whisper model into `~/.claude-mux/voice/`. Subsequent runs reuse the cache. CUDA is used automatically if `nvidia-smi` and `nvcc` are present.

---

## Requirements

- [Bun](https://bun.sh) >= 1.0
- tmux
- Claude Code with hooks support
- Optional, for voice input: a working C/C++ toolchain (whisper.cpp builds on first use); NVIDIA CUDA toolkit for GPU transcription

---

## License

MIT

## Contributing

PRs welcome. Fork, branch, test (`bun test`), and open a PR.
