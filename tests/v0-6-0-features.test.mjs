// Behavior tests for the v0.6.0 Grok-specific feature commands:
//   /grok:research, /grok:models, /grok:bestof
// plus the extended grokBaseArgs builder (effort/check/bestOfN/disableWebSearch).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  grokBaseArgs,
  EFFORT_LEVELS,
  BEST_OF_N_MAX
} from "../plugins/grok/scripts/lib/grok.mjs";

// ============================================================================
// grokBaseArgs — new options
// ============================================================================

test("grokBaseArgs accepts a valid --effort and emits the flag", () => {
  const args = grokBaseArgs({ effort: "max" });
  const i = args.indexOf("--effort");
  assert.notEqual(i, -1, "--effort must be present");
  assert.equal(args[i + 1], "max");
});

test("grokBaseArgs rejects an invalid --effort value", () => {
  assert.throws(
    () => grokBaseArgs({ effort: "ultra" }),
    /invalid --effort/i
  );
});

test("grokBaseArgs omits --effort when not provided", () => {
  const args = grokBaseArgs({});
  assert.equal(args.includes("--effort"), false);
});

test("grokBaseArgs emits --check as a bool flag (no value)", () => {
  const args = grokBaseArgs({ check: true });
  const i = args.indexOf("--check");
  assert.notEqual(i, -1);
  // The next token must NOT be a value for --check — it's a bare flag.
  // Either it's the end of the array or the next thing is another flag.
  assert.ok(i === args.length - 1 || args[i + 1].startsWith("-"));
});

test("grokBaseArgs accepts a positive integer --best-of-n", () => {
  const args = grokBaseArgs({ bestOfN: 3 });
  const i = args.indexOf("--best-of-n");
  assert.notEqual(i, -1);
  assert.equal(args[i + 1], "3");
});

test("grokBaseArgs rejects --best-of-n > cap", () => {
  assert.throws(
    () => grokBaseArgs({ bestOfN: BEST_OF_N_MAX + 1 }),
    /exceeds plugin cap/i
  );
});

test("grokBaseArgs rejects non-integer --best-of-n", () => {
  assert.throws(() => grokBaseArgs({ bestOfN: "five" }), /invalid --best-of-n/i);
  assert.throws(() => grokBaseArgs({ bestOfN: 0 }), /invalid --best-of-n/i);
  assert.throws(() => grokBaseArgs({ bestOfN: 2.5 }), /invalid --best-of-n/i);
});

test("grokBaseArgs emits --disable-web-search when requested", () => {
  const args = grokBaseArgs({ disableWebSearch: true });
  assert.ok(args.includes("--disable-web-search"));
});

test("grokBaseArgs omits --disable-web-search by default", () => {
  const args = grokBaseArgs({});
  assert.equal(args.includes("--disable-web-search"), false);
});

test("EFFORT_LEVELS exports the full list", () => {
  const expected = ["low", "medium", "high", "xhigh", "max"];
  for (const e of expected) {
    assert.ok(EFFORT_LEVELS.has(e), `EFFORT_LEVELS missing ${e}`);
  }
  assert.equal(EFFORT_LEVELS.size, expected.length);
});

test("BEST_OF_N_MAX is a sensible default cap", () => {
  assert.equal(typeof BEST_OF_N_MAX, "number");
  assert.ok(BEST_OF_N_MAX >= 2 && BEST_OF_N_MAX <= 32);
});

// ============================================================================
// Command files exist + reference the right companion subcommand
// ============================================================================

test("commands/research.md calls companion.mjs research", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../plugins/grok/commands/research.md", import.meta.url), "utf8");
  assert.match(src, /companion\.mjs"\s+research/);
});

test("commands/models.md calls companion.mjs models", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../plugins/grok/commands/models.md", import.meta.url), "utf8");
  assert.match(src, /companion\.mjs"\s+models/);
});

test("commands/bestof.md calls companion.mjs bestof", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../plugins/grok/commands/bestof.md", import.meta.url), "utf8");
  assert.match(src, /companion\.mjs"\s+bestof/);
});

// ============================================================================
// Dispatcher exposes the new subcommands
// ============================================================================

test("companion.mjs main dispatcher routes research/models/bestof", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../plugins/grok/scripts/companion.mjs", import.meta.url), "utf8");
  assert.match(src, /case "research":\s*return cmdResearch/);
  assert.match(src, /case "models":\s*return cmdModels/);
  assert.match(src, /case "bestof":\s*return cmdBestOf/);
});
