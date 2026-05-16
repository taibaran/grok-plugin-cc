// v1.0.3 — fixes for issues #7 + #8 (eyalRonen1)
//
// #7: --effort triggers cryptic 400 cascade on grok-build (which declares
//     supports_reasoning_effort=false in ~/.grok/models_cache.json).
//     Affects every /grok:research call on the default model since
//     research defaults to --effort max.
//
// #8: --best-of-n is implicitly code-task-only. For text/research prompts,
//     the diff evaluator has nothing to score; user gets an evaluation
//     table (often over empty diffs, so ~empty stdout).
//
// The fixes:
//   - lib/grok.mjs modelSupportsReasoningEffort(): reads
//     ~/.grok/models_cache.json, returns true/false/null. grokBaseArgs
//     strips --effort and --reasoning-effort with a stderr warning when
//     the model declares supports_reasoning_effort=false. Cache-miss is
//     conservative (forward the flag).
//   - companion.mjs cmdBestOf(): writes a stderr banner explaining that
//     --best-of-n is for code tasks, before invoking grok. Suppressed
//     when --json is given (parseable pipelines).
//   - commands/best-of.md: rewritten to be explicit about code-task-only
//     scope and to direct text/research users to /grok:research or
//     /grok:ask.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  modelSupportsReasoningEffort,
  grokBaseArgs,
} from "../plugins/grok/scripts/lib/grok.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const COMPANION = path.resolve(__dirname, "../plugins/grok/scripts/companion.mjs");

// ============================================================================
// #7 — modelSupportsReasoningEffort cache reader
// ============================================================================

test("v1.0.3 (issue #7): modelSupportsReasoningEffort returns false for grok-build per cache", () => {
  const cache = {
    models: {
      "grok-build": { info: { supports_reasoning_effort: false } },
      "future-reasoner": { info: { supports_reasoning_effort: true } },
    },
  };
  assert.equal(modelSupportsReasoningEffort("grok-build", cache), false);
  assert.equal(modelSupportsReasoningEffort("future-reasoner", cache), true);
});

test("v1.0.3 (issue #7): modelSupportsReasoningEffort returns null on edge cases", () => {
  // Cache is null (file missing or unreadable).
  assert.equal(modelSupportsReasoningEffort("grok-build", null), null);
  // Model not in cache.
  assert.equal(modelSupportsReasoningEffort("unknown-model", { models: {} }), null);
  // Entry has no .info.
  assert.equal(modelSupportsReasoningEffort("weird", { models: { weird: {} } }), null);
  // Field is missing (older cache versions, partial fetches).
  assert.equal(modelSupportsReasoningEffort("partial", { models: { partial: { info: {} } } }), null);
  // Empty / invalid model id.
  assert.equal(modelSupportsReasoningEffort("", { models: {} }), null);
  assert.equal(modelSupportsReasoningEffort(null, { models: {} }), null);
  assert.equal(modelSupportsReasoningEffort(undefined, { models: {} }), null);
});

// ============================================================================
// #7 — grokBaseArgs strips --effort when model declares no support
// ============================================================================

function captureStderr(fn) {
  const origWrite = process.stderr.write.bind(process.stderr);
  const buf = [];
  process.stderr.write = (chunk) => {
    buf.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = origWrite;
  }
  return buf.join("");
}

test("v1.0.3 (issue #7): grokBaseArgs strips --effort + warns when cache says unsupported", t => {
  // Pre-write a models_cache.json into a fake HOME so grokBaseArgs picks it up.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
  fs.mkdirSync(path.join(fakeHome, ".grok"), { recursive: true });
  fs.writeFileSync(
    path.join(fakeHome, ".grok", "models_cache.json"),
    JSON.stringify({
      models: {
        "grok-build": { info: { supports_reasoning_effort: false } },
      },
    }),
  );
  const origHome = process.env.HOME;
  process.env.HOME = fakeHome;
  t.after(() => {
    process.env.HOME = origHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  let args;
  const stderr = captureStderr(() => {
    args = grokBaseArgs({
      readOnly: true,
      model: "grok-build",
      jsonOutput: true,
      effort: "max",
    });
  });

  assert.ok(!args.includes("--effort"),
    `--effort must be stripped when model declares supports_reasoning_effort=false; got args: ${JSON.stringify(args)}`);
  assert.match(stderr, /grok-build.*supports_reasoning_effort=false/i,
    "stderr must explain why --effort was stripped");
  assert.match(stderr, /stripping --effort=max/i,
    "stderr must echo the stripped value");
  assert.match(stderr, /grok models/i,
    "stderr must hint at refreshing the cache");
});

test("v1.0.3 (issue #7): grokBaseArgs FORWARDS --effort when cache says supported", t => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
  fs.mkdirSync(path.join(fakeHome, ".grok"), { recursive: true });
  fs.writeFileSync(
    path.join(fakeHome, ".grok", "models_cache.json"),
    JSON.stringify({
      models: {
        "future-reasoner": { info: { supports_reasoning_effort: true } },
      },
    }),
  );
  const origHome = process.env.HOME;
  process.env.HOME = fakeHome;
  t.after(() => {
    process.env.HOME = origHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  const args = grokBaseArgs({
    readOnly: true,
    model: "future-reasoner",
    jsonOutput: true,
    effort: "high",
  });

  const i = args.indexOf("--effort");
  assert.notEqual(i, -1, "--effort must be forwarded when cache says supported");
  assert.equal(args[i + 1], "high", "the actual effort value must follow the flag");
});

test("v1.0.3 (issue #7): grokBaseArgs FORWARDS --effort when cache is missing (conservative)", t => {
  // Cache file doesn't exist → modelSupportsReasoningEffort returns null →
  // we forward the flag and let upstream decide. Conservative: never silently
  // strip on missing data.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-empty-"));
  // Deliberately do NOT create .grok/models_cache.json
  const origHome = process.env.HOME;
  process.env.HOME = fakeHome;
  t.after(() => {
    process.env.HOME = origHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  const args = grokBaseArgs({
    readOnly: true,
    model: "grok-build",
    jsonOutput: true,
    effort: "low",
  });

  const i = args.indexOf("--effort");
  assert.notEqual(i, -1, "--effort must be forwarded when cache is missing");
  assert.equal(args[i + 1], "low");
});

test("v1.0.3 (issue #7): grokBaseArgs strips --reasoning-effort too (same gate)", t => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
  fs.mkdirSync(path.join(fakeHome, ".grok"), { recursive: true });
  fs.writeFileSync(
    path.join(fakeHome, ".grok", "models_cache.json"),
    JSON.stringify({
      models: { "grok-build": { info: { supports_reasoning_effort: false } } },
    }),
  );
  const origHome = process.env.HOME;
  process.env.HOME = fakeHome;
  t.after(() => {
    process.env.HOME = origHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  let args;
  const stderr = captureStderr(() => {
    args = grokBaseArgs({
      readOnly: true,
      model: "grok-build",
      jsonOutput: true,
      reasoningEffort: "high",
    });
  });

  assert.ok(!args.includes("--reasoning-effort"),
    "--reasoning-effort must be stripped on the same condition as --effort");
  assert.match(stderr, /reasoning-effort/i, "stderr must explain the strip");
});

// ============================================================================
// #8 — cmdBestOf prints a code-task-only banner
// ============================================================================

function makeFakeGrokDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-fake-v103-"));
  const grokScript = path.join(dir, "grok");
  fs.writeFileSync(grokScript, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const here = path.dirname(process.argv[1]);
fs.writeFileSync(path.join(here, "args.json"), JSON.stringify(args, null, 2));
if (args[0] === "--help") {
  console.log([
    "-p, --single", "-m, --model", "--output-format", "--always-approve",
    "--permission-mode", "--max-turns", "--disallowed-tools", "--prompt-file",
    "--effort", "--check", "--best-of-n"
  ].join("\\n"));
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  text: "OK",
  stopReason: "EndTurn",
  sessionId: "fake-v103",
}) + "\\n");
process.exit(0);
`, { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(grokScript, 0o755);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runCompanion(fakeDir, args) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeDir}:${process.env.PATH}`,
    },
  });
}

test("v1.0.3 (issue #8): cmdBestOf prints a code-task-only banner to stderr", t => {
  const fakeDir = makeFakeGrokDir(t);
  const r = runCompanion(fakeDir, ["best-of", "2", "refactor src/foo.ts"]);
  assert.match(r.stderr, /best-of-n/i,
    "stderr banner must mention --best-of-n");
  assert.match(r.stderr, /CODE.*FILE-CHANGE/i,
    "stderr banner must say it is for code/file-change tasks");
  assert.match(r.stderr, /\/grok:research|\/grok:ask/,
    "stderr banner must point text/research users to /grok:research or /grok:ask");
  assert.match(r.stderr, /GROK_PLUGIN_QUIET_BANNERS/,
    "stderr banner must mention the env-var off-switch (power-user opt-out)");
});

test("v1.0.3 (issue #8): cmdBestOf SUPPRESSES the banner when --json is given", t => {
  const fakeDir = makeFakeGrokDir(t);
  const r = runCompanion(fakeDir, ["best-of", "--best-of-n", "2", "--json", "refactor src/foo.ts"]);
  assert.equal(r.stderr.includes("best-of-n"), false,
    "the banner must be suppressed in --json mode so it doesn't break parseable pipelines");
});

test("v1.0.3 (issue #8): GROK_PLUGIN_QUIET_BANNERS=1 suppresses the banner (power-user opt-out)", t => {
  const fakeDir = makeFakeGrokDir(t);
  const r = spawnSync(process.execPath, [COMPANION, "best-of", "2", "refactor src/foo.ts"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeDir}:${process.env.PATH}`,
      GROK_PLUGIN_QUIET_BANNERS: "1",
    },
  });
  assert.equal(r.stderr.includes("best-of-n"), false,
    "GROK_PLUGIN_QUIET_BANNERS=1 must suppress the banner — grokking power users have already read it");
});

// ============================================================================
// Source-grep guards
// ============================================================================

test("v1.0.3: modelSupportsReasoningEffort is exported and used in grokBaseArgs", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../plugins/grok/scripts/lib/grok.mjs"),
    "utf8",
  );
  assert.match(src, /export function modelSupportsReasoningEffort/,
    "modelSupportsReasoningEffort must be exported (for testing + external use)");
  // Count usages: definition + 2 call sites (--effort and --reasoning-effort gates).
  const calls = (src.match(/modelSupportsReasoningEffort\(/g) || []).length;
  assert.ok(calls >= 3,
    `expected ≥3 occurrences (1 def + 2 calls), got ${calls}`);
});

test("v1.0.3: best-of.md documents code-task-only constraint prominently", () => {
  const doc = fs.readFileSync(
    path.resolve(__dirname, "../plugins/grok/commands/best-of.md"),
    "utf8",
  );
  assert.match(doc, /[Cc]ode.*[Ff]ile-change/,
    "best-of.md must say it is for code/file-change tasks");
  assert.match(doc, /\/grok:research/,
    "best-of.md must direct research users to /grok:research");
  assert.match(doc, /\/grok:ask/,
    "best-of.md must direct text users to /grok:ask");
  assert.match(doc, /issue #8/i,
    "best-of.md must reference the source issue for traceability");
});
