// Round-2 regression tests for v0.6.0 — fixes for Codex + Gemini blocking
// findings. These tests run companion.mjs as a subprocess with a fake `grok`
// on PATH, replacing the tautological "reproduce-the-logic-in-the-test"
// patterns Gemini flagged in G3.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPANION = path.resolve(__dirname, "../plugins/grok/scripts/companion.mjs");

// Build a fake-grok binary that records its full argv to a sibling
// "args.json" file and reads its mode from a sibling "mode" file. We
// can't pass FAKE_GROK_* env vars because the plugin's cleanGrokEnv()
// strips arbitrary env vars before spawning grok (defense-in-depth
// against secret exfiltration). Disk-based handoff sidesteps that.
function makeFakeGrokDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-fakebin-"));
  const grokScript = path.join(dir, "grok");
  fs.writeFileSync(grokScript, `#!/usr/bin/env node
// CommonJS — Node treats extensionless executables as CommonJS by default.
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const here = path.dirname(process.argv[1]);
fs.writeFileSync(path.join(here, "args.json"), JSON.stringify(args, null, 2));
let mode = "ok-plain";
try { mode = fs.readFileSync(path.join(here, "mode"), "utf8").trim(); } catch {}
if (mode === "version") {
  console.log("grok 0.1.999 (fake)");
  process.exit(0);
}
if (mode === "help") {
  // Print enough flags that capabilityProbe passes.
  console.log([
    "-p, --single", "-m, --model", "--output-format", "--always-approve",
    "--permission-mode", "--max-turns", "--disallowed-tools", "--prompt-file",
    "--effort", "--check", "--best-of-n", "--disable-web-search"
  ].join("\\n"));
  process.exit(0);
}
if (mode === "ok-plain") { console.log("FAKE_GROK_RESPONSE_OK"); process.exit(0); }
if (mode === "ok-json") {
  process.stdout.write(JSON.stringify({
    text: "FAKE_GROK_RESPONSE_OK",
    stopReason: "EndTurn",
    sessionId: "fake-session"
  }) + "\\n");
  process.exit(0);
}
if (mode === "ansi-in-text") {
  // CRITICAL — the dangerous case Codex flagged: ANSI escapes inside the
  // JSON text field. They survive JSON.parse intact and reach the user's
  // terminal unless sanitizeForTerminal wraps the print.
  process.stdout.write(JSON.stringify({
    text: "BEFORE\\u001b[31mRED_INJECT\\u001b[0mAFTER",
    stopReason: "EndTurn",
    sessionId: "fake-session"
  }) + "\\n");
  process.exit(0);
}
if (mode === "models-list") {
  console.log("Default model: fake-build-2\\n\\nAvailable models:\\n  * fake-build-2 (default)");
  process.exit(0);
}
if (mode === "exit-99") {
  console.error("fake grok: simulated failure");
  process.exit(99);
}
console.error("fake grok: unknown mode: " + mode);
process.exit(98);
`, { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(grokScript, 0o755);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setFakeMode(fakeDir, mode) {
  fs.writeFileSync(path.join(fakeDir, "mode"), mode);
}

function readRecordedArgs(fakeDir) {
  return JSON.parse(fs.readFileSync(path.join(fakeDir, "args.json"), "utf8"));
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

// ============================================================================
// G3 — replace tautological tests with subprocess-against-fake-grok
// ============================================================================

test("G3: /grok:research defaults emit --effort max --check (no --disable-web-search)", t => {
  const fakeDir = makeFakeGrokDir(t);
  setFakeMode(fakeDir, "ok-json");
  const r = runCompanion(fakeDir, ["research", "what is the answer to life"]);
  assert.equal(r.status, 0, `companion failed: ${r.stderr}`);
  const recorded = readRecordedArgs(fakeDir);
  const i = recorded.indexOf("--effort");
  assert.notEqual(i, -1, "research must pass --effort");
  assert.equal(recorded[i + 1], "max", "default effort must be max");
  assert.ok(recorded.includes("--check"), "research must include --check by default");
  assert.equal(recorded.includes("--disable-web-search"), false,
    "research must NOT disable web search by default");
});

test("G3: /grok:research --no-check actually drops --check", t => {
  const fakeDir = makeFakeGrokDir(t);
  setFakeMode(fakeDir, "ok-json");
  const r = runCompanion(fakeDir, ["research", "--no-check", "question"]);
  assert.equal(r.status, 0, `companion failed: ${r.stderr}`);
  const recorded = readRecordedArgs(fakeDir);
  assert.equal(recorded.includes("--check"), false,
    "--no-check must remove --check from grok's argv");
});

test("G3: /grok:research --no-web-search emits --disable-web-search", t => {
  const fakeDir = makeFakeGrokDir(t);
  setFakeMode(fakeDir, "ok-json");
  const r = runCompanion(fakeDir, ["research", "--no-web-search", "question"]);
  assert.equal(r.status, 0, `companion failed: ${r.stderr}`);
  const recorded = readRecordedArgs(fakeDir);
  assert.ok(recorded.includes("--disable-web-search"),
    "--no-web-search must emit --disable-web-search");
});

// ============================================================================
// Gemini round-2 G2 — case-insensitive effort
// ============================================================================

test("G2: /grok:research accepts --effort MAX (case-insensitive)", t => {
  const fakeDir = makeFakeGrokDir(t);
  setFakeMode(fakeDir, "ok-json");
  const r = runCompanion(fakeDir, ["research", "--effort", "MAX", "question"]);
  assert.equal(r.status, 0,
    `--effort MAX must be normalized to "max", not rejected. stderr: ${r.stderr}`);
  const recorded = readRecordedArgs(fakeDir);
  const i = recorded.indexOf("--effort");
  assert.equal(recorded[i + 1], "max",
    "case-mixed --effort MAX must be lowercased before passing to grok");
});

test("G2: /grok:best-of accepts --effort MEDIUM (case-insensitive)", t => {
  const fakeDir = makeFakeGrokDir(t);
  setFakeMode(fakeDir, "ok-json");
  const r = runCompanion(fakeDir, ["best-of", "3", "--effort", "MEDIUM", "question"]);
  assert.equal(r.status, 0,
    `best-of --effort MEDIUM must be normalized, not rejected. stderr: ${r.stderr}`);
  const recorded = readRecordedArgs(fakeDir);
  const i = recorded.indexOf("--effort");
  assert.equal(recorded[i + 1], "medium");
});

// ============================================================================
// Codex round-2 BLOCKING A — escaped ANSI inside JSON text reaches terminal
// ============================================================================

test("Codex-A: /grok:research sanitizes ANSI escapes inside parsed.text", t => {
  const fakeDir = makeFakeGrokDir(t);
  setFakeMode(fakeDir, "ansi-in-text");
  const r = runCompanion(fakeDir, ["research", "question"]);
  assert.equal(r.status, 0);
  // The output must NOT contain raw ESC byte (0x1B / ).
  assert.equal(r.stdout.includes(""), false,
    "raw ESC bytes must not survive to stdout — sanitizeForTerminal must run on parsed.text");
  assert.ok(r.stdout.includes("BEFORE"));
  assert.ok(r.stdout.includes("AFTER"));
  assert.ok(r.stdout.includes("RED_INJECT"),
    "the inner text content must remain visible, only the escape bytes stripped");
});

test("Codex-A: /grok:best-of also sanitizes ANSI in parsed.text", t => {
  const fakeDir = makeFakeGrokDir(t);
  setFakeMode(fakeDir, "ansi-in-text");
  const r = runCompanion(fakeDir, ["best-of", "2", "question"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.includes(""), false);
});

// ============================================================================
// Codex round-2 BLOCKING C — /grok:models sanitizes footer
// ============================================================================

test("Codex-C: /grok:models footer sanitizes GROK_PLUGIN_MODEL env override", t => {
  const fakeDir = makeFakeGrokDir(t);
  setFakeMode(fakeDir, "models-list");
  const evilModel = "evil[2J[Hclear-screen-payload";
  const r = runCompanion(fakeDir, ["models"], { GROK_PLUGIN_MODEL: evilModel });
  assert.equal(r.status, 0, `companion failed: ${r.stderr}`);
  assert.equal(r.stdout.includes(""), false,
    "GROK_PLUGIN_MODEL must be sanitized before printing to footer");
  assert.ok(r.stdout.includes("clear-screen-payload"),
    "the visible portion of the env value should still be shown");
});

test("Codex-C: /grok:models --set-default rejects ANSI-injected model id at write layer", t => {
  // The defense for malicious --set-default values is actually at the
  // write layer: setActiveModel() validates against MODEL_ID_PATTERN and
  // throws on any shape that would not match a real model. So the ANSI
  // injection vector is closed *before* the echo path runs — the echo
  // sanitization (verified in the next test) is belt-and-suspenders.
  const fakeDir = makeFakeGrokDir(t);
  setFakeMode(fakeDir, "ok-plain");
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-state-models-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const evilId = "evil\u001b[31m-name";
  const r = runCompanion(fakeDir, ["models", "--set-default", evilId], {
    CLAUDE_PLUGIN_DATA: stateDir
  });
  assert.notEqual(r.status, 0, "ANSI-injected model id must be rejected, not silently accepted");
  assert.match(r.stderr, /invalid model id/i, "rejection must surface a clear error");
});

test("Codex-C: /grok:models --set-default echo passes through sanitizeForTerminal (source-level)", () => {
  // Defense in depth: even though setActiveModel rejects malicious ids
  // today, the echo path also uses sanitizeForTerminal in case
  // MODEL_ID_PATTERN ever loosens.
  const src = fs.readFileSync(COMPANION, "utf8");
  const setDefaultBranch = src.slice(
    src.indexOf("if (flags[\"set-default\"])"),
    src.indexOf("const timeoutMs = resolveTimeoutMs(flags.timeout, DEFAULT_MODELS_TIMEOUT_MS);")
  );
  assert.match(setDefaultBranch, /sanitizeForTerminal\(targetStr\)/,
    "set-default echo must sanitize the value via sanitizeForTerminal");
});

test("Codex-C: /grok:models --set-default refuses very long values", t => {
  const fakeDir = makeFakeGrokDir(t);
  setFakeMode(fakeDir, "ok-plain");
  const huge = "x".repeat(2000);
  const r = runCompanion(fakeDir, ["models", "--set-default", huge]);
  assert.notEqual(r.status, 0,
    "--set-default with >128-char value must be rejected");
  assert.match(r.stderr, /exceeds \d+ chars/);
});

// ============================================================================
// Codex round-2 BLOCKING B — generic spawn errors no longer exit 0
// ============================================================================

test("Codex-B: non-zero fake-grok exit propagates from runHeadlessGrok", t => {
  const fakeDir = makeFakeGrokDir(t);
  setFakeMode(fakeDir, "exit-99");
  const r = runCompanion(fakeDir, ["research", "question"]);
  assert.notEqual(r.status, 0,
    "non-zero fake-grok exit must propagate from runHeadlessGrok");
});

test("Codex-B regression: companion.mjs sets an explicit maxBuffer + ENOBUFS hint", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  assert.match(src, /HEADLESS_GROK_MAX_BUFFER\s*=\s*\d+\s*\*\s*1024\s*\*\s*1024/);
  assert.match(src, /maxBuffer:\s*HEADLESS_GROK_MAX_BUFFER/);
  assert.match(src, /ENOBUFS/);
});

// ============================================================================
// Nit-N2: /grok:ask threads --no-web-search through
// ============================================================================

test("nit-N2: /grok:ask --no-web-search emits --disable-web-search to grok", t => {
  const fakeDir = makeFakeGrokDir(t);
  setFakeMode(fakeDir, "ok-json");
  const r = runCompanion(fakeDir, ["ask", "--no-web-search", "what time is it"]);
  assert.equal(r.status, 0, `companion failed: ${r.stderr}`);
  const recorded = readRecordedArgs(fakeDir);
  assert.ok(recorded.includes("--disable-web-search"),
    "/grok:ask --no-web-search used to be silently ignored (Gemini round-2 N2)");
});

// ============================================================================
// Nit-N3: validateEffort uses EFFORT_LEVELS (no duplicate set)
// ============================================================================

test("nit-N3: companion.mjs no longer defines its own VALID_EFFORTS set", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  assert.equal(src.includes("VALID_EFFORTS = new Set("), false,
    "companion.mjs must not define VALID_EFFORTS — single source of truth is EFFORT_LEVELS in lib/grok.mjs");
  assert.match(src, /EFFORT_LEVELS/,
    "companion.mjs must import EFFORT_LEVELS to drive validateEffort");
});
