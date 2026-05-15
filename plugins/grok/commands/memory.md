---
description: View / edit / clear Grok's cross-session memory
argument-hint: '[edit|stats|clear|enable|disable] [--json] [--timeout <duration>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Wrap `grok memory`. Grok's cross-session memory accumulates lessons across
calls (when enabled). Sub-actions:

- `/grok:memory` or `/grok:memory stats` — usage stats
- `/grok:memory edit` — open the memory store in an editor
- `/grok:memory clear` — wipe (be careful — irreversible)
- `/grok:memory enable` / `/grok:memory disable` — toggle for this workspace

Per-call kill-switches are also available as flags on every command:
`--no-memory` (disable for one call) or `--experimental-memory` (enable for
one call, when not globally on). They're mutually exclusive.

Raw user input:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" memory "$ARGUMENTS"
```
