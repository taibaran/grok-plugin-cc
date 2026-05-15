---
description: Ask Grok a one-off question (read-only)
argument-hint: '[--model <model>] [--effort <low|medium|high|xhigh|max>] [--timeout <duration>] [--max-turns <N>] [--allow <rule>] [--deny <rule>] [--tools <list>] [--rules <text|@file>] [--no-web-search] [--check] [--no-subagents] [--no-plan] [--verbatim] [--reasoning-effort <effort>] [--sandbox <profile>] [--agent <name>] <question>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Forward the user's question to the Grok companion in read-only mode and return the answer verbatim.

Raw user input:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" ask "$ARGUMENTS"
```

Output rules:
- Return the companion's stdout verbatim. Do not paraphrase or summarize.
- If stderr contains a `[hint: ...]` line about auth, also surface that hint and suggest `/grok:setup`.
- If `$ARGUMENTS` is empty, ask the user what they want Grok to answer instead of running the command.
