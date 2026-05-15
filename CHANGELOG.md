# Changelog

All notable changes to **grok-plugin-cc** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.7] - 2026-05-15

`/goal` round-8 review of v0.8.6: 3/3 consensus on a single CRITICAL
regression + a real per-reviewer accounting bug from Grok.

### Bug fixes

- **3/3 reviewer consensus — `--timeout 0` broke the CLI fallback**.
  v0.8.6's `Math.max(0, timeoutMs - elapsed)` collapsed to 0 for the
  documented "unbounded" sentinel, then the `< 5000` guard always
  tripped → fallback silently skipped, gemini workaround regressed.
  **Fix**: `remainingBudgetMs(timeoutMs, elapsed)` now treats 0 as a
  passthrough (returns 0 = unbounded). The skip-guard now requires
  `timeoutMs > 0 && budget > 0 && budget < FALLBACK_MIN_BUDGET_MS`.

- **Grok HIGH #2 — batch wall-clock starved fast buggy peers**.
  v0.8.6 used a single `startedAtMs` for the whole `Promise.all`. If
  the slowest sibling took 9 of 10 minutes, the gemini fallback got
  ~1 min of budget even though gemini's own peer attempt took 8s.
  **Fix**: per-reviewer accounting via each `r.elapsedMs` (already
  recorded by `spawnReviewer`).

- **Grok MED #3 — FALLBACK_MIN_BUDGET_MS too aggressive at 5000ms**.
  Spawn cold path can eat 2-6s on a loaded machine. Lowered to 2000ms
  (and named the constant explicitly so it's no longer magic).

- **Grok MED #4 / Grok LOW #5 / Grok LOW #6 — testability**.
  Predicate + budget logic extracted to module-scope helpers
  (`shouldFallbackToCli`, `isPeerEmptyDiffMessage`, `remainingBudgetMs`,
  `MAX_PEER_EARLY_EXIT_BYTES`, `FALLBACK_MIN_BUDGET_MS`), all
  exported. Replaces 3 source-grep tests with 10 behavioral ones that
  exercise edge cases (parsed-verdict-with-mid-prose-phrase,
  long-output-rejection, empty-diff-rejection, anchored-regex,
  per-reviewer budget, unbounded passthrough).

- **Grok LOW — dead `startedAt` alias**. Removed.

- **Test infrastructure**. v0.8.7's helper extraction means test
  files now `import` from companion.mjs to call the helpers directly.
  Without a guard, every import would trigger `main()` with no
  subcommand → usage error → test failure. Gated `main()` on
  `process.argv[1] === fileURLToPath(import.meta.url)` so importing
  the module no longer runs the CLI dispatcher.

### Tests

- 10 new behavioral tests on the extracted helpers (replaces 3
  source-grep tests).
- Total suite: 277 passing.

## [0.8.6] - 2026-05-15

`/goal` round-7 (the first round where Gemini actually delivered a
review, via the v0.8.5 CLI fallback). All 3 reviewers converged on the
same bug in the v0.8.5 workaround itself.

### Bug fixes

- **3/3 reviewer consensus — fallback predicate was too greedy**.
  v0.8.5's check `/Nothing to review/i.test(r.output)` was unanchored
  → a real review that contained the phrase "nothing to review" in
  prose (e.g. "nothing to review in the test utilities because...")
  would have its real findings silently discarded and replaced with
  a redundant CLI rerun. **Fix**: tightened to require all of:
    1. `r.via === "peer"` (only retrying peer routing)
    2. `r.verdict === "UNPARSED"` (a real review always has VERDICT:)
    3. output starts with "Nothing to review" (anchored ^ regex)
    4. output length < 400 bytes (real reviews are multi-KB)
    5. our captureDiff DID find a non-empty diff

- **Gemini MED — fallback timeout budget was effectively doubled**.
  v0.8.5 passed the full `timeoutMs` to the CLI re-spawn, so a user
  who configured a 10-minute timeout could end up waiting 20 minutes
  (peer attempt + full CLI attempt). **Fix**: track wall-clock at
  the start of the parallel batch, compute `remainingMs = max(0,
  timeoutMs - elapsed)`, pass that to the fallback. If < 5s remains,
  skip the fallback entirely and keep the peer result.

- **Grok LOW — dead field `peerFallbackFrom`**. v0.8.5 wrote
  `newResult.peerFallbackFrom = "peer"` but nothing ever read it.
  Removed.

### Tests

- 3 new behavior tests asserting the tightened predicate shape, the
  remaining-budget calculation, and the removed dead field.
- Total suite: 269 passing.

## [0.8.5] - 2026-05-15

Self-healing workaround for [gemini-plugin-cc#4](https://github.com/taibaran/gemini-plugin-cc/issues/4).

### Background

While running `/grok:aggregate-review` repeatedly during the v0.8.x
`/goal` loop, Gemini's verdict came back as "Nothing to review" every
single round — even when the diff was clearly non-empty. Root cause
(reported upstream): gemini-plugin-cc's `captureDiff` for
`--scope branch` calls `git diff -- <ref>...HEAD`. The `--` separator
makes git interpret the ref-range as a *pathspec* (non-existent file)
instead of a refspec, returning 0 bytes + exit 0 + spurious "Nothing
to review". The fallback to the no-`--` form only fires on non-zero
exit, which never triggers.

Verified: grok-plugin-cc (this repo) and openai/codex-plugin-cc do
**not** have this bug — only gemini-plugin-cc.

### What v0.8.5 does

In `/grok:aggregate-review`, after collecting peer-routed results, if
ANY peer reviewer returned a "Nothing to review" message AND our own
`captureDiff` shows the diff is non-empty, we **re-spawn that
reviewer with the raw CLI path** (the v0.7.0 fallback that uses our
captured diff via `-p ""` + stdin or `--prompt-file`). The original
peer attempt's wasted ~150ms is dwarfed by the time saved getting a
real review.

The per-reviewer detail in the report now annotates the routing path
as `cli-fallback` instead of `peer` when this triggers, so users can
see exactly what happened.

### Self-healing semantics

When gemini-plugin-cc ships a fix for #4, peer routing will produce
real output and the "Nothing to review" check won't match → no
fallback triggers → fast peer-plugin routing resumes. No code change
needed on this side.

### Tests

- 266 passing (unchanged — the fallback is exercised end-to-end the
  next time `/grok:aggregate-review` runs against a real diff). A
  behavioral test with stacked fake-grok + fake-gemini + fake-codex
  binaries would add real coverage; tracked for a future round.

## [0.8.4] - 2026-05-15

`/goal` loop round-5: aggregate-review against v0.8.2 surfaced 1
CRITICAL security regression + 3 test-quality issues (Codex + Grok
agreed; Gemini still "nothing to review").

### Security

- **Codex P1 — subagent Bash scope** (`agents/grok-aggregate-review.md`,
  `agents/grok-rescue.md`). Both subagents declared `tools: Bash`
  (unrestricted). A prompt-injection vector in `$ARGUMENTS` could
  bypass the prompt-level "only call companion.mjs" guidance and run
  arbitrary shell commands. **Fix**: scoped both subagents'
  permissions to `Bash(node:*)` — Claude Code's tool-permission layer
  now enforces "node-only" regardless of prompt text.

### Test quality (Codex P2 + Grok M1 + Grok L2 + Grok L3)

- **Race + vacuous-pass in promptFile-leak test**. v0.8.2's test
  counted `os.tmpdir()` files globally → racy against concurrent
  greps, and on a machine without `grok` on PATH cmdReview's
  `which("grok")` guard exited BEFORE the timeout path, so the test
  passed without exercising the code. **Fix**: put a fake-grok on
  PATH + set TMPDIR to an isolated dir so the readdir is scoped only
  to files this test could have created.

- **Missing coverage for grokBaseArgs failure path**. The v0.8.2
  reordering protected TWO early-exit sites (`grokBaseArgs` throw +
  `resolveTimeoutMs` exit) but only the latter had a behavioral test.
  Added a parallel test that triggers `grokBaseArgs` via an invalid
  `--allow` rule (control byte) and asserts no leak.

- **Source-grep test for cmdTask spread order**. The v0.8.2 commit
  added a source-grep test in the same change that explicitly
  rejected source-grep tests for cmdReview — direct contradiction.
  Replaced with a behavioral assertion: spread `{effort:"low"}`
  followed by explicit `effort:"high"` into `grokBaseArgs` must emit
  exactly one `--effort high`, locking the merge semantics rather
  than the source-string shape.

### Tests

- 3 new behavior tests (replaced 2 brittle ones).
- Total suite: 266 passing.

## [0.8.3] - 2026-05-15

UX/architecture fix: `/grok:aggregate-review` now appears as an **agent**
operation in Claude Code (via the `Agent` tool), not as a raw shell call.

### What changed

- **New subagent**: `plugins/grok/agents/grok-aggregate-review.md`
  (model: sonnet, tools: Bash). A thin forwarder — its only job is to
  invoke `node companion.mjs aggregate-review ...` and return stdout
  verbatim. Matches the existing `grok:grok-rescue` pattern.
- **Slash command rewritten**: `plugins/grok/commands/aggregate-review.md`
  now dispatches through `Agent(subagent_type: "grok:grok-aggregate-review")`
  instead of invoking Bash directly. Includes `--background`/`--wait`
  execution-mode handling per the rescue pattern.

### Why

Users reported the command "appeared as shell, not as a grok agent" in
the Claude Code UI. The underlying mechanics are identical — companion.mjs
still does the parallel codex/gemini/grok orchestration with the peer
plugin routing from v0.7.1 — but the user-visible tool surface is now
`Agent` rather than `Bash`. This matches how `/grok:rescue` ships and
gives the command a consistent agent-style entry point.

### Tests

- Updated `tests/v0-7-0-aggregate-review.test.mjs` to assert on the
  new agent-routing structure (subagent_type, allowed-tools includes
  Agent, agent definition file shape).
- Total suite: 265 passing.

## [0.8.2] - 2026-05-15

Round-3 fixes — `/goal` loop iteration on the v0.8.x line. The
aggregate-review against v0.8.1 surfaced one real bug (Grok LOW about
incomplete coverage of early-exit leak paths) and two defensive
improvements.

### Bug fixes

- **Grok LOW (real bug) — second promptFile leak path in cmdReview**.
  v0.8.1 added `try { unlink } catch {}` to the `grokBaseArgs` catch,
  but `resolveTimeoutMs(flags.timeout)` calls `process.exit(2)` on an
  invalid `--timeout` AFTER `writePromptToTempFile` had already run.
  **Fix**: reordered cmdReview so EVERY flag validation
  (`grokBaseArgs`, `resolveTimeoutMs`) runs BEFORE
  `writePromptToTempFile`. The temp file is now allocated only once
  the call is guaranteed to proceed; runJob's existing `cleanupPaths`
  handles unlinking on success/error/timeout/disk-overflow.

- **Grok MED — `cmdTask` spread order**. The v0.8.1 code wrote
  `{ effort, ...extractPolicyFlags(flags) }`, putting the explicit
  (validated) `effort` BEFORE the spread. If `extractPolicyFlags` ever
  grows an `effort` key, the spread would silently overwrite the
  validated value. Defensive reordering: spread first, explicit
  `effort` last → explicit always wins.

- **Grok LOW (test brittleness) — source-grep test for cmdReview
  cleanup**. Replaced with a behavioral test that actually invokes
  `companion.mjs review --timeout nonsense_value` against a tiny git
  repo + dirty working tree, then checks `/tmp` for grok-prompt-*
  files. Immune to Prettier / refactor / formatting changes.

### Defensive additions

- New regression test that `grokBaseArgs({ effort: "high" })` actually
  emits `--effort high`. Closes Grok's HIGH false-alarm by locking
  behavior in source-of-truth rather than relying on a future reader
  to trace the function definition.

### Tests

- 3 new behavior tests in `tests/v0-8-0-permission-rules.test.mjs`
  (1 replaces a brittle one).
- Total suite: 264 passing.

## [0.8.1] - 2026-05-15

Round-2 fixes for v0.8.0, found by running the new `/grok:aggregate-review`
on v0.8.0's own diff (HEAD~1..HEAD). Codex (via peer) flagged 3 issues
and Grok (via peer) flagged 5 — every fix below traces to a real
reviewer-found bug.

### Bug fixes

- **Grok HIGH — `--restore-code` dead flag**. Was added to
  `COMMON_BOOL_FLAGS` in v0.8.0 but never wired to `extractPolicyFlags`,
  `grokBaseArgs`, or `capabilityProbe`. Silently dropped. **Removed**
  from the flag set until v0.9.0 builds out the resume path.

- **Grok MEDIUM — control-byte regex allowed TAB + LF**
  (`lib/grok.mjs::validateRuleArray`). The v0.8.0 regex
  `[\x00-\x08\x0b-\x1f\x7f]` accepted `\x09` (tab) and `\x0a` (newline).
  A `--rules "evil\nadditional directive"` could survive validation and
  end up echoed back into model context. **Fix**: split into two
  validators — `CONTROL_BYTE_STRICT` (no TAB, no LF, used by
  `--allow`/`--deny`/`--rules`/`--tools`/`--sandbox`/`--agent`) and
  `CONTROL_BYTE_MULTILINE` (TAB + LF + CR allowed, used by
  `--system-prompt-override` since real system prompts have
  paragraphs).

- **Grok MEDIUM — `cmdTask` skipped policy flags**
  (`companion.mjs::cmdTask`). The v0.8.0 changelog claimed "Permission
  Model Parity" but `/grok:task` (the write-mode rescue) still called
  `grokBaseArgs({readOnly, model, jsonOutput})` directly, dropping
  `--allow`/`--deny`/`--rules`/`--max-turns`/etc. **Fix**: `cmdTask`
  now uses `...extractPolicyFlags(flags)` like the other commands.

- **Codex P2.a — `cmdReview` leaked prompt file on validation failure**
  (`companion.mjs::cmdReview`). Calling `/grok:review --max-turns nope`
  would write the full diff prompt file via `writePromptToTempFile`,
  then `grokBaseArgs` would throw on the invalid `--max-turns`, and
  the early-exit path would leave the file in `/tmp`. **Fix**:
  `try { fs.unlinkSync(promptFile) } catch {}` inside the catch.

- **Codex P2.b — `cmdInspect` had no `maxBuffer`**
  (`companion.mjs::cmdInspect`). `grok inspect` output can exceed
  spawnSync's 1 MiB default in projects with many skills/MCPs;
  exceeded buffer left `r.status: null` and the helper exited 0 with
  truncated output. **Fix**: explicit `maxBuffer = HEADLESS_GROK_MAX_BUFFER`
  + ENOBUFS detection + hint pointing the user at `--json` redirect.

- **Codex P3 — `--flag=value` corrupted values containing `=`**
  (`lib/args.mjs::parseArgs`). The old `t.slice(2).split("=", 2)` form
  returns only the first 2 array slots, so `--system-prompt-override=Use A=B`
  became `{key: "system-prompt-override", value: "Use A"}` — the trailing
  `=B` was silently dropped. **Fix**: split on FIRST `=` using
  `indexOf("=")` + slice, preserving every `=` after the first separator.

### Tests

- 9 new regression tests in `tests/v0-8-0-permission-rules.test.mjs`.
- Total suite: 262 passing.

## [0.8.0] - 2026-05-15

**"Permission Model Parity + Inspectability"** — the v0.8.0 release the
4-LLM research pass (Codex + Gemini + Grok + Claude general) unanimously
picked as the highest-value next step.

### New commands

- **`/grok:inspect [--json]`** — wraps `grok inspect`. Shows the merged
  config (AGENTS.md, skills, MCP, rules, permissions, LSP, hooks) that
  will apply to the next call. All 4 LLMs flagged this as a gap: the
  single most useful "why is grok doing X?" debugging tool was
  unreachable from inside Claude Code.

### New flags (threaded through ask / review / research / best-of)

- **`--allow <rule>` / `--deny <rule>`** (repeatable) — fine-grained
  permission rules with `ToolPrefix(glob)` syntax: `--allow "Bash(npm*)"
  --deny "Bash(sudo*)"`. Strictly better than the old coarse
  `READ_ONLY_DISALLOWED_TOOLS` constant.
- **`--tools <list>`** — explicit allowlist of tool names; sharper than
  denylist for /grok:ask read-only-by-intent.
- **`--rules <text|@file>`** (repeatable) — per-call system-prompt
  guardrails without touching AGENTS.md.
- **`--max-turns <N>`** — user override of the hardcoded plugin defaults
  (ask=30, review=60, research=200, best-of=30). The default is still
  applied when `--max-turns` is absent.
- **`--no-subagents` / `--no-plan` / `--verbatim`** — Grok CLI kill-switches.
- **`--reasoning-effort <effort>`** — distinct from `--effort`; applies
  only to reasoning models.
- **`--system-prompt-override <prompt>`** — advanced; size-capped at 16 KiB.
- **`--permission-mode <mode>`** — user-selectable
  (`default|acceptEdits|auto|dontAsk|bypassPermissions|plan`).
- **`--sandbox <profile>`** — `GROK_SANDBOX` equivalent; profile name
  validated against control bytes + path separators.
- **`--agent <name>`** — pick a bundled Grok agent persona.

### Hardening

- **`validateRuleArray()`** in `lib/grok.mjs` — every `--allow`/`--deny`/
  `--rules` entry is sanity-checked: max 256 entries, max 1 KiB per
  entry, no control bytes (prompt-injection defense). Same defense
  applied to `--system-prompt-override`, `--sandbox` profile name, and
  `--agent` name.
- **`capabilityProbe` extended** — `--allow`, `--deny`, `--tools`,
  `--rules`, `--no-subagents`, `--no-plan`, `--reasoning-effort`,
  `--system-prompt-override`, `--verbatim`, `--sandbox`, `--agent`. Same
  G1 motivation as v0.6.0: if grok renames any of these, setup fails
  cleanly instead of users hitting "unknown option" at runtime.

### Parser changes

- New `COMMON_REPEATABLE_FLAGS` set + `repeatableFlags` parser option.
  `--allow`/`--deny`/`--rules` accumulate into arrays; non-repeatable
  flags still overwrite (last-wins).
- New `COMMON_VALUE_FLAGS` entries: `tools`, `max-turns`,
  `reasoning-effort`, `system-prompt-override`, `permission-mode`,
  `agent`, `sandbox`.
- New `COMMON_BOOL_FLAGS` entries: `no-subagents`, `no-plan`, `verbatim`,
  `restore-code`.

### Cross-command consistency

- `/grok:review` and `/grok:adversarial-review` now accept `--check`.
- All policy flags above are accepted across ask / review / research /
  best-of (via the new shared `extractPolicyFlags()` helper).

### Tests

- 21 new behavior tests in `tests/v0-8-0-permission-rules.test.mjs`:
  parser accumulation, grokBaseArgs validators, end-to-end argv
  capture via fake-grok, capabilityProbe regression.
- Total suite: 252 passing.

## [0.7.3] - 2026-05-15

Two real bugs discovered while running the v0.8.0 research pass with
all four LLMs against the plugin's own source tree.

### Bug fixes

- **Grok doom-loop on plugin skill discovery** (`lib/grok.mjs`).
  When `grok` is spawned in a directory containing the plugin source
  (the dev tree or any project that bundles the plugin), grok
  auto-discovers `plugins/grok/skills/grok-cli-runtime`,
  `grok-prompting`, and `grok-result-handling` and exposes them as
  callable tools. The model then calls `grok-cli-runtime` as if it
  were an integration tool; the CLI panics ("`use_tool can only
  dispatch to integration tools`"); after 5 repeats the doom-loop
  guard terminates the session with no useful output. Fix: added the
  three skill names to `READ_ONLY_DISALLOWED_TOOLS` and
  `AUTH_PROBE_DISALLOWED_TOOLS` via a new
  `GROK_PLUGIN_SKILL_NAMES` constant so grok never sees them as tools.

- **`DEFAULT_RESEARCH_MAX_TURNS` was too low** (`companion.mjs`).
  The 60-turn budget was tripping users with `Internal error:
  max_turns exceeded` on legitimate deep research prompts that
  require reading 10-20 files (each file read burns a turn). Bumped
  to 200, with a comment noting `--timeout` is the real DoS guard.

### Tests

- 5 new regression tests in `tests/v0-7-3-grok-skill-doom-loop.test.mjs`.
- Total suite: 231 passing.

## [0.7.2] - 2026-05-15

Round-2 bug fixes for `/grok:aggregate-review`, found by running
the v0.7.1 dogfood (`/grok:aggregate-review --base HEAD~1 --scope branch`)
against v0.7.1 itself. Codex (via peer) and Grok (via peer) both
flagged real issues.

### Bug fixes

- **Grok BLOCKING — `spec.isPlainText` regression**
  (`companion.mjs::spawnReviewer`). The v0.7.0 round-2 fix that
  gates `parseGrokJson` behind a plain-text marker was scoped to
  `spec.isPlainText`, but `isPlainText` is a property of the
  `buildCmd` RETURN value, not of the spec itself. `spec.isPlainText`
  was always `undefined`, so the guard was always taken — exactly
  the regression v0.7.0 round-2 was supposed to fix. Now reads
  `buildResult.isPlainText`.

- **Codex P1 — `Verdict: needs-attention` slipped past failure check**
  (`companion.mjs::parseAggVerdict` + aggregate exit code logic).
  `codex-plugin-cc`'s review renderer writes `Verdict: needs-attention`
  (lowercase, hyphenated). The old `[A-Z_]+` capture tokenized that
  as `NEEDS`, which the failure check (REJECT/UNPARSED/etc.) didn't
  recognize. Codex findings could therefore aggregate as
  `Status: ok`. v0.7.2 widens the char class to `[A-Za-z_-]+`,
  normalizes hyphens-to-underscores and case-to-uppercase
  (`NEEDS_ATTENTION`), and inverts the failure check to an
  explicit-good whitelist (`AGG_CLEAN_VERDICTS`) so future
  unrecognized verdicts default to failure.

- **Codex P2 — peer plugin counted without CLI presence**
  (`AGG_REVIEWERS[*].detect`). Returning `{kind: "peer"}` whenever
  the cached companion.mjs file exists treated an installed plugin
  as an installed reviewer. If the user has the peer plugin cached
  but the underlying CLI isn't on PATH, the command can pass the
  "at least two reviewers" guard and then fail inside the peer
  with setup/127 errors. v0.7.2 requires both peer plugin AND
  `which(name)` for peer routing.

- **Codex P2 — focus text dropped on peer route**
  (`AGG_REVIEWERS[*].buildCmd`). The aggregate prompt's `focus`
  positional was passed to the CLI fallback path but never reached
  peer reviewers. Now: when focus is non-empty, every reviewer
  auto-switches its sub to `adversarial-review` (which accepts a
  trailing focus positional in all three peer plugins) and the
  focus is appended to the args.

### Tests

- 5 new behavior tests covering the four fixes above.
- Total suite: 226 passing.

## [0.7.1] - 2026-05-15

Architectural fix for `/grok:aggregate-review` — addresses a real
concern raised by the user during v0.7.0 review: spawning raw
codex/gemini binaries from inside our Node code bypassed each peer
plugin's safety layer.

### What changed

Each reviewer's `detect()` now returns either `{kind: "peer", path}`
(peer plugin's companion.mjs found in `~/.claude/plugins/cache/`) or
`{kind: "cli", path}` (raw CLI on PATH). The reviewer's `buildCmd()`
routes through whichever was found.

Peer routing invokes `node <peer-companion>.mjs <review|adversarial-review> --wait`,
which:
- Inherits the peer plugin's prompt-file handling (no ARG_MAX risk).
- Inherits the peer plugin's env scrubbing + ANSI sanitization.
- Inherits the peer plugin's capability probes + auth handling +
  fallback model chain.
- Is sync-by-design (`--wait` blocks until the job completes).

The previous raw-CLI path (with v0.7.0 round-2 hardening) stays as
the fallback when a peer plugin isn't installed.

### Why not the rescue subagents directly

`codex:codex-rescue` and `gemini:gemini-rescue` return acknowledgement
stubs instead of actual results (upstream bug — see
[openai/codex-plugin-cc#324](https://github.com/openai/codex-plugin-cc/issues/324)
and [taibaran/gemini-plugin-cc#3](https://github.com/taibaran/gemini-plugin-cc/issues/3)).
Until those land, calling each peer plugin's `companion.mjs review --wait`
directly is the best available route through the peer plugin layer.

### Output changes

- Header line now annotates each reviewer with `(via peer)` or `(via cli)`.
- Per-reviewer detail line shows `Via: peer` / `Via: cli`.

### Tests

- 5 new behavior tests cover: `findPeerCompanion` semver-descending
  version pick; `PEER_PLUGIN_LOOKUP` coverage of codex / gemini / grok;
  each reviewer's `detect()` consulting `findPeerCompanion` first;
  `<sub> --wait` being passed to all 3 peer plugins; output annotations.
- Total suite: 222 passing.

## [0.7.0] - 2026-05-15

Meta-aggregator command for multi-LLM consensus reviews.

### New commands

- **`/grok:aggregate-review [focus]`** — captures the current diff (same
  scope rules as `/grok:review`) and runs it through every installed
  peer CLI in parallel: Codex, Gemini, Grok. Aggregates verdicts into a
  unified markdown report with a per-reviewer detail section and a
  summary table (verdict + blocking count + nits count + elapsed time).
  Exits 1 if any reviewer returned `VERDICT: REJECT`, 0 otherwise.

  Per-reviewer command shapes (cross-checked against each CLI's --help):
    - `codex exec --skip-git-repo-check` with prompt on stdin
    - `gemini --skip-trust --approval-mode plan -p <prompt>`
    - `grok -p <prompt>` with the plugin's standard read-only flags
      (--permission-mode plan + --disallowed-tools)

  Defense-in-depth: every peer CLI is spawned with `cleanGrokEnv()` —
  the same env-scrubbing allowlist used for the local grok process. A
  compromised codex/gemini binary cannot exfiltrate ANTHROPIC_API_KEY,
  AWS_*, etc. through this path.

  Default per-reviewer timeout: 10 minutes. Override via `--timeout`.
  Requires at least two peer CLIs installed; the command refuses to run
  with only one because that's just `/grok:review` with extra steps.

### Tests

- 6 new structural + behavior tests in `tests/v0-7-0-aggregate-review.test.mjs`.
  Total suite: 208 passing.

## [0.6.0] - 2026-05-15

Three Grok-specific differentiator commands plus refactor of the headless
dispatcher. Four independent reviewers (Claude / Codex / Gemini / Grok)
audited across two rounds; eight real bugs and seven nits all landed in
this release.

### Round-2 bug fixes (Codex + Gemini)

- **Codex-A. ANSI escapes inside JSON `text` reach the terminal**
  (`companion.mjs::runHeadlessGrok`). `parsed.text` came from JSON which
  preserves `` payloads byte-for-byte through `JSON.parse`. Without
  `sanitizeForTerminal()` those reached the user's terminal raw (OSC 52
  clipboard injection, cursor moves, screen clear, color-spoofed phishing
  banners). Helper now sanitizes `parsed.text` and `parsed.message`.
  (Codex review.)

- **Codex-B. Non-timeout `spawnSync` errors mis-exit 0**
  (`companion.mjs::runHeadlessGrok`). `ENOBUFS` from a long /grok:research
  output left `r.status = null` and the helper still parsed + exited 0.
  Now sets explicit `maxBuffer = HEADLESS_GROK_MAX_BUFFER (32 MiB)` and
  refuses ALL non-ETIMEDOUT `r.error` codes, with a dedicated ENOBUFS
  hint pointing the user at `/grok:rescue` / `/grok:task` for streaming
  long-form sessions. (Codex review.)

- **Codex-C / Gemini-G1. ANSI injection through `/grok:models` footer**
  (`companion.mjs::cmdModels`). The footer used to print
  `effectiveModel()`, `cfg.activeModel`, and `GROK_PLUGIN_MODEL` raw —
  any of those is reachable via env or prompt-injection. All footer
  values now route through `sanitizeForTerminal()`. The `--set-default`
  positional gets a 128-char length cap (`MAX_MODEL_ID_LEN`) as
  defense-in-depth before reaching `setActiveModel`'s strict
  `MODEL_ID_PATTERN` validator. (Codex + Gemini.)

- **Codex. `/grok:models` has no timeout / auth hint**. An auth or
  network hang would block `/grok:models` indefinitely. Default timeout
  is now 30s (`DEFAULT_MODELS_TIMEOUT_MS`), overridable via `--timeout`.
  Auth failures route through `classifyAuthBlob` the same way
  `/grok:ask` does. (Codex review.)

- **Gemini-G2. `/grok:research` / `/grok:best-of` rejected `--effort MAX`**
  (`companion.mjs::cmdResearch`, `cmdBestOf`). `cmdAsk` normalized
  effort via `validateEffort()` (lowercases/trims); these two bypassed
  it and passed the raw user value to `grokBaseArgs` which does
  strict-case whitelist matching. `/grok:research --effort MAX` crashed
  while `/grok:ask --effort MAX` succeeded — surprising drift. Both
  now use `validateEffort`. (Gemini review.)

- **Gemini-G3. Tautological tests in `tests/v0-6-0-features.test.mjs`**.
  The `E2E: research default chain` test reproduced cmdResearch's
  internal default-flag logic in the test body and asserted on its own
  local variables. If `cmdResearch` broke, the test still passed.
  Replaced with subprocess-against-fake-grok tests in
  `tests/v0-6-0-round2-fixes.test.mjs` — runs the real `companion.mjs`
  with a fake `grok` on `$PATH` that records its argv to disk, then
  asserts on what the real CLI actually received. (Gemini review.)

### Round-2 nits (Gemini)

- **N2. `/grok:ask` silently ignored `--no-web-search`** — the flag
  parsed correctly but `cmdAsk` didn't thread `disableWebSearch` through
  to `grokBaseArgs`. Fixed; behaviorally tested.

- **N3. `VALID_EFFORTS` in `companion.mjs` duplicated
  `EFFORT_LEVELS` in `lib/grok.mjs`** — drift risk. Removed the local
  duplicate; `validateEffort` now consumes the canonical
  `EFFORT_LEVELS` import.

- **/grok:models auth-hint** (Codex) — added `[hint: auth expired …]`
  message when `grok models` fails with a recognizable auth blob,
  matching `/grok:ask` behavior.

### Round-1 fixes (Claude general / Grok — already landed before round-2)

### New commands (initial v0.6.0 scope)

- **`/grok:research <question>`** — deep research mode. Defaults: `--effort max`
  + `--check` self-verification loop + live web search ON. Override hooks:
  `--effort low|medium|high|xhigh|max`, `--no-check`, `--no-web-search`.

- **`/grok:models [--set-default <id>]`** — wraps `grok models`. With
  `--set-default <id>` (or `--set-default` followed by a positional id),
  persists the model into the workspace `activeModel` config. Footer shows
  the four-tier precedence: per-call `--model` > `GROK_PLUGIN_MODEL` env
  > workspace `activeModel` > plugin `DEFAULT_MODEL`.

- **`/grok:best-of <N> <prompt>`** — wraps `grok --best-of-n N`. Grok runs
  the prompt N ways in parallel and returns its best answer. Plugin caps
  N at `BEST_OF_N_MAX = 8` (each branch is full token-spend; the cap
  prevents accidental N=50 runs). Two argv forms accepted:
  `best-of 3 <prompt>` and `best-of --best-of-n 3 <prompt>`.

### Bug fixes from reviewer round

- **G1. Capability probe didn't verify v0.6.0 flags** (`lib/grok.mjs`).
  `capabilityProbe()` checked the v0.4.0-era core flags only. On a pre-0.6
  `grok` binary, `/grok:setup` would have reported green while
  `/grok:research` then failed at runtime with "unknown option: --effort".
  Required list now includes `--effort`, `--check`, `--best-of-n`,
  `--disable-web-search`. (Grok review.)

### Refactors

- **`runHeadlessGrok` extracted** (`companion.mjs`). The ~30-line tail
  (spawn → ETIMEDOUT handling → `parseGrokJson` dispatch → auth-hint
  emission → exit-code mapping) used to be copy-pasted across `cmdAsk`,
  `cmdResearch`, and `cmdBestOf`. v0.5.0's `[hint: ...]` lines would
  have only landed in one of three callers if not for this. Single
  source of truth now. (Claude general review nit-1.)

- **`bestof` → `best-of`** (`companion.mjs`, `commands/best-of.md`).
  Matches the hyphenated multi-word convention from `imagine-video` /
  `adversarial-review`. (Claude general review nit-2.)

- **`--no-check` flag for `/grok:research`** (`lib/args.mjs`,
  `companion.mjs`). Research mode defaults `--check` on; previously
  no documented way to disable. Now `--no-check` mirrors the
  `--no-web-search` shape. (Claude general review nit-5.)

### Tests

- 41 new behavior tests across `tests/v0-6-0-features.test.mjs` and
  `tests/v0-6-0-round2-fixes.test.mjs`. Total suite: 202 passing.
  Round-2 tests run `companion.mjs` as a subprocess with a fake `grok`
  on `$PATH` (writing its argv to disk, env-stripped by `cleanGrokEnv`
  so handoff uses a sibling `mode` file). This replaces the tautological
  reproduce-the-logic patterns Gemini flagged in round-2-G3.

### Known gaps (deferred from this release)

Grok review surfaced five missing Grok-CLI features the plugin doesn't
yet expose. Tracking for follow-up patches:

- `--sandbox <profile>` — kernel-level fs/net isolation (Grok's distinct
  security boundary vs. Claude/Codex/Gemini).
- `--worktree` — first-class git-worktree session isolation.
- Memory controls — `--no-memory` / `--experimental-memory`.
- Session resume — `--continue` / `--resume` from headless commands.
- MCP surface — `grok mcp` subcommands for managing external tool servers.

## [0.5.0] - 2026-05-15

Comprehensive 4-reviewer round (Claude / Codex / Gemini / Grok) surfaced
a fresh set of attack surfaces and code-quality opportunities. Five real
bugs + four refactor items addressed.

### Real bugs

- **C1. `findLastVerdictInString` O(n²) scan** (`lib/verdict.mjs`).
  Same pathological-input vulnerability Codex flagged for
  `findLastJsonObject` in round 4 — a wall of `{` chars with no `}`
  triggered N independent scans-to-EOF. The verdict scanner now uses
  the same `MAX_FAILED_SCANS_PER_CALL = 128` cap. (Codex.)

- **C2. Disk exhaustion via unbounded job logs** (`companion.mjs::runJob`).
  An adversarial prompt trapping Grok in an output loop could silently
  fill the host filesystem before the timeout fired. Added
  `MAX_JOB_LOG_BYTES = 500 MiB` cap: on overflow the process tree is
  terminated and the job is marked `disk-overflow`. (Gemini.)

- **C3. TOCTOU race in `/grok:result`** (`lib/state.mjs`,
  `companion.mjs`). The previous flow `safeJobLogPath` → `fs.openSync`
  had a race window in shared-machine environments where an attacker
  could swap a valid log for a symlink between the validation and the
  open. New `readBoundedJobLog` opens with `O_NOFOLLOW` (rejects
  symlink leaves), `fstat`s the opened fd (rejects non-regular files),
  and reads bounded — all through a single fd, no path-string races.
  (Gemini.)

- **C4. TerminalSanitizer pending-buffer DoS** (`lib/render.mjs`).
  An attacker streaming an unterminated ANSI sequence (`ESC [`
  followed by infinite chars without a terminator) would grow
  `this.pending` without bound and OOM the Node process. Cap at
  `MAX_PENDING_ESCAPE_BYTES = 4 KiB`: anything past this length is
  force-sanitized and dropped. (Gemini.)

- **C5. Default task timeout was `0` (unbounded)** (`companion.mjs`).
  Bumped to 2 hours — a hard backstop for runaway rescue agents
  while preserving the open-ended-by-design property for legitimate
  long rescues. Users can still pass `--timeout 0` to opt back into
  unbounded behavior. (Gemini.)

### Refactor

- **C6 + C9. Shared envelope parser and prompt-file helper.**
  `parseGrokJson` and `writePromptToTempFile` were each duplicated
  verbatim in `companion.mjs` AND `stop-review-gate-hook.mjs`.
  Both moved to `lib/grok.mjs` as exports. The duplication risk
  Codex flagged in round 3 (parsers could drift over time) is closed:
  one source of truth, used by both call sites. (Codex + Claude.)

- **C7 (partial). Behavior tests for newly-exported helpers.**
  Added 15 tests in `tests/v0-5-0-hardening.test.mjs` that exercise
  `parseGrokJson`, `writePromptToTempFile`, `readBoundedJobLog`, and
  `parseVerdict` directly — these used to be private and only
  source-shape-tested. Full conversion of all source-regex tests is
  v0.5.1 work. (Claude.)

- **C8 (deferred). Mock-grok integration tests.** Tracked for v0.5.1.

### Tests

- 161 tests (was 146 in v0.4.0). All passing.

## [0.4.0] - 2026-05-15

Round 3 of independent review. Codex, Gemini, and Grok all approved v0.3.0
for production but surfaced 8 follow-up improvements (4 real bugs, 4
defense-in-depth). All 8 are addressed here. 141 tests total (was 121).

### Real bugs fixed

- **B1. UTF-8 chunk tearing** (`companion.mjs::runJob`,
  `stop-review-gate-hook.mjs`). `proc.stdout.on("data", d => d.toString())`
  on raw Buffer chunks decodes multi-byte UTF-8 sequences split across
  chunks to `U+FFFD`, silently corrupting the JSON envelope and any
  user-visible output. Fix: `proc.stdout.setEncoding("utf8")` so Node's
  internal StringDecoder buffers incomplete sequences across data events.
  (Gemini round-3.)

- **B2. Branch diff capture used wrong git argument order** (`lib/git.mjs`).
  `git diff -- <ref>...HEAD` makes git interpret the refspec as a pathspec
  — the command exited 0 with empty output and the fallback never fired,
  silently producing "nothing to review" for any `--scope branch` review.
  Fix: drop the misplaced `--`; the refspec validator already prevents
  flag injection. (Codex round-3.)

- **B3. Read-only tool policy was inconsistent across call sites**
  (`lib/grok.mjs`). `grokBaseArgs` banned 3 tools, `authProbe` banned 6.
  Extracted to named constants `READ_ONLY_DISALLOWED_TOOLS` (banishes
  writes + shell but keeps web search + Agent for grounding) and
  `AUTH_PROBE_DISALLOWED_TOOLS` (banishes all tools for the deterministic
  probe). The difference is now intentional, named, and traceable.
  (Codex round-3.)

- **B4. `parseGrokJson` did not match the stop-gate's robust parser**
  (`companion.mjs`, `lib/verdict.mjs`). The companion called
  `JSON.parse(clean)` on the whole blob and silently fell through to
  "unknown" — any tracing noise between the envelope and EOF flipped error
  envelopes to "completed". Extracted `findLastJsonObject` into
  `lib/verdict.mjs` and used in both `parseGrokJson` (companion) and
  `parseGrokJsonEnvelope` (hook). The two parsers can no longer drift.
  (Codex round-3.)

### Defense-in-depth

- **B5. `/grok:result` reads are now bounded** (`companion.mjs`). New
  `readBoundedFile` caps stdout/stderr display reads at
  `MAX_REVIEW_JSON_BYTES` (8 MiB) with an explicit truncation marker. The
  on-disk file remains complete for forensic use. (Codex round-3.)

- **B6. `/grok:imagine` media-path shell-injection defense** (`companion.mjs`).
  The `open "${mediaPath}"` hint was a copy-paste shell-injection vector:
  a content-policy-bypassing model returning `![alt]("; rm -rf ~; #)`
  would have the plugin display `open ""; rm -rf ~; #"` for the user to
  copy. New `isSafeMediaPath` validates with a conservative regex
  (`^[A-Za-z0-9._/\-%@+]+$`); unsafe paths get a warning instead of an
  open command. (Gemini round-3.)

- **B7. JSON review schema vs prose alignment + strict validation**
  (`prompts/review.md`, `companion.mjs`). The prompt taught
  `Critical/Important/Nit` but the schema required
  `critical/high/medium/low`. Updated the prompt to use the schema's four
  levels. The shallow validator was replaced with a strict pass that
  enforces severity enum, bounded string lengths (64 KiB per field), and
  bounded array lengths (256 items) — defending against a misbehaving
  model returning a 5 MiB `summary` that locks up the terminal.
  (Grok round-3.)

- **B8. `isAlive` EPERM handling** (`lib/process.mjs`). The old contract
  was "EPERM → alive" to avoid reaping jobs owned by another user; in
  the plugin's threat model EPERM only happens on PID reuse (our PID
  exited; the kernel handed it to a daemon from another UID). Returning
  true caused state accumulation: pruneJobs thought the job was still
  alive, terminateProcessTree couldn't kill the foreign process. Now
  treats EPERM as "not our process anymore" and returns false.
  (Gemini round-3.)

### Tests

- 20 new regression tests in `tests/v0-4-0-hardening.test.mjs` pin each
  of the 8 fixes against future drift. Total: 141 tests, all passing.

## [0.3.0] - 2026-05-15

Hardening release. Three independent reviewers (Codex, Gemini, Grok)
audited v0.2.0 and surfaced four ship-blocking issues plus four high-
priority improvements. All eight are addressed in this release.

### Security fixes

- **`safeJobLogPath` symlink bypass** (`lib/state.mjs`) — the old check used
  `&&` between the plain-path and realpath dirname comparisons, so a symlink
  planted inside `jobsDir/` that pointed outside it (e.g. `/etc/hosts`) passed
  the plain check and was returned as a "safe" path. New behavior: both checks
  must pass independently. Realpath canonicalization is now required when the
  file exists; ENOENT (fresh job, log not yet written) is still accepted.
- **Stop-gate truncation fail-open** (`stop-review-gate-hook.mjs`) — the hook
  capped stdout at 256 KiB in memory, so a Grok run that streamed thought
  tokens before the final JSON envelope would silently fail the parse and
  default to `emitAllow()`. Now tees stdout to a temp file and re-reads it
  on close (bounded at 8 MiB to defend against runaway responses).
- **Prompt-injection via unescaped diff** (`lib/prompts.mjs`) — the repo
  diff was substituted into XML-tagged prompt blocks without escaping, so a
  malicious commit containing `</repository_context><system>IGNORE...</system>`
  could break out of its container. Now every repo/user-controlled value
  flows through `escapeXmlInTrustedBlock`, including the diff.

### Bug fixes

- **`capabilityProbe --cwd` ghost requirement** (`lib/grok.mjs`) — `--cwd`
  was listed as a required flag in the capability probe, but the plugin
  never actually emits `--cwd` (it uses `spawn({ cwd })` instead). A future
  Grok release that dropped the flag would have falsely broken `/grok:setup`.
  Removed from the required list with a comment explaining why.
- **Misleading task footer** (`companion.mjs`) — `cmdTask` ran with plain
  output (not JSON), so `parseGrokJson` always returned `kind: "unknown"`
  and `meta.session_id` was never populated. The footer surfaced the
  `requested_session_id` if present, but also accepted the never-populated
  `meta.session_id` as a fallback — implying resume semantics that didn't
  exist. Now only fires when the user explicitly passed `--session-id`.
- **`cmdImagine` policy-gate ordering** (`companion.mjs`) — the
  control-byte refusal ran AFTER the `which("grok")` check, so a CI runner
  without grok would mask the refusal with `exit 127`. Moved the gate
  before the binary check (matches `cmdTask --write` pattern).
- **ANSI-before-JSON.parse** (`companion.mjs`, `stop-review-gate-hook.mjs`)
  — `parseGrokJson` and `parseGrokJsonEnvelope` called `JSON.parse(raw)`
  directly. Grok normally emits clean JSON on stdout, but its Rust tracing
  layer can leak colored log lines under certain terminal configurations.
  A single stray escape sequence flipped an error envelope to "unknown"
  and the close handler treated it as success. Now both call sites run
  `sanitizeForTerminal(raw)` first.

### Allowlist additions

- `cleanGrokEnv` now passes through `GROK_AUTH_PROVIDER_LABEL`,
  `GROK_AUTH_EXPIRED`, `GROK_DISABLE_TELEMETRY`, and `GROK_WEB_SEARCH_MODEL`.
  All four are documented in `~/.grok/README.md`'s Environment Variables
  section but were previously dropped by the allowlist.

### Resilience

- **Model fallback chain expansion** (`lib/grok.mjs`) — `probeWithFallback`
  previously triggered only on `"model unavailable"`. Now also fires on
  `"quota exhausted"` (transient per-model throttling). The chain itself is
  still a singleton (`["grok-build"]`) because only one public model is
  exposed today, but the trigger semantics are correct for when more ship.

### Tests

- 15 new regression tests across `tests/state-symlink.test.mjs`,
  `tests/prompt-injection.test.mjs`, and `tests/json-ansi-strip.test.mjs`
  pinning the security guarantees against future regressions. 109 tests
  total, all passing.

## [0.2.0] - 2026-05-14

### Added

- `/grok:imagine <description>` and `/grok:imagine-video <description>` —
  surface Grok's builtin Media Generation slash commands (documented in
  `~/.grok/docs/user-guide/04-slash-commands.md`) through the plugin's
  headless flow. The companion runs `grok -p "/imagine <desc>" --output-format json`,
  parses the markdown image/video link out of the response, and prints
  the saved file path plus an `open "<path>"` line. Defaults: 5 min
  timeout for images, 15 min for video. `--json` flag returns a parseable
  `{kind, description, path, sessionId, raw}` envelope instead of the
  friendly text format. Control bytes in the description are rejected at
  the dispatcher layer for defense-in-depth.

### Tests

- 6 new tests in `tests/imagine.test.mjs` (dispatcher wiring, usage errors,
  control-byte refusal) and the dispatcher-coverage check now requires
  `imagine` and `imagine-video` in `main()`. 94 tests total, all passing.

## [0.1.0] - 2026-05-14

Initial release. Wraps the xAI Grok CLI (`grok` binary, headless `-p`)
for use from inside Claude Code, following the structure used by
`openai/codex-plugin-cc` and `taibaran/gemini-plugin-cc`.

### Added

- **Slash commands**
  - `/grok:setup` — verify Grok install, run a capability probe (checks the
    flag tokens the plugin depends on), run an auth probe, and optionally
    toggle the stop-time review gate.
  - `/grok:ask` — read-only one-shot question.
  - `/grok:review` — code review on working-tree / staged / branch diff,
    foreground or background.
  - `/grok:adversarial-review` — same target selection, skeptical framing.
  - `/grok:rescue` — delegate investigation or fix work to Grok via the
    `grok:grok-rescue` subagent.
  - `/grok:status`, `/grok:result`, `/grok:cancel`, `/grok:purge`.
- **`grok:grok-rescue` subagent** (`agents/grok-rescue.md`) — thin forwarder
  to `companion.mjs task`. Honors `--write`, `--read-only`, `--model`,
  `--effort`, `--session-id`, `--background`, `--wait`, and `--timeout`.
- **Internal skills**
  - `grok-cli-runtime` — defines the contract for invoking the companion
    runtime.
  - `grok-prompting` — guidance for shaping rescue prompts to Grok.
  - `grok-result-handling` — guidance for surfacing Grok output verbatim.
- **Hooks** (`hooks/hooks.json`): SessionStart, SessionEnd, and optional
  Stop review gate.
- **Security hardening** (mirrored from `gemini-plugin-cc`):
  - `cleanGrokEnv` allowlist drops `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`,
    `AWS_*`, `SSH_AUTH_SOCK`, `NODE_OPTIONS`, and anything else not on the
    explicit allowlist. Adds only Grok / xAI env vars documented in the
    upstream README (`GROK_CODE_XAI_API_KEY`, `GROK_CLI_CHAT_PROXY_BASE_URL`,
    `GROK_OIDC_*`, `GROK_AUTH_PROVIDER_*`, `GROK_HOME`, etc.).
  - `TerminalSanitizer` strips ANSI / OSC / DCS sequences and dangerous
    C0 bytes, stream-aware across chunk boundaries.
  - `safeJobLogPath` confines `/grok:result` reads to `jobsDir`, with
    realpath canonicalization so macOS case-insensitive paths and symlinks
    do not bypass the check.
  - `atomicWrite` with `O_EXCL` + `crypto.randomBytes` defeats predictable-
    name symlink attacks in shared tmp.
  - `withConfigLock` (file lock + stale-lock recovery) around
    `config.json` read-modify-write.
  - `terminateProcessTree` (SIGTERM → SIGKILL) with PID validation that
    rejects PID 0 and PID 1.
  - `parseVerdict` accepts only the schema-shaped JSON `{decision, reason}`
    — frees-form `ALLOW`/`BLOCK` text is rejected. Defends against
    prompt-injection via the diff or Claude transcript snippet.
- **Capability probing** — `capabilityProbe()` runs `grok --help` at setup
  time and reports any missing flag tokens. Catches breaking-change
  upgrades where Grok renames a flag without a major-version bump.
- **Session resumption** — `--session-id <id>` threads a named session into
  Grok's `-s` flag. The companion surfaces the underlying Grok `sessionId`
  in `/grok:result` so users can drop down into raw `grok -r <id>`.
- **Adversarial-review prompt** — explicit skepticism stance, prioritizes
  trust-boundary, concurrency, rollback, and data-integrity failures.
- **JSON review output** — `--json` returns structured findings against
  `schemas/review-output.schema.json`.
- **Test suite** — 79 unit tests covering args, state, git ref validation,
  PID validation, ANSI sanitizer, verdict parser, and the Grok CLI wrapper.
- **CI** — Node 20 / 22 matrix on Ubuntu + macOS, plus a smoke test for the
  dispatcher's behavior when Grok is not installed.

### Known limitations

- The Stop-time review gate sees the *current* working-tree + staged diff,
  not strictly the edits introduced by the immediately previous Claude
  turn. The prompt instructs Grok to ignore non-turn edits, but pre-
  existing dirty state can trip false positives. This matches the behavior
  of `gemini-plugin-cc` and `codex-plugin-cc`; a true turn-attribution
  scheme would require a complementary pre-turn snapshot hook.

[0.1.0]: https://github.com/taibaran/grok-plugin-cc/releases/tag/v0.1.0
