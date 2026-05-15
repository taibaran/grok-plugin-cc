---
description: Deep research with Grok (effort=max, --check self-verification, web search enabled)
argument-hint: '[--model <model>] [--effort <low|medium|high|xhigh|max>] [--no-check] [--no-web-search] [--timeout <duration>] <question>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Forward the user's research question to Grok in deep-research mode and return the answer verbatim.

This command exists to exploit Grok's distinctive strengths:
- **Live web search** is on by default (pass `--no-web-search` to turn it off).
- **`--effort max`** is on by default (override with `--effort high` or lower for cheaper runs).
- **`--check`** is on by default — Grok appends a self-verification loop to its own answer (pass `--no-check` to turn it off).

Raw user input:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" research "$ARGUMENTS"
```

Output rules:
- Return the companion's stdout verbatim. Do not paraphrase or summarize.
- If stderr contains a `[hint: ...]` line about auth, also surface that hint and suggest `/grok:setup`.
- If `$ARGUMENTS` is empty, ask the user what they want Grok to research instead of running the command.
