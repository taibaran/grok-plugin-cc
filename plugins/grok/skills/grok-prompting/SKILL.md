---
name: grok-prompting
description: Internal guidance for composing Grok prompts for coding, review, diagnosis, and research tasks inside the Grok Claude Code plugin
user-invocable: false
---

# Composing Grok prompts

Use this skill from inside `grok:grok-rescue` (and only there) to tighten a user's free-form rescue request into a more effective Grok prompt before calling `task`.

This skill draws on Grok's distinct strengths:
- **Live web/X search awareness** — Grok can search current information on the web and on X (Twitter) without being limited to a training cutoff. Prefer asking Grok for help on questions that depend on recent events, recent docs, or live discourse.
- **Code-focused model defaults** — the default model (`grok-build`) is tuned for advanced coding work with a 512K-token context window, so it can absorb a substantial portion of a codebase at once.
- **Distinct reasoning style** — Grok tends to be direct and willing to take strong positions. Don't pad the prompt with hedging.

## Prompt structure

A good rescue prompt for Grok is short, direct, and grounded:

1. **Goal** — one sentence stating what the user wants resolved or answered.
2. **Context** — two to four sentences of relevant repo context (what file/feature is involved, what's known to be broken, what's already been tried).
3. **Constraints** — anything that's off-limits (don't change public API, don't add dependencies, don't touch tests).
4. **Output expectation** — what Grok should return: an explanation, a diagnosis, a patch plan, or actual code edits.

## Patterns

| User intent | Prompt pattern |
|---|---|
| "investigate why X" | Goal: diagnose root cause. Context: behavior + reproduction. Output: ranked list of suspect causes with evidence. |
| "fix the failing test" | Goal: make `<test name>` pass. Context: test file + recent changes. Output: minimal patch + explanation. |
| "explain how X works" | Goal: explain the data/control flow of `<feature>`. Output: a walkthrough citing files and line numbers. |
| "what should the design be" | Goal: propose a design for `<feature>`. Output: 2–3 options with tradeoffs, then a recommendation. |
| "what changed about X recently" | Goal: identify recent ecosystem changes (web search). Context: the framework/library. Output: dated summary + sources. |

## Anti-patterns

- Don't restate the entire repo. Grok will pull what it needs.
- Don't ask Grok to "be careful" or "be thorough" — it already is.
- Don't include Claude-internal context like prior tool outputs or scratch notes.
- Don't pre-decide the fix. Let Grok propose its own approach.

## Model selection

- **Model** — only set `--model` when the user names one (e.g., `grok-build`). Otherwise leave it unset. The plugin resolves the model with this precedence: caller `--model` → `GROK_PLUGIN_MODEL` env → workspace `config.activeModel` → `DEFAULT_MODEL` in `lib/grok.mjs` (currently `grok-build`).
- **Effort** — set `--effort` only when the user names a level. Valid: `low`, `medium`, `high`, `xhigh`, `max`. Higher levels cost more and take longer but produce more thorough reasoning.

## Session continuity

If the user mentions continuing or extending a prior Grok session, look for a session id they may have named (`-s critique-pr-123`) or seen earlier in the conversation. Pass it through as `--session-id <id>` (creates-if-missing semantics), or `--resume=<id>` (Grok-native resume of an existing session), or `--continue` (resume the most-recent session for cwd). All three are passthrough runtime controls handled by `extractPolicyFlags` and emitted as the corresponding grok CLI flag.

Note: in plain-output mode the companion does not extract Grok's internal `sessionId` from the response stream, so the trailing footer in `task`'s output only includes the session id when the user supplied one via `--session-id`, `--resume=<id>`, or `--continue`. If you need a stable handle for resumption, recommend the user pass `--session-id <name>` themselves.

## Write mode

- The user's request may include `--write`. Pass it through unchanged. The companion will refuse the call with exit 2 unless `GROK_PLUGIN_ALLOW_WRITE=1` is in the env. If you see that refusal in the helper output, return it to the user verbatim — do not try to set the env var, do not retry, and do not strip `--write` from the request to make it succeed silently.

## When NOT to rephrase

If the user's request is already specific and grounded, pass it through verbatim. Rephrasing adds latency and risks losing nuance the user intended.
