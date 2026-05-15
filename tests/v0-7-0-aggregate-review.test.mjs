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

test("parseAggVerdict recognizes VERDICT: REJECT|APPROVE|APPROVE_WITH_NITS", async () => {
  // We can't import parseAggVerdict directly (it's not exported), but we
  // can verify the regex shape by source pattern.
  const src = fs.readFileSync(COMPANION, "utf8");
  const block = src.slice(src.indexOf("function parseAggVerdict"), src.indexOf("function spawnReviewer"));
  assert.match(block, /VERDICT:\\s\*\(\[A-Z_\]\+\)/);
  assert.match(block, /BLOCKING:/);
  assert.match(block, /NITS:/);
});

test("commands/aggregate-review.md calls companion.mjs aggregate-review", () => {
  const src = fs.readFileSync(
    new URL("../plugins/grok/commands/aggregate-review.md", import.meta.url),
    "utf8"
  );
  assert.match(src, /companion\.mjs"\s+aggregate-review/);
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

test("round-2 ARG_MAX: grok uses --prompt-file (matches cmdReview hardening)", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  const grokBlock = src.slice(
    src.indexOf('name: "grok"'),
    src.indexOf("];", src.indexOf('name: "grok"'))
  );
  assert.match(grokBlock, /--prompt-file/,
    "grok reviewer must use --prompt-file, not -p <inline> (matches /grok:review hardening)");
  assert.equal(grokBlock.includes(`"-p", promptText`), false,
    "no inline -p with full promptText for grok");
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

test("round-2 plain-text path: grok output not parsed as JSON when isPlainText is true", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  // The fix: parseGrokJson is gated by !spec.isPlainText, so a grok run
  // with --output-format plain (which is what cmdAggregateReview uses)
  // never goes through the JSON parser that would otherwise swallow
  // the review as "(grok internal error)".
  const block = src.slice(src.indexOf("function spawnReviewer"), src.indexOf("async function cmdAggregateReview"));
  assert.match(block, /!spec\.isPlainText[\s\S]*?parseGrokJson/,
    "parseGrokJson on grok output must be gated by !spec.isPlainText");
});

test("round-2 timeout 0 disables timer (Codex finding)", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  const block = src.slice(src.indexOf("function spawnReviewer"), src.indexOf("async function cmdAggregateReview"));
  // Match the new pattern: only install timer when timeoutMs > 0.
  assert.match(block, /if\s*\(\s*common\.timeoutMs\s*>\s*0\s*\)\s*{\s*\n\s*timer\s*=\s*setTimeout/);
});

test("round-2 aggregate exit code: UNPARSED + timeout + nonzero exit + spawn error all fail aggregate", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  // The fix: failed.length > 0 → exit 1 instead of only checking REJECT.
  const block = src.slice(src.indexOf("const failed = results.filter"), src.indexOf("process.exit(failed.length"));
  assert.match(block, /verdict === "REJECT"/);
  assert.match(block, /verdict === "UNPARSED"/);
  assert.match(block, /verdict === "NO-OUTPUT"/);
  assert.match(block, /verdict === "SPAWN_ERROR"/);
  assert.match(block, /timedOut/);
  assert.match(block, /errored/);
  assert.match(block, /exitCode !== 0/);
});
