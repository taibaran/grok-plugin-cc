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
