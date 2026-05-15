---
description: Run a Grok prompt N ways in parallel and return Grok's best answer
argument-hint: '<N> [--model <model>] [--effort <low|medium|high|xhigh|max>] [--check] [--no-web-search] [--timeout <duration>] <prompt>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Wrap Grok's `--best-of-n N` flag. Grok runs the prompt N ways in parallel and returns the answer it judges best.

**Cost**: each of the N branches is a full token-spend, so `best-of 5` costs ~5× a regular `/grok:ask`. The plugin caps N at 8.

Argument shapes accepted:
- `/grok:best-of 5 <prompt>`
- `/grok:best-of --best-of-n 5 <prompt>`

Combine with `--effort max` for the highest-quality runs, or `--check` to add per-branch self-verification.

Raw user input:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" best-of "$ARGUMENTS"
```

Output rules:
- Return the companion's stdout verbatim.
- If `$ARGUMENTS` is empty, ask the user for N and a prompt instead of running.
