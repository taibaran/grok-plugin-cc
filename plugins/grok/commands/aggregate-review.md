---
description: Run the same diff-review against codex + gemini + grok in parallel via the grok:grok-aggregate-review subagent; aggregate verdicts into a unified report
argument-hint: '[--background|--wait] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--timeout <duration>] [--adversarial] [focus text]'
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `grok:grok-aggregate-review` subagent via the `Agent` tool
(`subagent_type: "grok:grok-aggregate-review"`), forwarding the raw user
request as the prompt. The final user-visible response must be the
companion's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the subagent in the background.
- If the request includes `--wait`, run the subagent in the foreground.
- If neither flag is present, default to foreground for typical reviews
  and background for diffs larger than ~50 KB or when the user signals patience.
- `--background` and `--wait` are Claude-Code execution controls. Do not
  forward them to the companion's `aggregate-review` subcommand.

Operating rules:

- The subagent is a thin forwarder only. It uses one `Bash` call to invoke
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" aggregate-review ...`
  and returns that command's stdout as-is.
- Return the companion's stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- If `$ARGUMENTS` is empty, ask the user whether to review the working tree,
  staged changes, or a branch diff before invoking the subagent.
- If the companion reports that fewer than 2 peer CLIs are installed,
  surface that and stop. The user needs at least Codex + Gemini, Codex + Grok,
  or Gemini + Grok installed for the aggregator to be useful.

This is the **meta-aggregator** — useful when you want multi-LLM consensus
on whether a change is ready to merge. Each reviewer brings a distinct style:

- **Codex** — strongest at deep correctness analysis and concrete file:line bugs.
- **Gemini** — strongest at large-context cross-file reasoning and security-property tracing.
- **Grok** — strongest at fresh-context skepticism and unconventional angles.

Requires at least two of the three CLIs installed. The per-reviewer timeout
defaults to 10 minutes.

Pass `--adversarial` to switch each reviewer's prompt to the more aggressive
adversarial-review template (challenges the design, surfaces failure modes).
