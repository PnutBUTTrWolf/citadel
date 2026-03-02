# Citadel

A VS Code extension for managing and orchestrating multi-agent workspaces powered by [Gas Town](https://github.com/anthropics/gas-town).

## What It Does

Citadel provides a visual interface for Gas Town's multi-agent system directly inside VS Code. It surfaces agent status, issue tracking, mail, merge queues, and orchestration controls so you can monitor and manage autonomous agent workflows without leaving your editor.

## Key Features

- **Agents Panel** — View running agents (polecats), open their terminals, spawn/kill/restart agents
- **Battlestation** — Terminal grid showing all active agent sessions at once
- **Beads (Issue Tracking)** — Browse, create, filter, and sling beads to agents
- **Convoys** — Manage grouped work batches
- **Mail** — Read and compose inter-agent mail
- **Merge Queue** — Monitor the Refinery merge queue, retry or reject merge requests
- **Mayor** — Attach/detach the Mayor coordinator, view its terminal
- **Rigs & Hooks** — Browse registered rigs and their hook assignments
- **Health & Watchdog** — Monitor system health and the Witness watchdog
- **Status Bar** — Live agent count and system status at a glance
- **Claude Provider Config** — Configure Anthropic API, Vertex AI, or Bedrock as the Claude provider for all agents

## Prerequisites

- [VS Code](https://code.visualstudio.com/) 1.90.0 or later
- [`gt` CLI](https://github.com/anthropics/gas-town) installed and on your PATH
- [`bd` CLI](https://github.com/anthropics/beads) installed and on your PATH
- `tmux` installed and on your PATH (agent sessions run inside tmux)
- A Gas Town workspace initialized at `~/gt` (or configured via `citadel.workspacePath`)

## Development

```bash
# Install dependencies
npm install

# Compile
npm run compile

# Watch mode (recompile on changes)
npm run watch

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

To test the extension, open this directory in VS Code and press `F5` to launch an Extension Development Host.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `citadel.gtPath` | `gt` | Path to the `gt` CLI binary |
| `citadel.bdPath` | `bd` | Path to the `bd` CLI binary |
| `citadel.workspacePath` | `~/gt` | Path to the Gas Town workspace directory |
| `citadel.refreshInterval` | `5000` | Poll interval (ms) for status updates |
| `citadel.dashboardPort` | `8080` | Port for the dashboard server |
| `citadel.claude.provider` | `none` | Claude API provider (`none`, `vertex`, `bedrock`, `anthropic`) |

## License

[MIT](LICENSE)
