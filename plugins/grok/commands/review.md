---
description: Run a Grok code review against local git state
argument-hint: '[--base <ref>] [--scope auto|working-tree|branch|staged|unstaged] [--model <model>] [--effort <low|medium|high|xhigh|max>] [--timeout <duration>] [--json] [--wait|--background] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Grok review of the local diff via the shared companion.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Grok's output verbatim to the user.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run the review in the foreground.
- If the raw arguments include `--background`, do not ask. Run the review in a Claude background task.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - Inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For branch review, use `git diff --shortstat <base>...HEAD`.
  - Recommend waiting only when the review is clearly tiny, roughly 1–2 files total.
  - In every other case, recommend background.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly. Do not strip `--wait` or `--background`.
- The companion script ignores `--wait`/`--background` flags itself; Claude Code's `Bash(..., run_in_background: true)` is what actually detaches the run.

Foreground flow:
- Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" review "$ARGUMENTS"
```

- Return the command stdout verbatim. Do not paraphrase, summarize, or add commentary.
- Do not fix any issues mentioned in the review.

Background flow:
- Launch the review with `Bash` in the background:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" review "$ARGUMENTS"`,
  description: "Grok review",
  run_in_background: true
})
```

- Do not call `BashOutput` or wait for completion in this turn.
- After launching, tell the user: "Grok review started in the background. Check `/grok:status` for progress."
