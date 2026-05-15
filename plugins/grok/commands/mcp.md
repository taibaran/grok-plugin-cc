---
description: Manage MCP (Model Context Protocol) servers configured for Grok
argument-hint: '[list|add <name> <url>|remove <name>|doctor] [--json] [--timeout <duration>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Wrap `grok mcp`. MCP servers extend Grok with custom tools / data sources.

- `/grok:mcp` or `/grok:mcp list` — list configured servers
- `/grok:mcp add <name> <url>` — add a server
- `/grok:mcp remove <name>` — remove a server
- `/grok:mcp doctor` — probe each configured server for health (can be slow;
  default timeout is 2 min)

Raw user input:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" mcp "$ARGUMENTS"
```
