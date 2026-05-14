---
description: Generate an image from a text description using Grok's `/imagine` builtin
argument-hint: '[--model <model>] [--effort <low|medium|high|xhigh|max>] [--timeout <duration>] [--json] <description>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Generate an image from a text description.

Raw slash-command arguments:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" imagine "$ARGUMENTS"
```

Output rules:
- Return the companion's stdout verbatim. It includes:
  - `Image: /absolute/path/to/file.jpg` — the saved image path
  - An `open "<path>"` line the user can copy and run to open it (macOS) — Linux users can substitute `xdg-open`
  - A `Session: <id>` resumption handle when present
- If `$ARGUMENTS` is empty, ask the user what image they want Grok to generate instead of running the command.
- If Grok returns a content-policy refusal (no markdown link in the response), surface the raw text so the user can see Grok's reason.
- The default timeout is 5 minutes. Override with `--timeout 0` (disable) or `--timeout 90s`.
