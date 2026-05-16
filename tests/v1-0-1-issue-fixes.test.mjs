// v1.0.1 — fixes for issues #1 + #2 (eyalRonen1)
//
// #1: grok 0.1.211 auto-update returned exit 0 with empty stdout/stderr
//     for every command. The plugin had no diagnostic — the user saw an
//     opaque "nothing happened" or exit 1.
//
// #2: When the subprocess returned no parseable result AND no stderr,
//     the plugin gave no signal about what failed. Argv was not echoed,
//     exit code was not printed.
//
// The fixes:
//   - lib/grok.mjs grokVersion() preserves the "exited 0 with empty
//     output" case (returns "") so cmdSetup can surface a specific
//     broken-auto-update recovery hint instead of the generic "could
//     not parse version" warning.
//   - companion.mjs adds diagnoseEmptySpawnFailure() — a shared helper
//     called from runHeadlessGrok, cmdImagine, and runJob whenever the
//     spawned grok child exits with both stdout AND stderr empty. It
//     prints the exit code, the shell-quoted argv, and 3 recovery
//     steps (setup probe / grok update / roll back via ~/.grok/downloads/).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const COMPANION = path.resolve(__dirname, "../plugins/grok/scripts/companion.mjs");

// Fake-grok stub that exercises the broken-binary failure modes from #1+#2:
//   mode=empty-exit-0  : exits 0 with empty stdout and stderr (the exact
//                        0.1.211 auto-update reproduction).
//   mode=empty-exit-1  : exits 1 with empty stdout and stderr (the silent
//                        failure case from #2 where parseGrokJson is unhappy
//                        and the user gets nothing actionable).
function makeFakeGrokDir(t, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-v101-"));
  const grokScript = path.join(dir, "grok");
  fs.writeFileSync(grokScript, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const here = path.dirname(process.argv[1]);
fs.writeFileSync(path.join(here, "args.json"), JSON.stringify(args, null, 2));
const mode = ${JSON.stringify(mode)};
if (args[0] === "--help") {
  // capabilityProbe needs these flag tokens to pass.
  console.log([
    "-p, --single", "-m, --model", "--output-format", "--always-approve",
    "--permission-mode", "--max-turns", "--disallowed-tools", "--prompt-file",
    "--effort", "--check", "--best-of-n"
  ].join("\\n"));
  process.exit(0);
}
if (args[0] === "--version" && mode === "version-broken") {
  // The 0.1.211 reproduction — exit 0 with NO output.
  process.exit(0);
}
if (mode === "empty-exit-0") { process.exit(0); }
if (mode === "empty-exit-1") { process.exit(1); }
console.error("fake-grok-v101: unexpected mode " + mode);
process.exit(99);
`, { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(grokScript, 0o755);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runCompanion(fakeDir, args, extraEnv = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...extraEnv,
      PATH: `${fakeDir}:${process.env.PATH}`
    }
  });
}

// ----------------------------------------------------------------------------
// Issue #2: empty-output diagnostic
// ----------------------------------------------------------------------------

test("v1.0.1 (issue #2): cmdImagine prints diagnostic when grok exits with empty stdout+stderr", t => {
  const fakeDir = makeFakeGrokDir(t, "empty-exit-1");
  const r = runCompanion(fakeDir, ["imagine", "a red apple"]);
  assert.match(r.stderr, /grok exited 1 with empty stdout and stderr/,
    "must surface the empty-output anomaly explicitly");
  assert.match(r.stderr, /Command: grok/,
    "must print the argv the user can paste back into a shell");
  assert.match(r.stderr, /-p ["']?\/imagine a red apple["']?/,
    "argv print must include the actual slash-command + description");
  assert.match(r.stderr, /possible bad auto-update/,
    "diagnostic must mention the auto-update failure mode from issue #1");
  assert.match(r.stderr, /\/grok:setup/,
    "diagnostic must recommend running setup as recovery step 1");
  assert.match(r.stderr, /grok update/,
    "diagnostic must recommend `grok update` as recovery step 2");
  assert.match(r.stderr, /~\/\.grok\/downloads\//,
    "diagnostic must mention the manual rollback path");
});

test("v1.0.1 (issue #2): cmdImagine diagnostic also fires on exit 0 with empty output", t => {
  // The exact 0.1.211 reproduction: exit 0, nothing on stdout/stderr.
  // Without the fix the user sees nothing (exit 0 looks like success).
  const fakeDir = makeFakeGrokDir(t, "empty-exit-0");
  const r = runCompanion(fakeDir, ["imagine", "a red apple"]);
  assert.match(r.stderr, /grok exited 0 with empty stdout and stderr/,
    "exit 0 with empty output must STILL trigger the diagnostic — it is anomalous");
});

test("v1.0.1 (issue #2): runHeadlessGrok (ask) prints diagnostic on empty output", t => {
  const fakeDir = makeFakeGrokDir(t, "empty-exit-1");
  const r = runCompanion(fakeDir, ["ask", "what is 2+2"]);
  assert.match(r.stderr, /grok exited 1 with empty stdout and stderr/,
    "ask path (runHeadlessGrok) must produce the same diagnostic");
  assert.match(r.stderr, /Command: grok/);
});

test("v1.0.1 (issue #2): runHeadlessGrok label correctly names the failing command", t => {
  const fakeDir = makeFakeGrokDir(t, "empty-exit-1");
  // research uses runHeadlessGrok with label "research".
  const r = runCompanion(fakeDir, ["research", "explain quantum entanglement"]);
  assert.match(r.stderr, /research:.*grok exited/,
    "the diagnostic must include the subcommand label so the user knows which command failed");
});

// ----------------------------------------------------------------------------
// Issue #1: setup detects broken auto-update
// ----------------------------------------------------------------------------

test("v1.0.1 (issue #1): cmdSetup detects empty `grok --version` and prints recovery hint", t => {
  const fakeDir = makeFakeGrokDir(t, "version-broken");
  const r = runCompanion(fakeDir, ["setup"]);
  // Setup must NOT report this as a generic "could not parse version" — it
  // must specifically call out the broken-auto-update recovery path.
  assert.match(r.stdout, /returns empty output|broken auto-update/i,
    "setup must surface the broken-binary case explicitly, not as a parse warning");
  assert.match(r.stdout, /~\/\.grok\/downloads\//,
    "setup must mention rolling back via ~/.grok/downloads/");
  assert.match(r.stdout, /grok update/,
    "setup must mention `grok update` as a recovery option");
});

test("v1.0.1 (issue #1): cmdSetup --json marks the broken-binary case structured-ly", t => {
  const fakeDir = makeFakeGrokDir(t, "version-broken");
  const r = runCompanion(fakeDir, ["setup", "--json"]);
  // The JSON output is what other tools / hooks can parse — they need a
  // dedicated flag, not just a free-text nextSteps entry.
  const obj = JSON.parse(r.stdout);
  assert.equal(obj.grok.broken, true,
    "setup JSON must set grok.broken=true when --version returns empty output");
  assert.equal(obj.grok.version_ok, false,
    "setup JSON must set version_ok=false when --version returns empty output");
  assert.match(obj.grok.detail, /empty output/i,
    "setup JSON detail string must mention empty output so parsers can route on it");
});

// ----------------------------------------------------------------------------
// Source-grep guards (cheap regression markers)
// ----------------------------------------------------------------------------

test("v1.0.1: diagnoseEmptySpawnFailure helper is defined and used in all 3 call sites", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  assert.match(src, /function diagnoseEmptySpawnFailure/,
    "the shared helper must exist in companion.mjs");
  // 3 call sites: runHeadlessGrok, cmdImagine, runJob.
  const callCount = (src.match(/diagnoseEmptySpawnFailure\(/g) || []).length;
  assert.ok(callCount >= 4,
    `expected ≥4 occurrences of diagnoseEmptySpawnFailure (1 def + 3 calls), got ${callCount}`);
});

test("v1.0.1: grokVersion preserves the empty-output case (does not collapse to null)", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../plugins/grok/scripts/lib/grok.mjs"),
    "utf8"
  );
  // The function must explicitly call out the three-state contract so future
  // refactors don't collapse "exited 0 with empty output" back into null.
  assert.match(src, /distinguishes three states/i,
    "grokVersion's contract (three states) must be documented inline");
  assert.match(src, /broken[- ]binary auto-update/i,
    "grokVersion must mention the broken-binary auto-update failure mode in a comment");
});
