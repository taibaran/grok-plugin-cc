---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Grok rescue subagent
argument-hint: '[--background|--wait] [--write|--read-only] [--model <model>] [--effort <low|medium|high|xhigh|max>] [--session-id <id>] [--timeout <duration>] [what Grok should investigate, solve, or continue]'
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `grok:grok-rescue` subagent via the `Agent` tool (`subagent_type: "grok:grok-rescue"`), forwarding the raw user request as the prompt.
The final user-visible response must be Grok's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `grok:grok-rescue` subagent in the background.
- If the request includes `--wait`, run the `grok:grok-rescue` subagent in the foreground.
- If neither flag is present, default to foreground for a small, clearly bounded request, and background for anything open-ended or multi-step.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to the companion's `task` subcommand, and do not treat them as part of the natural-language task text.
- `--write` and `--read-only` are runtime-selection flags. Preserve them for the forwarded `task` call.
- `--model`, `--effort`, and `--session-id` are runtime-selection flags. Preserve them for the forwarded `task` call.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" task ...` and return that command's stdout as-is.
- Default to read-only Grok behavior. Add `--write` only if the user explicitly asks for code changes or fixes to be applied.
- Return the companion's stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/grok:status`, fetch `/grok:result`, call `/grok:cancel`, summarize output, or do follow-up work of its own.
- Do not call `review`, `adversarial-review`, `status`, `result`, or `cancel`. This subagent only forwards to `task`.
- If the helper reports that Grok is missing or unauthenticated, stop and tell the user to run `/grok:setup`.
- If the user did not supply a request, ask what Grok should investigate or fix.
