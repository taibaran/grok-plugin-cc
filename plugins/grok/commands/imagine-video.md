---
description: Generate a video from a text description using Grok's `/imagine-video` builtin
argument-hint: '[--model <model>] [--effort <low|medium|high|xhigh|max>] [--timeout <duration>] [--json] <description>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Generate a video from a text description. Video generation is slower than image generation — the default timeout is 15 minutes.

Raw slash-command arguments:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" imagine-video "$ARGUMENTS"
```

Output rules:
- Return the companion's stdout verbatim. It includes:
  - `Video: /absolute/path/to/file.mp4` — the saved video path
  - An `open "<path>"` line the user can copy and run to open it (macOS) — Linux users can substitute `xdg-open`
  - A `Session: <id>` resumption handle when present
- If `$ARGUMENTS` is empty, ask the user what video they want Grok to generate instead of running the command.
- If Grok returns a content-policy refusal (no markdown link in the response), surface the raw text so the user can see Grok's reason.
- Video generation can take several minutes. The default 15-minute timeout is conservative. If it routinely overshoots, pass `--timeout 30m` or `--timeout 0` (disable).
