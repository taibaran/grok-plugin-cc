---
name: grok-cli-runtime
description: Internal helper contract for calling the grok-companion runtime from Claude Code
user-invocable: false
---

# Grok Runtime

Use this skill only inside the `grok:grok-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" task "<raw arguments>"`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct `grok` CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, `cancel`, or `purge` from `grok:grok-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `grok-prompting` skill to rewrite the user's request into a tighter Grok prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Default to read-only Grok behavior. Add `--write` ONLY when the user explicitly asks for code changes.
- `--write` is gated by `GROK_PLUGIN_ALLOW_WRITE=1` in the environment. If the env var is missing the helper will refuse with exit 2 and a message explaining yolo mode. Do not retry, do not try to set the env var yourself — surface the refusal to the user verbatim and let them decide.
- Leave `--model` unset by default. Add `--model <name>` only when the user explicitly requests one.
- Leave `--effort` unset by default. Add `--effort <level>` only when the user explicitly requests one. Valid values: `low`, `medium`, `high`, `xhigh`, `max`.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`, and do not treat it as part of the natural-language task text.
- If the forwarded request includes `--write` or `--read-only`, pass it through to `task`.
- If the forwarded request includes `--timeout <duration>`, pass it through. Forms accepted: `300s`, `5m`, `1h`, `500ms`, or `0` to disable. The default for `task` is unbounded (rescue work is open-ended). Override only if the user named a specific duration. On timeout the helper exits 124 — surface that to the user rather than retrying.
- If the forwarded request includes `--session-id <id>`, pass it through. Grok creates a new session if not found, or resumes it if it exists. Use this to continue a previous rescue thread instead of starting fresh.
- Never call `purge` from this subagent. `/grok:purge` is a destructive disk-cleanup operation the user invokes explicitly; rescue is forwarder-only.

Safety rules:
- Default to read-only Grok work in `grok:grok-rescue` unless the user explicitly asks for code changes.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Grok cannot be invoked, return nothing.
