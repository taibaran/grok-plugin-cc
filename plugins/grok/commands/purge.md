---
description: Delete recorded Grok job metadata + log files from disk
argument-hint: '[--older-than <duration>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" purge "$ARGUMENTS"`

This is a destructive operation. It deletes:
- Job metadata JSON files under `${CLAUDE_PLUGIN_DATA}/state/<workspace>/jobs/`
- The on-disk stdout/stderr logs for those jobs

It does NOT delete still-running jobs.

Without `--older-than`, all non-running job records are purged. Use `--older-than 30d` (or `12h`, `45m`, `60s`) to keep recent jobs.
