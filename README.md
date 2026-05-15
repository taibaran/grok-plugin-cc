# grok-plugin-cc

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

Run xAI's [Grok](https://x.ai/news/grok-build-cli) from inside a Claude Code
session. Get a second-opinion code review, an adversarial pass that *tries* to
break the design, or delegate a long-form research task to Grok — all without
leaving the editor.

## Why this exists

Claude is good at the code in front of it. But the same model has the same
blind spots: same training, same style, same assumptions. A second model with
different training catches things the first one missed.

Grok pairs especially well with Claude for:

- **Live web / X search awareness.** Questions about recent docs, recent
  framework changes, or current discourse — Grok can pull what it needs
  from the web without being capped by Claude's knowledge cutoff.
- **512K-token context.** Hand it a whole subdirectory and ask *"what's the
  failure mode here?"* — this plugin makes that one slash command.
- **Distinct reasoning style.** Grok is direct and willing to take strong
  positions, which makes its adversarial review feel less hedged than
  Claude's own self-review.

## Quick start

Install the Grok CLI first (Node 20+ required):

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
grok login   # browser OAuth — or set GROK_CODE_XAI_API_KEY (from https://console.x.ai)
```

Then add the plugin to Claude Code:

```
/plugin marketplace add https://github.com/taibaran/grok-plugin-cc
/plugin install grok@grok-plugin-cc
/grok:setup
```

`/grok:setup` reports whether the local `grok` binary is reachable,
authenticated, and exposes the flags this plugin depends on. After it
prints `Grok plugin is ready.`, you can use any of the commands below.

> **Note on the install URL.** Use the full HTTPS URL above, not the shorter
> `<user>/<repo>` form. The shorter form defaults to SSH (`git@github.com:...`)
> and fails with `Host key verification failed` unless you've already added
> `github.com` to `~/.ssh/known_hosts`.

## What you get

| Slash command | What it does |
|---|---|
| `/grok:setup` | Verify the local `grok` binary, Node, the flag set this plugin depends on, and authentication. |
| `/grok:ask <question>` | Ask Grok a one-off question (read-only). |
| `/grok:review` | Review uncommitted changes (working-tree, staged, or branch diff). Foreground or background. |
| `/grok:adversarial-review` | Like `/grok:review`, but the prompt tells Grok to challenge the design and surface failure modes. |
| `/grok:research <question>` | Deep research with Grok — `--effort max` + `--check` self-verification loop + live web search enabled by default. |
| `/grok:models [--set-default <id>]` | List Grok models via `grok models`; optionally pin the workspace default. |
| `/grok:best-of <N> <prompt>` | Run a prompt N ways in parallel (`grok --best-of-n N`, capped at 8) and return Grok's best answer. |
| `/grok:aggregate-review [focus]` | Run the same diff-review against codex + gemini + grok in parallel; aggregate verdicts into a unified report. Needs ≥2 CLIs installed. |
| `/grok:inspect [--json]` | Show the merged Grok config (AGENTS.md, skills, MCP, rules, permissions) that will apply to the next call. |
| `/grok:worktree [list\|gc\|rm <name>]` | Manage Grok-managed git worktrees (used by the `--worktree` flag on ask/research/rescue). |
| `/grok:sessions [list\|search <q>\|restore <id>]` | List, search, or restore Grok-native sessions (separate from plugin job ids). |
| `/grok:memory [edit\|stats\|clear\|enable\|disable]` | View / edit / wipe Grok's cross-session memory. |
| `/grok:mcp [list\|add\|remove\|doctor]` | Manage MCP servers configured for Grok. |
| `/grok:imagine <description>` | Generate an image from text using Grok Imagine. Returns the saved file path. |
| `/grok:imagine-video <description>` | Generate a video from text using Grok Imagine. Returns the saved file path. |
| `/grok:rescue <task>` | Delegate investigation, debugging, or a substantial task to Grok via the `grok-rescue` subagent. |
| `/grok:status [job-id] [--all]` | List active and recent Grok jobs in this workspace. |
| `/grok:result [job-id]` | Show the stored output of a finished job — including the underlying Grok `sessionId` for resumption. |
| `/grok:cancel [job-id]` | Cancel an active background job. |
| `/grok:purge [--older-than 30d]` | Delete recorded job metadata + log files from disk. |

## Example: image and video generation

Grok ships builtin `/imagine` and `/imagine-video` commands that this plugin
surfaces directly:

```
/grok:imagine a tiny red apple on a white plate
```

```
Image: /Users/you/.grok/sessions/<encoded-cwd>/<session>/images/1.jpg

Open with:
  open "/Users/you/.grok/sessions/<encoded-cwd>/<session>/images/1.jpg"

Session: 019e2841-...  (resume: grok -r 019e2841-...)
```

The image (or video, for `/grok:imagine-video`) is saved under
`~/.grok/sessions/<encoded-cwd>/<session-id>/images/` and the path is
printed. The plugin does not move or copy the file — `open` (macOS) or
`xdg-open` (Linux) opens it in the default viewer. Pass `--json` to get a
parseable `{kind, description, path, sessionId, raw}` envelope instead of
the friendly text format.

Default timeouts are 5 minutes for images, 15 minutes for video; override
with `--timeout 30m` or `--timeout 0` (disable). Content-policy refusals
come through as plain text (no markdown link) so you can see Grok's reason.

## Example: review vs. adversarial-review

Same diff, two different framings.

**`/grok:review`** — reads like a code review:

> The new `--timeout` flag is wired through `cmdAsk`, `cmdReview`, and
> `cmdTask` consistently. `parseDuration` accepts the documented forms
> (`s`/`m`/`h`/`d`). Tests cover the typical paths. Looks good.

**`/grok:adversarial-review`** — reads like an attacker:

> **BLOCKING.** Node's `setTimeout` silently truncates delays exceeding
> 2³¹−1 ms (~24.85 days) to ~1ms, with only a `TimeoutOverflowWarning`.
> `parseDuration("30d")` returns 2.59B ms, so a user passing
> `--timeout 30d` wraps to ~1ms and the timer fires immediately — the job
> is mislabeled `timed-out` before it could even start.

Both pass through the same plugin. The prompt template frames the model
differently — adversarial mode is in `prompts/adversarial-review.md` and
explicitly tells Grok to default to skepticism, prioritize trust-boundary
and concurrency failures, and not give credit for partial fixes or good
intent.

## Try it locally before installing

```
git clone https://github.com/taibaran/grok-plugin-cc.git
claude --plugin-dir ./grok-plugin-cc/plugins/grok
```

Note the `/plugins/grok` suffix — `--plugin-dir` expects the path that
contains `.claude-plugin/plugin.json`, not the repo root.

## Requirements

- macOS or Linux
- Node.js 20+ and npm
- Grok CLI: `curl -fsSL https://x.ai/cli/install.sh | bash`
- Authentication, choose one:
  - Run `!grok login` and complete the browser OAuth flow
  - Set `GROK_CODE_XAI_API_KEY` (from https://console.x.ai) — either inline
    or in `~/.claude/settings.json` under `env`
  - Or configure OIDC (`GROK_OIDC_ISSUER` + `GROK_OIDC_CLIENT_ID`) or an
    external auth provider (`GROK_AUTH_PROVIDER_COMMAND`)
- A SuperGrok Heavy subscription (per xAI's announcement for early beta)

## Model

By default the plugin pins every Grok invocation to `grok-build`, the only
public model currently exposed via `grok models`. Override precedence
(highest wins):

1. `--model <id>` per call: `/grok:ask --model grok-build <question>`
2. `GROK_PLUGIN_MODEL=<id>` env var (set in `~/.claude/settings.json` under
   `env`)
3. Workspace `config.activeModel` (set automatically by `/grok:setup` when
   the default is unavailable for your account, via a fallback chain)
4. `DEFAULT_MODEL` constant in `plugins/grok/scripts/lib/grok.mjs`

`/grok:setup` reports the currently active model and where it came from.

## Effort and turns

- `--effort <low|medium|high|xhigh|max>` controls Grok's reasoning depth.
  Higher levels cost more and take longer but produce more thorough output.
  Leave unset to use Grok's own default.
- The companion sets a conservative default `--max-turns` budget (30 for
  ask, 60 for review). Larger tasks should use `/grok:rescue` whose `task`
  invocation runs unbounded.

## Timeouts

Every per-call subcommand accepts `--timeout <duration>`:

```
/grok:ask --timeout 90s explain monads
/grok:review --timeout 30m
/grok:rescue --timeout 0 investigate slow build      # disable
```

Defaults: ask = 5 min, review = 20 min, rescue/task = **unbounded** (rescue
work is open-ended; cancel with `/grok:cancel <job-id>` if it overshoots).
Accepted forms: `300s` / `5m` / `1h` / `500ms` / bare integer (ms).

Exit code on timeout is **124** (matches `timeout(1)`), distinguishable from
policy refusals (2) and missing-binary (127). Durations exceeding Node's max
setTimeout (~24.85 days) are clamped with a stderr warning so the timer
doesn't silently wrap to ~1ms.

## Session continuity

Grok's `--session-id` flag creates a new session if the ID doesn't exist or
resumes it if it does. Use this from the plugin to chain rescue tasks:

```
/grok:rescue --session-id pr-1234-debug investigate the failing test
/grok:rescue --session-id pr-1234-debug now apply the smallest fix
```

The companion records the underlying Grok `sessionId` on every job, so
`/grok:result <job-id>` shows it and you can drop down into a raw
`grok -r <session-id>` when you want to leave Claude.

## Privacy & security

This plugin runs Grok against your local code. Be deliberate about what you
send and where it goes.

### What gets sent to xAI / your configured backend

- `/grok:ask` — your literal question text.
- `/grok:review` and `/grok:adversarial-review` — the local `git diff`
  (working-tree / staged / branch — depending on `--scope`), capped at
  4 MB. Whatever is in that diff is what Grok sees.
- `/grok:rescue` — your prompt text. Grok may also read files in the
  workspace itself; the plugin does not pre-load files for it.
- The stop-review-gate hook (when enabled) — the working-tree diff plus a
  short summary of Claude's last message.

If you use the default browser-OAuth auth path, the model traffic goes
through `cli-chat-proxy.grok.com`; if you've configured a custom
`GROK_CLI_CHAT_PROXY_BASE_URL` or an enterprise OIDC + proxy setup, traffic
follows your config.

### What stays local

- `${CLAUDE_PLUGIN_DATA}/state/<workspace>/jobs/<id>.{stdout,stderr}.log` —
  full Grok output for every backgrounded job.
- `${CLAUDE_PLUGIN_DATA}/state/<workspace>/jobs/<id>.json` — job metadata
  (timestamps, exit codes, the prompt text, the model used, sessionId).
- `${CLAUDE_PLUGIN_DATA}/state/<workspace>/config.json` — review-gate
  toggle + persisted fallback model.

Use `/grok:purge` to delete them; `/grok:purge --older-than 30d` to delete
only old ones.

### Environment scrubbing

The spawned `grok` process receives an **allowlisted** subset of the
parent environment, not the full env. The allowlist covers `PATH`, `HOME`,
locale, terminal, temp/XDG dirs, the documented Grok env vars
(`GROK_CODE_XAI_API_KEY`, `GROK_CLI_CHAT_PROXY_BASE_URL`, `GROK_OIDC_*`,
`GROK_AUTH_PROVIDER_*`, `GROK_HOME`, etc.), proxy settings, and
`NODE_EXTRA_CA_CERTS`. Everything else — `ANTHROPIC_API_KEY`,
`GITHUB_TOKEN`, `OPENAI_API_KEY`, `AWS_*`, `SSH_AUTH_SOCK`, `NODE_OPTIONS`,
npm internals — is dropped. If the upstream `grok` binary (or anything it
spawns) is ever compromised, the blast radius is limited to what grok
actually needs.

### Write mode

`--write` (only on `/grok:rescue` / `task`) runs Grok with `--yolo`
(auto-approve all tool executions). The plugin **refuses** `--write`
unless `GROK_PLUGIN_ALLOW_WRITE=1` is set in the environment. Set it
intentionally, ideally per-workspace via `~/.claude/settings.json`'s `env`
field, only in trees where you accept that an agent can edit files.

### Stop-review-gate strict mode

By default the stop hook **fails open** on infrastructure errors (grok
missing, auth failed, timeout, parse error) so a broken Grok install does
not strand your session. To make those failures **block** stop instead,
set `GROK_REVIEW_GATE_STRICT=1`. Useful for environments where
"the gate could not run" should be treated as "do not stop yet."

### Capability probing

Grok ships frequently and is still pre-1.0. `/grok:setup` runs a capability
probe at setup time — it executes `grok --help` and verifies that every
flag the companion depends on is present. If a future Grok release renames
a flag without a semver bump, setup surfaces the missing flag instead of
the companion failing in a confusing way at run time.

### Terminal-output sanitization

Grok's stdout/stderr is piped through a sanitizer that strips ANSI/OSC
escape sequences (cursor moves, OSC 52 clipboard writes, OSC title bars)
and dangerous C0 control bytes before reaching your terminal. The
sanitizer is stream-aware — escape sequences split across chunk boundaries
are held back until they complete. The on-disk log keeps raw bytes for
debugging.

## Architecture

```
grok-plugin-cc/
├── .claude-plugin/marketplace.json   ← marketplace metadata at repo root
├── plugins/grok/                     ← the plugin itself
│   ├── .claude-plugin/plugin.json    ← plugin manifest
│   ├── agents/grok-rescue.md         ← subagent definition
│   ├── commands/                     ← slash-command markdown files
│   ├── hooks/hooks.json              ← SessionStart, SessionEnd, Stop gate
│   ├── prompts/                      ← review + adversarial-review + stop-gate templates
│   ├── schemas/review-output.schema.json
│   ├── scripts/
│   │   ├── companion.mjs             ← dispatcher
│   │   ├── session-lifecycle-hook.mjs
│   │   ├── stop-review-gate-hook.mjs
│   │   └── lib/                      ← state, args, git, process, render, verdict, prompts, grok
│   └── skills/                       ← grok-cli-runtime, grok-prompting, grok-result-handling
├── tests/                            ← 79 unit tests (node:test, no devDeps)
├── .github/workflows/ci.yml          ← CI matrix Node 20/22 + smoke job
└── package.json  README.md  LICENSE  CHANGELOG.md
```

The two-level layout (marketplace at repo root, plugin in `plugins/grok/`)
mirrors the convention used by `openai/codex-plugin-cc` and
`taibaran/gemini-plugin-cc`, and is what Claude Code's marketplace schema
expects.

All slash commands invoke
`node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" <subcommand>`.
`${CLAUDE_PLUGIN_ROOT}` resolves to wherever the plugin is installed
(`~/.claude/plugins/<plugin-id>/`), so the path stays consistent across
local-dev and installed setups. The companion handles:

- subprocess management of the `grok` CLI
- diff capture (working-tree / staged / branch)
- review prompt construction (standard vs adversarial)
- background job tracking under `${CLAUDE_PLUGIN_DATA}/state/<workspace>/jobs/`
- auth-failure classification with actionable hints
- timeout management (SIGTERM → SIGKILL escalation)
- exit-0-on-internal-error detection (Grok returns exit 0 even on internal
  `{"type":"error"}` payloads, so the companion always parses the JSON
  envelope before deciding job status)

## License

Apache-2.0 (see [LICENSE](LICENSE)).
