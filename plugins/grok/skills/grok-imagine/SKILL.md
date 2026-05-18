---
name: grok-imagine
description: Generate an image from a text description using xAI Grok's `/imagine` builtin. Use when the user asks for an image, picture, illustration, logo, mockup, or visual artifact. Returns the absolute path to the saved image plus an `open` command to view it.
---

# Grok — Imagine (Image Generation)

Use this skill when the user wants Grok to generate an image. The companion wraps Grok's `/imagine` builtin, sanitizes the output, and prints the saved image path.

## When to use

- The user asks "generate an image of…", "draw…", "create a picture of…", "make a logo for…", "mockup…".
- The user wants a visual deliverable rather than text.

Do **not** use this skill for:
- Video generation → there is a separate `imagine-video` companion subcommand (currently slash-command only; surface to the user).
- Image *analysis* (describing an existing image) — Grok-ask with the image attached is a separate flow.

## How to invoke

Run **exactly one** bash command:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" imagine "<the user's image description, properly quoted>"
```

### Common flags

- `--save-to <path>` — copy the generated image to a path. If `<path>` ends with `/` or is an existing directory, the source basename is appended. Defaults to a session-internal path under `~/.grok/sessions/`.
- `--model <name>` — override the default imagine model.
- `--timeout <duration>` — default 5 minutes. `0` to disable.
- `--json` — emit machine-readable JSON instead of human-readable output.

## Output rules

- Return the companion's stdout **verbatim**. It includes:
  - `Image: /absolute/path/to/file.jpg` — the saved image path.
  - An `open "<path>"` line (macOS). Linux users can substitute `xdg-open`.
  - A `Session: <id>` resumption handle when present.
- If Grok returns a content-policy refusal (no markdown image link in the response), surface the raw text so the user sees Grok's reason — do not retry silently with a softened prompt.
- If `$ARGUMENTS` is empty, clarify with the user what image they want before invoking.
