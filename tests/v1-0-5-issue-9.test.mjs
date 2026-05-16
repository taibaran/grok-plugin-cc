// v1.0.5 — fix for issue #9 (eyalRonen1): tighten empty-output detector
//
// Issue #9: reporter followed the bash workaround from issue #8 to
// simulate --aggregate-of-n. Step 1 (parallel grok runs) produced 8KB
// + 9KB of legitimate Hebrew research output. Step 2 (synthesis call
// with ~18KB combined prompt) returned **1 byte** (just a newline),
// exit 0, empty stderr. Silent failure — same as #1+#2 pattern but
// the plugin's v1.0.1 diagnostic missed it because `"\n"` is truthy
// in JS, so the `!r.stdout && !r.stderr` check returned false.
//
// Gemini's root-cause hypothesis (multi-agent triage): the bash
// workaround inadvertently performed prompt injection by embedding
// raw prior outputs (which contained `browser_tab failed` tool-error
// patterns) into the synthesis prompt. The upstream grok-build saw
// its own tool-call syntax mid-prompt, triggered an early stop, and
// cleanly aborted with a newline. Length wasn't the trigger (a 28KB
// English synthetic test produced 815 bytes of legitimate output).
//
// The plugin-side fix:
//   - companion.mjs isWhitespaceOnly(): new helper.
//   - All 3 diagnoseEmptySpawnFailure call sites (runHeadlessGrok,
//     cmdImagine, runJob close handler) now treat whitespace-only
//     stdout/stderr as anomalous, not just literally empty.
//   - Banner updated to also mention the synthesis-prompt failure
//     mode and point at the eventual /grok:aggregate-of-n v1.1.0
//     fix.
//
// We can't fix the upstream grok behavior from the plugin — that has
// to come from xAI (feedback submitted via grok's /feedback channel).
// But we can ensure the plugin user GETS a diagnostic instead of
// silent exit 0 with 1 byte.

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

// Fake-grok stub that emits exactly one newline (the silent-empty
// failure mode from issue #9). Exit code is configurable so we cover
// both the upstream-abort case (exit 0 — what reporter saw) and the
// normal-error case (exit 1).
function makeFakeGrokOneByteOutput(t, exitCode = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-v105-"));
  const grokScript = path.join(dir, "grok");
  fs.writeFileSync(grokScript, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--help") {
  console.log([
    "-p, --single", "-m, --model", "--output-format", "--always-approve",
    "--permission-mode", "--max-turns", "--disallowed-tools", "--prompt-file",
    "--effort", "--check", "--best-of-n"
  ].join("\\n"));
  process.exit(0);
}
if (args[0] === "--version") {
  console.log("grok 0.1.999 (fake-v105)");
  process.exit(0);
}
// The 0.1.211 silent-empty repro: exactly one newline, no stderr.
process.stdout.write("\\n");
process.exit(${exitCode});
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
      PATH: `${fakeDir}:${process.env.PATH}`,
    },
  });
}

// ============================================================================
// Behavioral: 1-byte newline now triggers the diagnostic
// ============================================================================

test("v1.0.5 (issue #9): /grok:ask with 1-byte newline stdout triggers diagnostic (exit 0)", t => {
  const fakeDir = makeFakeGrokOneByteOutput(t, 0);
  const r = runCompanion(fakeDir, ["ask", "what is 1+1"]);
  // The exit code stays whatever grok returned (0 in this case) — the
  // diagnostic is the signal. Without v1.0.5 the user would have seen
  // exit 0 + 1 byte stdout + nothing on stderr.
  assert.match(r.stderr, /grok exited 0 with empty stdout and stderr/,
    "1-byte newline must trigger the empty-output diagnostic, even at exit 0");
  assert.match(r.stderr, /Command: grok/,
    "argv must be printed so the user can re-run manually");
});

test("v1.0.5 (issue #9): /grok:ask with 1-byte newline stdout triggers diagnostic (exit 1)", t => {
  const fakeDir = makeFakeGrokOneByteOutput(t, 1);
  const r = runCompanion(fakeDir, ["ask", "what is 1+1"]);
  assert.match(r.stderr, /grok exited 1 with empty stdout and stderr/);
});

test("v1.0.5 (issue #9): /grok:imagine with 1-byte newline triggers the same diagnostic", t => {
  const fakeDir = makeFakeGrokOneByteOutput(t, 0);
  const r = runCompanion(fakeDir, ["imagine", "a red apple"]);
  assert.match(r.stderr, /imagine: grok exited 0 with empty stdout and stderr/,
    "cmdImagine path must also tighten the check");
});

test("v1.0.5 (issue #9): /grok:research (runHeadlessGrok path) gets the same fix", t => {
  const fakeDir = makeFakeGrokOneByteOutput(t, 0);
  const r = runCompanion(fakeDir, ["research", "explain quantum entanglement"]);
  assert.match(r.stderr, /research:.*grok exited.*empty stdout and stderr/,
    "runHeadlessGrok path must label the diagnostic with the subcommand name");
});

// ============================================================================
// Behavioral: banner mentions the issue-#9 failure mode
// ============================================================================

test("v1.0.5 (issue #9): diagnostic banner points at the synthesis-prompt + aggregate-of-n future fix", t => {
  const fakeDir = makeFakeGrokOneByteOutput(t, 0);
  const r = runCompanion(fakeDir, ["ask", "test"]);
  assert.match(r.stderr, /upstream silent-abort path|synthesis-style/i,
    "banner must hint at the issue-#9 upstream failure mode, not just broken-binary");
  assert.match(r.stderr, /aggregate-of-n|v1\.1\.0/,
    "banner must point at the eventual /grok:aggregate-of-n v1.1.0 fix");
});

// ============================================================================
// Source-grep guard
// ============================================================================

test("v1.0.5 (issue #9): all 3 call sites use isWhitespaceOnly instead of !r.stdout", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  assert.match(src, /function isWhitespaceOnly/,
    "isWhitespaceOnly helper must be defined");
  // The old `!r.stdout && !r.stderr` pattern should no longer guard
  // diagnoseEmptySpawnFailure (a 1-byte newline gets past it). Verify
  // each diagnoseEmptySpawnFailure call is gated by isWhitespaceOnly.
  const calls = src.match(/isWhitespaceOnly\([^)]*\)\s*&&\s*isWhitespaceOnly\([^)]*\)\s*\)\s*\{[^}]*diagnoseEmptySpawnFailure/g) || [];
  assert.ok(calls.length >= 3,
    `expected ≥3 isWhitespaceOnly-gated diagnoseEmptySpawnFailure calls, got ${calls.length}`);
});
