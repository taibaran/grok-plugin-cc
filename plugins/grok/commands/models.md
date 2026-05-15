---
description: List available Grok models (and optionally set the workspace default)
argument-hint: '[--json] [--set-default <model-id>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

List Grok's available models by running `grok models` and report which model the plugin will use in this workspace.

If the user passes `--set-default <id>` (or `--set-default` followed by a positional model id), persist that model into the workspace config so subsequent commands default to it.

Raw user input:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" models "$ARGUMENTS"
```

Output rules:
- Return the companion's stdout verbatim.
- The footer lines (effective model, workspace-pinned, plugin default, env override) are useful even when there's only one public model today — they document the precedence chain.
