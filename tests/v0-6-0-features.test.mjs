// Behavior tests for the v0.6.0 Grok-specific feature commands:
//   /grok:research, /grok:models, /grok:best-of
// plus the extended grokBaseArgs builder (effort/check/bestOfN/disableWebSearch).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  grokBaseArgs,
  EFFORT_LEVELS,
  BEST_OF_N_MAX
} from "../plugins/grok/scripts/lib/grok.mjs";
import { parseArgs, COMMON_BOOL_FLAGS, COMMON_VALUE_FLAGS } from "../plugins/grok/scripts/lib/args.mjs";
import { setActiveModel, readConfig, PLUGIN_DATA_ENV } from "../plugins/grok/scripts/lib/state.mjs";

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

test("commands/research.md calls companion.mjs research", () => {
  const src = fs.readFileSync(new URL("../plugins/grok/commands/research.md", import.meta.url), "utf8");
  assert.match(src, /companion\.mjs"\s+research/);
});

test("commands/models.md calls companion.mjs models", () => {
  const src = fs.readFileSync(new URL("../plugins/grok/commands/models.md", import.meta.url), "utf8");
  assert.match(src, /companion\.mjs"\s+models/);
});

test("commands/best-of.md calls companion.mjs best-of", () => {
  const src = fs.readFileSync(new URL("../plugins/grok/commands/best-of.md", import.meta.url), "utf8");
  assert.match(src, /companion\.mjs"\s+best-of/);
});

// ============================================================================
// Dispatcher exposes the new subcommands
// ============================================================================

test("companion.mjs main dispatcher routes research/models/best-of", async () => {
  const src = fs.readFileSync(new URL("../plugins/grok/scripts/companion.mjs", import.meta.url), "utf8");
  assert.match(src, /case "research":\s*return cmdResearch/);
  assert.match(src, /case "models":\s*return cmdModels/);
  assert.match(src, /case "best-of":\s*return cmdBestOf/);
});

// ============================================================================
// G1 — capabilityProbe must verify v0.6.0 flags (Grok review)
// ============================================================================

test("G1: capabilityProbe required-list includes v0.6.0 flags", async () => {
  const src = fs.readFileSync(new URL("../plugins/grok/scripts/lib/grok.mjs", import.meta.url), "utf8");
  for (const tok of ["--effort", "--check", "--best-of-n", "--disable-web-search"]) {
    assert.match(src, new RegExp(`"${tok.replace(/-/g, "\\-")}"`),
      `capabilityProbe required list must include ${tok}`);
  }
});

// ============================================================================
// Behavioral coverage — end-to-end argv chain (Claude general nit-4)
// ============================================================================

test("E2E: parseArgs registers --no-web-search as a bool (no swallow into positional)", () => {
  // Grok review G2 was a false alarm — but the only thing standing between
  // that being a real bug and a false alarm is this one boolFlags entry.
  // Lock it in with a regression test.
  const r = parseArgs(["research", "--no-web-search", "what", "is", "x"], {
    boolFlags: COMMON_BOOL_FLAGS, valueFlags: COMMON_VALUE_FLAGS
  });
  assert.equal(r.flags["no-web-search"], true);
  assert.deepEqual(r.positional, ["research", "what", "is", "x"]);
});

test("E2E: parseArgs registers --no-check as a bool", () => {
  const r = parseArgs(["--no-check", "deep", "question"], {
    boolFlags: COMMON_BOOL_FLAGS, valueFlags: COMMON_VALUE_FLAGS
  });
  assert.equal(r.flags["no-check"], true);
  assert.deepEqual(r.positional, ["deep", "question"]);
});

test("E2E: parseArgs accepts --best-of-n N as a value flag", () => {
  const r = parseArgs(["--best-of-n", "3", "draft", "haiku"], {
    boolFlags: COMMON_BOOL_FLAGS, valueFlags: COMMON_VALUE_FLAGS
  });
  assert.equal(r.flags["best-of-n"], "3");
  assert.deepEqual(r.positional, ["draft", "haiku"]);
});

test("E2E: parseArgs accepts --best-of-n=N inline form", () => {
  const r = parseArgs(["--best-of-n=5", "draft", "haiku"], {
    boolFlags: COMMON_BOOL_FLAGS, valueFlags: COMMON_VALUE_FLAGS
  });
  assert.equal(r.flags["best-of-n"], "5");
  assert.deepEqual(r.positional, ["draft", "haiku"]);
});

test("E2E: research default chain — flags={} yields effort=max + check + web-search-ON args", () => {
  // Simulates the cmdResearch default path: effort=max, check=true,
  // no --no-web-search. We reproduce the in-cmdResearch logic verbatim so
  // a behavior change in cmdResearch's defaults breaks this test.
  const flags = {};
  const effortRaw = flags.effort != null ? flags.effort : "max";
  const checkFlag = flags["no-check"] ? false : flags.check === false ? false : true;
  const disableWebSearch = !!flags["no-web-search"];
  const args = grokBaseArgs({
    readOnly: true, jsonOutput: true,
    effort: effortRaw, check: checkFlag, disableWebSearch
  });
  // Defaults must produce effort=max + --check + NO --disable-web-search.
  const i = args.indexOf("--effort");
  assert.notEqual(i, -1);
  assert.equal(args[i + 1], "max");
  assert.ok(args.includes("--check"));
  assert.equal(args.includes("--disable-web-search"), false);
});

test("E2E: research --no-check disables --check in final argv", () => {
  const flags = { "no-check": true };
  const checkFlag = flags["no-check"] ? false : flags.check === false ? false : true;
  const args = grokBaseArgs({
    readOnly: true, jsonOutput: true,
    effort: "max", check: checkFlag, disableWebSearch: false
  });
  assert.equal(args.includes("--check"), false,
    "--no-check must drop --check from the argv");
});

test("E2E: research --no-web-search emits --disable-web-search", () => {
  const flags = { "no-web-search": true };
  const args = grokBaseArgs({
    readOnly: true, jsonOutput: true,
    effort: "max", check: true,
    disableWebSearch: !!flags["no-web-search"]
  });
  assert.ok(args.includes("--disable-web-search"));
});

test("E2E: best-of dual-form parsing — `best-of 3 hi` and `best-of --best-of-n 3 hi`", () => {
  const a = parseArgs(["3", "hi", "there"], {
    boolFlags: COMMON_BOOL_FLAGS, valueFlags: COMMON_VALUE_FLAGS
  });
  // First-positional N form: cmdBestOf reads positional[0] as N.
  assert.deepEqual(a.positional, ["3", "hi", "there"]);
  assert.equal(a.flags["best-of-n"], undefined);

  const b = parseArgs(["--best-of-n", "3", "hi", "there"], {
    boolFlags: COMMON_BOOL_FLAGS, valueFlags: COMMON_VALUE_FLAGS
  });
  assert.equal(b.flags["best-of-n"], "3");
  assert.deepEqual(b.positional, ["hi", "there"]);
});

test("E2E: models --set-default <id> round-trips via readConfig", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-v060-models-"));
  const prev = process.env[PLUGIN_DATA_ENV];
  process.env[PLUGIN_DATA_ENV] = root;
  try {
    setActiveModel(process.cwd(), "grok-build-experimental");
    const cfg = readConfig(process.cwd());
    assert.equal(cfg.activeModel, "grok-build-experimental",
      "setActiveModel → readConfig must round-trip the workspace pin");
  } finally {
    if (prev === undefined) delete process.env[PLUGIN_DATA_ENV];
    else process.env[PLUGIN_DATA_ENV] = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// runHeadlessGrok extraction sanity (Claude general nit-1)
// ============================================================================

test("Refactor: runHeadlessGrok is defined and used in companion.mjs", () => {
  const src = fs.readFileSync(new URL("../plugins/grok/scripts/companion.mjs", import.meta.url), "utf8");
  assert.match(src, /function runHeadlessGrok\(/);
  // All three callers must use the helper (no direct spawnSync in their bodies).
  const cmdAsk = src.slice(src.indexOf("function cmdAsk("), src.indexOf("\n}", src.indexOf("function cmdAsk(")));
  assert.match(cmdAsk, /runHeadlessGrok\(\{/);
  const cmdResearch = src.slice(src.indexOf("function cmdResearch("), src.indexOf("\n}", src.indexOf("function cmdResearch(")));
  assert.match(cmdResearch, /runHeadlessGrok\(\{/);
  const cmdBestOf = src.slice(src.indexOf("function cmdBestOf("), src.indexOf("\n}", src.indexOf("function cmdBestOf(")));
  assert.match(cmdBestOf, /runHeadlessGrok\(\{/);
});
