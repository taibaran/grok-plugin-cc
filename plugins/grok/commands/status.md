---
description: Show active and recent Grok jobs for this repository
argument-hint: '[job-id] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" status "$ARGUMENTS"`

If the user did not pass a job ID:
- Render the command output as a single Markdown table for the current and past runs in this workspace.
- Keep it compact. Do not include progress blocks or extra prose outside the table.
- Preserve the actionable fields: job ID, kind, status, started, PID, and task.

If the user did pass a job ID:
- Present the full command output verbatim.
- Do not summarize or condense it.
