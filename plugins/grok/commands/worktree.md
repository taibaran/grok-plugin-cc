---
description: Manage Grok-managed git worktrees (list, garbage-collect, remove)
argument-hint: '[list|gc|rm <name>] [--json] [--timeout <duration>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Wrap `grok worktree`. Subcommands match the underlying CLI:

- `/grok:worktree` or `/grok:worktree list` — list active Grok-managed worktrees
- `/grok:worktree gc` — garbage-collect stale worktrees
- `/grok:worktree rm <name>` — remove a specific worktree
- Pass `--json` for a machine-readable dump.

Worktrees pair with the `--worktree [<name>]` flag on `/grok:rescue`,
`/grok:research`, etc. — those start a session inside a fresh git worktree
so Grok can edit safely without touching the main checkout.

Raw user input:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" worktree "$ARGUMENTS"
```

Output rules:
- Return the companion's stdout verbatim.
