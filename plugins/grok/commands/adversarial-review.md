---
description: Run a Grok adversarial review that challenges the design and surfaces failure modes
argument-hint: '[--base <ref>] [--scope auto|working-tree|branch|staged|unstaged] [--model <model>] [--effort <low|medium|high|xhigh|max>] [--timeout <duration>] [--json] [--wait|--background] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Grok ADVERSARIAL review of the local diff. Unlike `/grok:review`, the prompt explicitly instructs Grok to try to break confidence in the change — defaulting to skepticism and prioritizing trust-boundary, concurrency, rollback, and data-integrity failures.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the adversarial review and return Grok's output verbatim to the user.

Execution mode rules:
- If `--wait` is present, run in foreground.
- If `--background` is present, run in a Claude background task.
- Otherwise, estimate the size as in `/grok:review` and ask the user with `AskUserQuestion` (one call, two options, recommended first).

Foreground flow:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" adversarial-review "$ARGUMENTS"
```

Return stdout verbatim. Do not paraphrase or add commentary.

Background flow:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" adversarial-review "$ARGUMENTS"`,
  description: "Grok adversarial review",
  run_in_background: true
})
```

Then tell the user: "Grok adversarial review started in the background. Check `/grok:status` for progress."
