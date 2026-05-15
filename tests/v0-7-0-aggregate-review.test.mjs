// Behavior tests for v0.7.0 /grok:aggregate-review.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPANION = path.resolve(__dirname, "../plugins/grok/scripts/companion.mjs");

test("dispatcher routes 'aggregate-review' to cmdAggregateReview", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  assert.match(src, /case "aggregate-review":\s*return await cmdAggregateReview/);
});

test("companion.mjs declares aggregate-review in the usage string", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  // Both usage banners (entry + dispatcher) must list the new subcommand.
  const matches = src.match(/aggregate-review/g) || [];
  assert.ok(matches.length >= 3,
    `expected ≥3 mentions of "aggregate-review" (usage banners + dispatch + impl), got ${matches.length}`);
});

test("AGG_REVIEWERS exposes codex/gemini/grok", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  const block = src.slice(src.indexOf("const AGG_REVIEWERS"), src.indexOf("function parseAggVerdict"));
  assert.match(block, /name: "codex"/);
  assert.match(block, /name: "gemini"/);
  assert.match(block, /name: "grok"/);
});

test("parseAggVerdict recognizes hyphenated/lowercase verdicts (v0.7.2)", async () => {
  // v0.7.2 (Codex P1): widened the verdict char class from `[A-Z_]+`
  // to `[A-Za-z_-]+` so `Verdict: needs-attention` from codex-plugin-cc
  // parses as `NEEDS_ATTENTION` instead of just `NEEDS` (which slipped
  // past the failure check).
  const src = fs.readFileSync(COMPANION, "utf8");
  const block = src.slice(src.indexOf("function parseAggVerdict"), src.indexOf("function spawnReviewer"));
  assert.match(block, /VERDICT:.*\[A-Za-z_-\]/,
    "verdict regex must accept hyphenated lowercase tokens (peer-plugin formats)");
  assert.match(block, /BLOCKING:/);
  assert.match(block, /NITS:/);
  // The AGG_CLEAN_VERDICTS whitelist is the new control surface.
  assert.match(src, /AGG_CLEAN_VERDICTS\s*=\s*new Set\(/);
});

test("commands/aggregate-review.md routes through grok:grok-aggregate-review subagent (v0.8.3)", () => {
  const src = fs.readFileSync(
    new URL("../plugins/grok/commands/aggregate-review.md", import.meta.url),
    "utf8"
  );
  // v0.8.3: the slash command no longer invokes Bash directly — it
  // dispatches through the Agent tool with a dedicated subagent
  // (`grok:grok-aggregate-review`), matching the `/grok:rescue`
  // pattern. The companion.mjs aggregate-review subcommand still runs
  // under the hood (the subagent uses one Bash call to invoke it).
  assert.match(src, /subagent_type:\s*"grok:grok-aggregate-review"/);
  assert.match(src, /allowed-tools:.*Agent/, "command must permit the Agent tool");
  assert.match(src, /companion\.mjs.*aggregate-review/, "documentation should still reference the underlying companion subcommand");
});

test("agents/grok-aggregate-review.md exists with correct structure", () => {
  const src = fs.readFileSync(
    new URL("../plugins/grok/agents/grok-aggregate-review.md", import.meta.url),
    "utf8"
  );
  // Subagent must have proper frontmatter — name, description, model, tools.
  assert.match(src, /name:\s*grok-aggregate-review/);
  assert.match(src, /tools:\s*Bash/);
  // Must use companion.mjs aggregate-review under the hood.
  assert.match(src, /companion\.mjs.*aggregate-review/);
});

test("companion.mjs uses cleanGrokEnv for each reviewer spawn", () => {
  // Defense-in-depth: each peer CLI gets the same scrubbed env as grok.
  // We're using a single source for the env across all three reviewers
  // to prevent secret exfiltration through codex/gemini if they're
  // compromised.
  const src = fs.readFileSync(COMPANION, "utf8");
  const block = src.slice(src.indexOf("function spawnReviewer"), src.indexOf("async function cmdAggregateReview"));
  assert.match(block, /env: cleanGrokEnv\(\)/,
    "spawnReviewer must scrub the child env via cleanGrokEnv");
});

// ============================================================================
// v0.7.0 round-2 regressions (all 3 reviewers concurred via aggregate-review
// self-dogfood)
// ============================================================================

test("round-2 ARG_MAX: gemini uses -p '' + stdin (not -p <inline>)", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  // The gemini buildCmd must pass an empty -p value AND set stdin to
  // the prompt text. Multi-MB diffs would otherwise blow ARG_MAX on
  // the inline path.
  const geminiBlock = src.slice(
    src.indexOf('name: "gemini"'),
    src.indexOf('name: "grok"')
  );
  assert.match(geminiBlock, /"-p",\s*""/);
  assert.match(geminiBlock, /stdin:\s*promptText/);
});

test("round-2 ARG_MAX: grok uses --prompt-file (CLI fallback) or peer plugin (default)", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  // Slice from grok entry to the function definition that follows
  // AGG_REVIEWERS. The intermediate `];` inside the buildCmd body
  // makes a simpler indexOf("];") cut prematurely.
  const grokStart = src.indexOf('name: "grok"');
  const grokEnd = src.indexOf("function fileURLToPathLocal", grokStart);
  const grokBlock = src.slice(grokStart, grokEnd);
  // v0.7.1: grok prefers peer-plugin routing (review --wait); only the
  // CLI fallback path uses --prompt-file directly. Either path must
  // avoid `-p <inline>` (ARG_MAX-unsafe).
  assert.match(grokBlock, /--prompt-file/,
    "grok CLI-fallback path must use --prompt-file, not -p <inline>");
  assert.equal(grokBlock.includes(`"-p", promptText`), false,
    "no inline -p with full promptText for grok");
  assert.match(grokBlock, /detection\.kind === "peer"/,
    "grok must route through peer plugin when available (v0.7.1)");
});

test("round-2 ARG_MAX: codex uses stdin with promptText (no fs.readFileSync round-trip)", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  const codexBlock = src.slice(
    src.indexOf('name: "codex"'),
    src.indexOf('name: "gemini"')
  );
  assert.match(codexBlock, /stdin:\s*promptText/,
    "codex reviewer must pass promptText directly to stdin, not via fs.readFileSync round-trip");
});

test("round-2 error handler: spawnReviewer attaches proc.on('error') AND has try/catch around spawn()", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  const block = src.slice(src.indexOf("function spawnReviewer"), src.indexOf("async function cmdAggregateReview"));
  assert.match(block, /proc\.on\("error"/,
    "spawnReviewer must attach an async error handler — uncaught error event used to crash the plugin");
  assert.match(block, /try\s*{[\s\S]*?spawn\(/,
    "spawnReviewer must wrap the synchronous spawn() in try/catch — spawn can throw E2BIG/ENOENT before the close event");
});

test("round-2 --adversarial flag: registered in COMMON_BOOL_FLAGS", () => {
  const src = fs.readFileSync(
    new URL("../plugins/grok/scripts/lib/args.mjs", import.meta.url),
    "utf8"
  );
  assert.match(src, /"adversarial"/,
    "--adversarial used to silently become positional focus text because it wasn't in the bool-flag set");
});

test("round-2 OOM cap: MAX_REVIEWER_BUF declared and used", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  assert.match(src, /MAX_REVIEWER_BUF\s*=\s*\d+\s*\*\s*1024\s*\*\s*1024/);
  // Both stdout and stderr handlers must check the cap before appending.
  assert.match(src, /stdoutBytes\s*\+\s*n\s*>\s*MAX_REVIEWER_BUF/);
  assert.match(src, /stderrBytes\s*\+\s*n\s*>\s*MAX_REVIEWER_BUF/);
});

test("round-2 + v0.7.2 plain-text path: grok output not parsed as JSON when buildResult.isPlainText is true", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  // v0.7.0 round-2 added the guard. v0.7.2 fixed the scope:
  // isPlainText lives on the buildCmd RETURN value, not on the spec,
  // so the guard must read buildResult.isPlainText (not spec.isPlainText
  // which is always undefined). When the guard is correct, a grok run
  // with --output-format plain never goes through the JSON parser
  // that would otherwise swallow the review as "(grok internal error)".
  const block = src.slice(src.indexOf("function spawnReviewer"), src.indexOf("async function cmdAggregateReview"));
  assert.match(block, /!buildResult\.isPlainText[\s\S]*?parseGrokJson/,
    "parseGrokJson on grok output must be gated by !buildResult.isPlainText");
});

test("round-2 timeout 0 disables timer (Codex finding)", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  const block = src.slice(src.indexOf("function spawnReviewer"), src.indexOf("async function cmdAggregateReview"));
  // Match the new pattern: only install timer when timeoutMs > 0.
  assert.match(block, /if\s*\(\s*common\.timeoutMs\s*>\s*0\s*\)\s*{\s*\n\s*timer\s*=\s*setTimeout/);
});

test("v0.7.2: aggregate exit code uses whitelist (AGG_CLEAN_VERDICTS) — any non-clean verdict fails", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  const block = src.slice(src.indexOf("const failed = results.filter"), src.indexOf("process.exit(failed.length"));
  // The new design: failure = NOT in clean-verdict whitelist OR
  // execution-level problem (timeout/errored/nonzero exit).
  assert.match(block, /!AGG_CLEAN_VERDICTS\.has\(r\.verdict\)/,
    "aggregate exit code must use the AGG_CLEAN_VERDICTS whitelist (covers REJECT, NEEDS_ATTENTION, UNPARSED, etc. without enumeration)");
  assert.match(block, /timedOut/);
  assert.match(block, /errored/);
  assert.match(block, /exitCode !== 0/);

  // Verify the whitelist excludes failure-shaped verdicts.
  const setBlock = src.slice(src.indexOf("AGG_CLEAN_VERDICTS = new Set"), src.indexOf("function parseAggVerdict"));
  assert.match(setBlock, /"APPROVE"/);
  assert.match(setBlock, /"APPROVE_WITH_NITS"/);
  assert.equal(setBlock.includes('"REJECT"'), false);
  assert.equal(setBlock.includes('"NEEDS_ATTENTION"'), false);
  assert.equal(setBlock.includes('"UNPARSED"'), false);
});

test("v0.7.2: parseAggVerdict normalizes 'needs-attention' to 'NEEDS_ATTENTION'", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  // The normalization step: hyphens → underscores, lowercase → uppercase.
  const block = src.slice(src.indexOf("function parseAggVerdict"), src.indexOf("function spawnReviewer"));
  assert.match(block, /toUpperCase\(\)\.replace\(\/-\/g,\s*"_"\)/,
    "verdict normalization must replace hyphens with underscores AND uppercase");
});

test("v0.7.2: detect() requires both peer plugin AND underlying CLI (Codex P2)", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  // Each reviewer's detect() must check `which(name)` alongside peer.
  for (const name of ["codex", "gemini", "grok"]) {
    const start = src.indexOf(`name: "${name}"`);
    const next = src.indexOf("name:", start + 10);
    const block = src.slice(start, next < 0 ? start + 2000 : next);
    assert.match(block, /peer\s*&&\s*cli/,
      `${name} reviewer must require both peer plugin AND CLI presence`);
  }
});

test("v0.7.2: peer reviewers auto-switch to adversarial-review when focus is set (Codex P2)", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  const aggBlock = src.slice(
    src.indexOf("const AGG_REVIEWERS"),
    src.indexOf("function fileURLToPathLocal")
  );
  // All 3 reviewers must auto-switch sub when focus is non-empty.
  const adversarialAutoSwitches = (aggBlock.match(/\(adversarial\s*\|\|\s*focus\)\s*\?\s*"adversarial-review"/g) || []).length;
  assert.equal(adversarialAutoSwitches, 3,
    "all 3 reviewers must auto-switch to adversarial-review when focus is provided");
  // And focus must be appended as positional arg when applicable.
  const focusPushCount = (aggBlock.match(/args\.push\(focus\)/g) || []).length;
  assert.equal(focusPushCount, 3, "all 3 reviewers must push focus as positional");
});

test("v0.7.2: spawnReviewer uses buildResult.isPlainText (not spec.isPlainText)", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  const block = src.slice(src.indexOf("function spawnReviewer"), src.indexOf("async function cmdAggregateReview"));
  // The fix: the guard reads buildResult.isPlainText. spec.isPlainText
  // is always undefined (the property lives on the buildCmd return).
  assert.match(block, /!buildResult\.isPlainText\s*&&\s*spec\.name === "grok"/,
    "spawnReviewer must read isPlainText from buildResult, not spec — spec has no such property");
  assert.equal(block.includes("!spec.isPlainText"), false,
    "the stale `!spec.isPlainText` check must be removed");
});

// ============================================================================
// v0.7.1: peer plugin discovery and routing
// ============================================================================

test("v0.7.1: findPeerCompanion walks ~/.claude/plugins/cache/<plugin>/<version>/scripts/", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  // Source-level guarantee: lookup path includes the well-known
  // structure with versioned subdirs.
  assert.match(src, /CC_PLUGIN_CACHE\s*=\s*path\.join\(os\.homedir\(\),\s*"\.claude\/plugins\/cache"\)/);
  assert.match(src, /function findPeerCompanion/);
  assert.match(src, /compareVersions\(b,\s*a\)/,
    "findPeerCompanion must sort versions semver-descending to pick the newest");
});

test("v0.7.1: PEER_PLUGIN_LOOKUP covers codex, gemini, grok", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  const block = src.slice(src.indexOf("PEER_PLUGIN_LOOKUP"), src.indexOf("// Find a peer plugin's companion"));
  assert.match(block, /codex:.*openai-codex/);
  assert.match(block, /gemini:.*gemini-plugin-cc/);
  assert.match(block, /grok:.*grok-plugin-cc/);
});

test("v0.7.1: each reviewer's detect() returns {kind:'peer'|'cli', path}", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  // All three reviewers must implement the peer-first / cli-fallback pattern.
  for (const name of ["codex", "gemini", "grok"]) {
    const start = src.indexOf(`name: "${name}"`);
    const next = src.indexOf("name:", start + 10);
    const block = src.slice(start, next < 0 ? start + 2000 : next);
    assert.match(block, /findPeerCompanion\("[a-z]+"\)/,
      `${name} reviewer must consult findPeerCompanion first`);
    assert.match(block, /kind:\s*"peer"/,
      `${name} reviewer must signal peer-plugin routing via {kind:"peer"}`);
  }
});

test("v0.7.1: peer plugins receive review --wait + --base + --scope (sync contract)", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  // Slice from AGG_REVIEWERS to the next function definition (which
  // marks the array's closing — using indexOf("];") gets confused by
  // inner `args = [...];` statements inside buildCmd bodies).
  const block = src.slice(
    src.indexOf("const AGG_REVIEWERS"),
    src.indexOf("function fileURLToPathLocal")
  );
  const reviewCallCount = (block.match(/sub,\s*"--wait"/g) || []).length;
  assert.equal(reviewCallCount, 3,
    "all 3 reviewers must use peer plugin's `<sub> --wait` (review or adversarial-review)");
});

test("v0.7.1: aggregate-review reports the routing path (peer vs cli) in output", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  // Reviewers line should annotate via= for each.
  assert.match(src, /Reviewers:\s*\$\{available\.map\(r\s*=>\s*`\$\{r\.spec\.name\}\s*\(via\s*\$\{r\.detection\.kind\}\)`\)/,
    "header line must annotate (via peer) or (via cli) per reviewer");
  assert.match(src, /Via:\s*\$\{r\.via\s*\|\|\s*"\?"\}/,
    "per-reviewer detail line must show the routing path used");
});
