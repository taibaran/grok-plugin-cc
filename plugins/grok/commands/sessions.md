---
description: List, search, or restore Grok sessions (separate from plugin job ids)
argument-hint: '[list|search <query>|restore <id>] [--json] [--timeout <duration>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Wrap `grok sessions`. The plugin tracks its OWN job ids (`/grok:status`,
`/grok:result`) — those are wrappers around invocations the plugin launched.
**This** command surfaces Grok's native sessions (`~/.grok/sessions/...`),
which include everything Grok has run in this workspace (including outside
the plugin).

Subcommands match the underlying CLI:

- `/grok:sessions` or `/grok:sessions list` — list recent Grok sessions
- `/grok:sessions search <query>` — search session contents.
  If the query starts with `-` or `--` (e.g. searching for previous
  `--timeout` mentions), use the POSIX `--` terminator to escape it:
  `/grok:sessions search -- --timeout`. Everything after `--` is
  treated as a literal search term and forwarded to grok as a
  positional argv after a re-emitted `--`.
- `/grok:sessions restore <id>` — restore a prior session for resume

Pair with `--resume <id>` on `/grok:ask`, `/grok:research`, `/grok:rescue`,
etc. to continue an existing session.

Raw user input:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" sessions "$ARGUMENTS"
```

Output rules:
- Return the companion's stdout verbatim.
