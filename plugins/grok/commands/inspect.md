---
description: Show the merged Grok configuration that will apply to the next call (AGENTS.md, skills, MCP servers, rules, permissions)
argument-hint: '[--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Wrap `grok inspect`. This is the most useful debugging tool when something feels "off" with `/grok:rescue` or `/grok:review` — it surfaces:

- Which AGENTS.md / `CLAUDE.md` / `.grok/GROK.md` rules will be appended to the system prompt
- Which skills are autoloaded (from `~/.grok/skills/`, `~/.claude/skills/`, and project-local)
- Which MCP servers are configured
- Which plugins are active
- Permission rules currently in effect
- LSP integrations and hooks

Pass `--json` for a machine-readable dump.

Raw user input:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" inspect "$ARGUMENTS"
```

Output rules:
- Return the companion's stdout verbatim.
- The output is large for projects with many skills/MCPs — that's expected.
