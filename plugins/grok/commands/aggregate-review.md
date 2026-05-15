---
description: Run the same diff-review against codex + gemini + grok in parallel and aggregate the verdicts
argument-hint: '[--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--timeout <duration>] [--adversarial] [focus text]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Capture the current diff and run a code review prompt against every installed peer CLI in parallel (Codex / Gemini / Grok). Aggregate their verdicts into a unified report with a summary table.

This is the **meta-aggregator** — useful when you want multi-LLM consensus on whether a change is ready to merge. Each reviewer brings a distinct style:

- **Codex** — strongest at deep correctness analysis and concrete file:line bugs.
- **Gemini** — strongest at large-context cross-file reasoning and security-property tracing.
- **Grok** — strongest at fresh-context skepticism and unconventional angles.

Requires at least two of the three CLIs installed. The per-reviewer timeout defaults to 10 minutes.

Pass `--adversarial` to switch each reviewer's prompt to the more aggressive adversarial-review template (challenges the design, surfaces failure modes).

Raw user input:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" aggregate-review "$ARGUMENTS"
```

Output rules:
- Return the companion's stdout verbatim. It's already structured markdown (per-reviewer section + summary table).
- If the command exits with code 1, that means at least one reviewer returned VERDICT: REJECT — surface that in your reply.
