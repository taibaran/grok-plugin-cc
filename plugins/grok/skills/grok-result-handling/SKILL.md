---
name: grok-result-handling
description: Internal guidance for presenting Grok helper output back to the user
user-invocable: false
---

# Handling Grok helper output

Use this skill from inside the slash commands and the `grok:grok-rescue` subagent when forwarding the companion's stdout to the user.

## Verbatim contract

Almost everything that comes out of `node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" <sub>` should be passed through to the user unchanged. The reasons:
- The user invoked the command in order to see Grok's reasoning.
- Paraphrasing changes verdicts, severity assessments, and concrete fix recommendations.
- Side-by-side comparisons of Grok and Claude reasoning are useful only when both texts are intact.

The verbatim rule applies to:
- `/grok:ask` — answer text from Grok.
- `/grok:review` and `/grok:adversarial-review` — review findings, including JSON when `--json` is set.
- `/grok:rescue` — the rescue task output.
- `/grok:result` — the stored output of a finished job.

## What to surface in addition

Augment, do not replace, the verbatim output with these structural cues when they appear in stdout or stderr:

- A `[hint: ...]` line on stderr means the companion classified an authentication failure. Show the hint and remind the user to run `/grok:setup`.
- A trailing `[grok-plugin] Job <id> ...` line gives a follow-up handle. Keep it so the user can run `/grok:status <id>` or `/grok:result <id>`.
- A trailing `[grok-plugin] Session: <id>  (resume: grok -r <id>)` line is a resumption handle for the underlying Grok thread. Keep it visible; some users will want to drop down into the raw `grok -r <id>` flow later.

## What NOT to do

- Do not collapse multi-finding reviews into a single bullet list.
- Do not strip Grok's reasoning trace ("thought") that may appear inside a `--output-format json` payload (the companion already extracts the user-facing `text`).
- Do not re-run the helper unless the user explicitly asks.
- Do not call `/grok:cancel` or `/grok:purge` on the user's behalf without explicit instruction.

## Failure cases

If the companion exits non-zero or prints a `Grok error:` line:
- Surface the error verbatim.
- If a `[hint: ...]` line is also present, surface that next.
- Do not retry. Let the user decide whether to re-run after fixing the underlying issue (auth, quota, etc.).
- Exit code `124` specifically means timeout — surface the timeout duration and the `--timeout 0` escape hatch the companion already prints, but do not silently retry with a longer timeout.
