---
description: Show the stored final output for a finished Grok job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" result "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- Job ID and status
- The complete result payload (stdout)
- File paths and line numbers exactly as reported
- Any error messages
- The `Session: <id>` line if present — it lets the user resume the same Grok thread with `grok -r <id>`
- Follow-up commands such as `/grok:status <id>`
