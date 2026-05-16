// v1.0.6 — fix for issue #10 (eyalRonen1): runJob silent on exit-0 with empty
// output + cross-plugin state-dir namespace collision
//
// Issue #10: `companion.mjs task` reported "completed (exit 0)" but the
// stdout/stderr log files were 0 bytes. cmdResult showed "(empty)".
// Direct `grok -p` with the same prompt worked. The reporter's
// grok-rescue agent hung waiting for output that never appeared.
//
// Two root causes (per codex + gemini parallel triage):
//
// 1) runJob's `diagnoseEmptySpawnFailure` was nested inside
//    `(code !== 0 || grokInternalError)`. On exit-0 with empty output
//    AND no parseable JSON error envelope, the diagnostic was silently
//    skipped — the user got "completed" with no signal that anything
//    was wrong.
//
// 2) When grok-plugin-cc is invoked from a parent subagent of a
//    DIFFERENT plugin (e.g. codex-rescue → grok-rescue), the harness's
//    CLAUDE_PLUGIN_DATA env var points at the parent plugin's data dir.
//    Our state.mjs treated that as the base, so we wrote our job
//    metadata + logs into `~/.claude/plugins/data/codex-openai-codex/
//    state/...`. Reporter saw their grok job files under codex's data
//    dir — confusing and breaks future audits.
//
// I also ran an A/B test (plan vs default permission-mode) on a
// web-search-using prompt — BOTH modes produced output. So Codex's
// secondary hypothesis (plan mode suppresses web_search in headless)
// was NOT validated; the cmdTask default stays unchanged.
//
// The fixes:
//   - companion.mjs runJob: set `meta.no_output = true` when both
//     buffers are whitespace-only, regardless of exit code.
//   - companion.mjs runJob close handler: new `else if (meta.no_output
//     && status !== "cancelled")` branch fires diagnoseEmptySpawnFailure
//     for the exit-0 case.
//   - companion.mjs cmdResult: when `meta.no_output` is true, append
//     a stderr warning explaining the anomaly + recovery options
//     (--write for tool-using tasks, /grok:setup, etc.) so users who
//     discover the empty output via /grok:result later get the same
//     guidance.
//   - lib/state.mjs stateDir: prefix the env-backed path with
//     `grok-plugin-cc/` to namespace-isolate from cross-plugin parents.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  stateDir,
  jobsDir,
  PLUGIN_DATA_ENV,
} from "../plugins/grok/scripts/lib/state.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const COMPANION = path.resolve(__dirname, "../plugins/grok/scripts/companion.mjs");

// ============================================================================
// Issue #10 root cause #2: namespace isolation
// ============================================================================

test("v1.0.6 (issue #10): stateDir under $CLAUDE_PLUGIN_DATA is namespaced to grok-plugin-cc/", t => {
  const fakeData = fs.mkdtempSync(path.join(os.tmpdir(), "grok-v106-data-"));
  const origEnv = process.env[PLUGIN_DATA_ENV];
  process.env[PLUGIN_DATA_ENV] = fakeData;
  t.after(() => {
    if (origEnv !== undefined) process.env[PLUGIN_DATA_ENV] = origEnv;
    else delete process.env[PLUGIN_DATA_ENV];
    fs.rmSync(fakeData, { recursive: true, force: true });
  });

  const dir = stateDir();
  // Must START with $CLAUDE_PLUGIN_DATA/grok-plugin-cc/state/
  const expectedPrefix = path.join(fakeData, "grok-plugin-cc", "state");
  assert.ok(dir.startsWith(expectedPrefix + path.sep),
    `stateDir must be under '${expectedPrefix}/', got '${dir}'`);
  // The trailing piece is `<slug>-<hash>` derived from the workspace root,
  // so just assert it's there.
  assert.match(dir, /[a-zA-Z0-9._-]+-[a-f0-9]+$/,
    "stateDir leaf must be <workspace-slug>-<hash>");
});

test("v1.0.6 (issue #10): jobsDir reflects the grok-plugin-cc namespace too", t => {
  const fakeData = fs.mkdtempSync(path.join(os.tmpdir(), "grok-v106-data-"));
  const origEnv = process.env[PLUGIN_DATA_ENV];
  process.env[PLUGIN_DATA_ENV] = fakeData;
  t.after(() => {
    if (origEnv !== undefined) process.env[PLUGIN_DATA_ENV] = origEnv;
    else delete process.env[PLUGIN_DATA_ENV];
    fs.rmSync(fakeData, { recursive: true, force: true });
  });

  const jdir = jobsDir();
  assert.ok(jdir.includes(path.join("grok-plugin-cc", "state")),
    `jobsDir must include grok-plugin-cc/state/, got '${jdir}'`);
  assert.ok(jdir.endsWith(path.sep + "jobs"),
    `jobsDir must end with /jobs, got '${jdir}'`);
});

test("v1.0.6 (issue #10): fallback (no $CLAUDE_PLUGIN_DATA env) still works — fallback root already has grok-plugin-cc baked in", t => {
  const origEnv = process.env[PLUGIN_DATA_ENV];
  delete process.env[PLUGIN_DATA_ENV];
  t.after(() => {
    if (origEnv !== undefined) process.env[PLUGIN_DATA_ENV] = origEnv;
  });

  const dir = stateDir();
  // FALLBACK_STATE_ROOT is /tmp/grok-plugin-cc/ — namespace already there.
  assert.ok(dir.includes("grok-plugin-cc"),
    `fallback stateDir must include grok-plugin-cc, got '${dir}'`);
});

// ============================================================================
// Issue #10 root cause #1: empty-output diagnostic on exit-0
// ============================================================================

// Fake-grok that emits exactly nothing on stdout AND stderr, then exits
// with a configurable code. Reproduces issue #10's "completed exit 0
// but empty logs" failure mode.
function makeFakeGrokEmpty(t, exitCode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-v106-fake-"));
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
if (args[0] === "--version") {
  console.log("grok 0.1.999 (fake-v106)");
  process.exit(0);
}
// The issue #10 repro: no output at all, configurable exit code.
process.exit(${exitCode});
`, { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(grokScript, 0o755);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runCompanion(fakeDir, args, extraEnv = {}) {
  // Use an isolated $CLAUDE_PLUGIN_DATA so the test doesn't pollute the
  // user's real grok state dir.
  const fakeData = fs.mkdtempSync(path.join(os.tmpdir(), "grok-v106-companion-data-"));
  const r = spawnSync(process.execPath, [COMPANION, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...extraEnv,
      PATH: `${fakeDir}:${process.env.PATH}`,
      [PLUGIN_DATA_ENV]: fakeData,
    },
  });
  // Embed the data dir for the caller to inspect job state.
  r.__fakeData = fakeData;
  return r;
}

test("v1.0.6 (issue #10): /grok:task with exit 0 + empty output triggers diagnostic", t => {
  const fakeDir = makeFakeGrokEmpty(t, 0);
  const r = runCompanion(fakeDir, ["task", "fact-check these claims"]);
  t.after(() => fs.rmSync(r.__fakeData, { recursive: true, force: true }));

  // The diagnostic must fire even on exit 0.
  assert.match(r.stderr, /Job .*: grok exited 0 with empty stdout and stderr/,
    "exit 0 with empty output must trigger the diagnostic (was silently skipped pre-v1.0.6)");
  assert.match(r.stderr, /Command: grok/,
    "diagnostic must include the spawned grok argv");
});

test("v1.0.6 (issue #10): /grok:task with exit 1 + empty output still triggers diagnostic (regression guard)", t => {
  const fakeDir = makeFakeGrokEmpty(t, 1);
  const r = runCompanion(fakeDir, ["task", "fact-check these claims"]);
  t.after(() => fs.rmSync(r.__fakeData, { recursive: true, force: true }));

  // The pre-v1.0.6 path already fired here (because of the
  // `code !== 0` gate). Make sure we didn't break it.
  assert.match(r.stderr, /Job .*: grok exited 1 with empty stdout and stderr/,
    "exit != 0 with empty output must still trigger the diagnostic");
});

test("v1.0.6 (issue #10): meta.no_output is set on disk for exit-0 empty case", t => {
  const fakeDir = makeFakeGrokEmpty(t, 0);
  const r = runCompanion(fakeDir, ["task", "...something..."]);
  t.after(() => fs.rmSync(r.__fakeData, { recursive: true, force: true }));

  // Find the job meta file in the fake data dir.
  const stateRoot = path.join(r.__fakeData, "grok-plugin-cc", "state");
  // Walk for the meta file (its slug-hash folder name depends on the
  // workspace root the test runs in).
  let metaFile = null;
  for (const slugDir of fs.readdirSync(stateRoot)) {
    const jobsPath = path.join(stateRoot, slugDir, "jobs");
    if (fs.existsSync(jobsPath)) {
      for (const f of fs.readdirSync(jobsPath)) {
        if (f.endsWith(".json")) { metaFile = path.join(jobsPath, f); break; }
      }
    }
  }
  assert.ok(metaFile, "meta file must exist in the fake data dir under grok-plugin-cc/state/");
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
  assert.equal(meta.no_output, true,
    "meta.no_output must be true when both buffers were whitespace-only");
  assert.equal(meta.status, "completed",
    "status stays 'completed' for exit 0 — no_output is the signal, not a status change");
});

test("v1.0.6 (issue #10): /grok:result surfaces the empty-output warning when meta.no_output", t => {
  const fakeDir = makeFakeGrokEmpty(t, 0);
  // First call to create the empty job.
  const r1 = runCompanion(fakeDir, ["task", "x"]);
  t.after(() => fs.rmSync(r1.__fakeData, { recursive: true, force: true }));

  // Extract the job ID from r1's stdout: "[grok-plugin] Job <id> completed (exit 0)."
  const m = r1.stdout.match(/Job (x-[a-z0-9-]+)/);
  assert.ok(m, "must be able to extract a Job ID from cmdTask stdout");
  const jobId = m[1];

  // Now run cmdResult on that job — using the SAME PLUGIN_DATA env so
  // it finds the meta. Don't use runCompanion (which makes a fresh data
  // dir per call); call companion directly with the SAME data dir.
  const r2 = spawnSync(process.execPath, [COMPANION, "result", jobId], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeDir}:${process.env.PATH}`,
      [PLUGIN_DATA_ENV]: r1.__fakeData,
    },
  });
  assert.match(r2.stderr, /this job produced NO output/i,
    "cmdResult must surface a no_output warning when meta.no_output");
  assert.match(r2.stderr, /\/grok:rescue --write|--write/i,
    "cmdResult warning must mention --write for tool-using tasks");
});

// ============================================================================
// Source-grep guards
// ============================================================================

test("v1.0.6: runJob sets meta.no_output and has the new exit-0-empty diagnostic branch", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  assert.match(src, /meta\.no_output = true/,
    "runJob must set meta.no_output when both buffers are whitespace-only");
  // The new else-if branch that catches exit-0 empty output.
  assert.match(src, /else if \(meta\.no_output && meta\.status !== "cancelled"\)/,
    "runJob must have the v1.0.6 else-if branch firing diagnoseEmptySpawnFailure on exit 0");
});

test("v1.0.6: cmdResult emits the no_output warning conditionally on meta.no_output", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  assert.match(src, /if \(meta\.no_output\) \{[^}]*WARNING: this job produced NO output/s,
    "cmdResult must have an if(meta.no_output) block writing the warning");
});

test("v1.0.6: stateDir uses path.join with 'grok-plugin-cc' under the env path", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../plugins/grok/scripts/lib/state.mjs"),
    "utf8",
  );
  assert.match(src, /path\.join\(process\.env\[PLUGIN_DATA_ENV\],\s*"grok-plugin-cc",\s*"state"\)/,
    "stateDir must namespace under grok-plugin-cc/state/ to defeat cross-plugin collisions");
});
