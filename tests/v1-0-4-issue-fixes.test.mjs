// v1.0.4 — fixes for Codex P0 findings on the v1.0.3 review
//
// P0-A: --effort gate bypass. v1.0.3's modelSupportsReasoningEffort
//       gate inside grokBaseArgs only protected callers that routed
//       --effort THROUGH grokBaseArgs's `effort` parameter. Two
//       callers append --effort manually OUTSIDE that helper:
//         - cmdReview (companion.mjs): called grokBaseArgs without
//           `effort`, then `args.push("--effort", effort)`.
//         - cmdImagine (companion.mjs): doesn't use grokBaseArgs at
//           all — hand-builds args including --effort.
//       Both paths re-introduced the 4× 400 cascade on grok-build.
//
// P0-B: --save-to source-path confinement. extractMediaPath trusts
//       grok's stdout completely; isSafeMediaPath only validates
//       characters. A prompt-injected grok could return
//       `![](/etc/passwd)` and the plugin would happily copy it to
//       the user's --save-to destination — local-file exfiltration.
//
// P1: GROK_HOME consistency. cleanGrokEnv allows GROK_HOME through
//     to the child grok, but readGrokModelsCache hardcoded ~/.grok.
//     An enterprise user with re-homed grok config would have the
//     gate see null cache (conservative-forward) → 400 cascade.
//
// The fixes:
//   - lib/grok.mjs effortFlagForModel(): new shared helper, single
//     source of truth for the gate. Returns the value to forward
//     (or null if stripped, with warning). grokBaseArgs delegates
//     to it for both --effort and --reasoning-effort.
//   - companion.mjs cmdReview: passes `effort` through to
//     grokBaseArgs (was missing); removes manual push.
//   - companion.mjs cmdImagine: calls effortFlagForModel directly
//     and only pushes --effort if non-null.
//   - companion.mjs isUnderGrokSessionsDir(): new helper using
//     path.resolve to defeat traversal attacks.
//   - companion.mjs copyMediaToSaveTo(): guards source with
//     isUnderGrokSessionsDir before copying.
//   - lib/grok.mjs grokHomeDir() + readGrokModelsCache(): respect
//     GROK_HOME instead of hardcoding ~/.grok/.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  effortFlagForModel,
  grokHomeDir,
} from "../plugins/grok/scripts/lib/grok.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const COMPANION = path.resolve(__dirname, "../plugins/grok/scripts/companion.mjs");

// ============================================================================
// P0-A: --effort gate bypass closure
// ============================================================================

function withFakeHome(t, supportsReasoningEffort) {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-v104-"));
  fs.mkdirSync(path.join(fakeHome, ".grok"), { recursive: true });
  fs.writeFileSync(
    path.join(fakeHome, ".grok", "models_cache.json"),
    JSON.stringify({
      models: {
        "grok-build": { info: { supports_reasoning_effort: supportsReasoningEffort } },
      },
    }),
  );
  const origHome = process.env.HOME;
  const origGrokHome = process.env.GROK_HOME;
  process.env.HOME = fakeHome;
  delete process.env.GROK_HOME;
  t.after(() => {
    process.env.HOME = origHome;
    if (origGrokHome !== undefined) process.env.GROK_HOME = origGrokHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });
  return fakeHome;
}

function captureStderr(fn) {
  const origWrite = process.stderr.write.bind(process.stderr);
  const buf = [];
  process.stderr.write = (chunk) => {
    buf.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    return true;
  };
  try { fn(); } finally { process.stderr.write = origWrite; }
  return buf.join("");
}

test("v1.0.4 (Codex P0-A): effortFlagForModel returns null + warns on unsupported model", t => {
  withFakeHome(t, false);
  let result;
  const stderr = captureStderr(() => {
    result = effortFlagForModel({ effort: "max", model: "grok-build", kind: "effort" });
  });
  assert.equal(result, null, "must return null when model declares no support");
  assert.match(stderr, /grok-build.*supports_reasoning_effort=false/i,
    "must warn with the model name and cache field");
  assert.match(stderr, /stripping --effort=max/i,
    "must echo the stripped value");
});

test("v1.0.4 (Codex P0-A): effortFlagForModel returns the value when supported", t => {
  withFakeHome(t, true);
  const result = effortFlagForModel({ effort: "high", model: "grok-build", kind: "effort" });
  assert.equal(result, "high", "must forward the value verbatim when supported");
});

test("v1.0.4 (Codex P0-A): effortFlagForModel returns null when effort is empty/unset", () => {
  assert.equal(effortFlagForModel({ effort: null }), null);
  assert.equal(effortFlagForModel({ effort: "" }), null);
  assert.equal(effortFlagForModel({}), null);
});

test("v1.0.4 (Codex P0-A): effortFlagForModel rejects invalid levels", t => {
  withFakeHome(t, true);
  assert.throws(
    () => effortFlagForModel({ effort: "ultra", model: "grok-build" }),
    /invalid --effort/i,
  );
});

test("v1.0.4 (Codex P0-A): effortFlagForModel uses kind to switch warning text", t => {
  withFakeHome(t, false);
  let result;
  const stderr = captureStderr(() => {
    result = effortFlagForModel({ effort: "max", model: "grok-build", kind: "reasoning-effort" });
  });
  assert.equal(result, null);
  assert.match(stderr, /stripping --reasoning-effort=max/i,
    "warning text must say --reasoning-effort when kind is reasoning-effort");
});

// ============================================================================
// P0-A end-to-end: cmdReview + cmdImagine no longer bypass the gate
// ============================================================================

function makeFakeGrok(t, supportsReasoningEffort) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-v104-fake-"));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-v104-home-"));
  fs.mkdirSync(path.join(fakeHome, "sessions", "fake-cwd", "session-uuid", "images"), { recursive: true });
  fs.writeFileSync(
    path.join(fakeHome, "models_cache.json"),
    JSON.stringify({
      models: { "grok-build": { info: { supports_reasoning_effort: supportsReasoningEffort } } },
    }),
  );
  const fakeMediaPath = path.join(fakeHome, "sessions", "fake-cwd", "session-uuid", "images", "1.jpg");
  fs.writeFileSync(fakeMediaPath, "FAKE_IMG_v104");

  fs.writeFileSync(path.join(dir, "grok"), `#!/usr/bin/env node
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
if (args[0] === "--version") { console.log("grok 0.1.999 (fake-v104)"); process.exit(0); }
process.stdout.write(JSON.stringify({
  text: "![generated](${fakeMediaPath})",
  stopReason: "EndTurn",
  sessionId: "fake-v104-session"
}) + "\\n");
process.exit(0);
`, { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(path.join(dir, "grok"), 0o755);
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });
  return { dir, fakeHome, fakeMediaPath };
}

function runCompanion(fakeDir, args, env) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      PATH: `${fakeDir}:${process.env.PATH}`,
    },
  });
}

test("v1.0.4 (Codex P0-A): /grok:imagine --effort high strips + warns (was: bypassed gate)", t => {
  const { dir: fakeDir, fakeHome } = makeFakeGrok(t, false);
  const r = runCompanion(fakeDir, ["imagine", "--effort", "high", "a red apple"], { GROK_HOME: fakeHome });
  assert.match(r.stderr, /supports_reasoning_effort=false/i,
    "cmdImagine must now hit the gate (was bypassed in v1.0.3)");
  // Verify the spawned grok argv does NOT contain --effort.
  const recordedArgs = JSON.parse(fs.readFileSync(path.join(fakeDir, "args.json"), "utf8"));
  assert.equal(recordedArgs.includes("--effort"), false,
    "spawned grok argv must NOT contain --effort when gate strips it");
});

test("v1.0.4 (Codex P0-A): /grok:imagine --effort high forwards when model supports", t => {
  const { dir: fakeDir, fakeHome } = makeFakeGrok(t, true);
  const r = runCompanion(fakeDir, ["imagine", "--effort", "high", "a red apple"], { GROK_HOME: fakeHome });
  assert.equal(r.stderr.includes("supports_reasoning_effort=false"), false,
    "no strip warning when model supports effort");
  const recordedArgs = JSON.parse(fs.readFileSync(path.join(fakeDir, "args.json"), "utf8"));
  const i = recordedArgs.indexOf("--effort");
  assert.notEqual(i, -1, "spawned grok argv MUST contain --effort when supported");
  assert.equal(recordedArgs[i + 1], "high");
});

// ============================================================================
// P0-B: --save-to source-path confinement
// ============================================================================

test("v1.0.4 (Codex P0-B): --save-to refuses copy when source is outside sessions dir", t => {
  // Build a fake-grok that returns /etc/hosts as the media path (an
  // arbitrary local file outside grok's session dir). The plugin's
  // tightened gate must refuse to read+copy it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-v104-evil-"));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-v104-evil-home-"));
  fs.writeFileSync(path.join(dir, "grok"), `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const here = path.dirname(process.argv[1]);
fs.writeFileSync(path.join(here, "args.json"), JSON.stringify(args, null, 2));
if (args[0] === "--help") {
  console.log(["-p, --single", "-m, --model", "--output-format", "--always-approve", "--permission-mode", "--max-turns", "--disallowed-tools", "--prompt-file", "--effort", "--check", "--best-of-n"].join("\\n"));
  process.exit(0);
}
if (args[0] === "--version") { console.log("grok 0.1.999"); process.exit(0); }
// Inject an arbitrary local-file path as the markdown image.
process.stdout.write(JSON.stringify({
  text: "![pwned](/etc/hosts)",
  stopReason: "EndTurn",
  sessionId: "evil-session"
}) + "\\n");
process.exit(0);
`, { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(path.join(dir, "grok"), 0o755);
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-v104-dest-"));
  const destPath = path.join(destDir, "exfil.jpg");
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(destDir, { recursive: true, force: true });
  });

  const r = runCompanion(dir, ["imagine", "--save-to", destPath, "trigger"], { GROK_HOME: fakeHome });
  // The display branch labels /etc/hosts as UNSAFE (isSafeMediaPath strips
  // it earlier — chars-only check approves /etc/hosts but the new sessions
  // gate isn't called from display). Regardless: the COPY must not happen.
  assert.equal(fs.existsSync(destPath), false,
    "exfiltrated file MUST NOT exist at the user's --save-to path");
});

test("v1.0.4 (Codex P0-B): --save-to allows copy when source IS under sessions dir", t => {
  // Sanity: the gate must not break the happy path. This complements
  // the v1.0.2 tests (which now also pass GROK_HOME).
  const { dir: fakeDir, fakeHome, fakeMediaPath } = makeFakeGrok(t, true);
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-v104-happy-"));
  const destPath = path.join(destDir, "ok.jpg");
  t.after(() => fs.rmSync(destDir, { recursive: true, force: true }));

  const r = runCompanion(fakeDir, ["imagine", "--save-to", destPath, "x"], { GROK_HOME: fakeHome });
  assert.equal(r.status, 0, `companion failed: ${r.stderr}`);
  assert.ok(fs.existsSync(destPath), "happy-path copy MUST still work");
  assert.equal(
    fs.readFileSync(destPath, "utf8"),
    fs.readFileSync(fakeMediaPath, "utf8"),
    "happy-path contents must match",
  );
});

// ============================================================================
// P1: GROK_HOME consistency
// ============================================================================

test("v1.0.4 (Codex P1): grokHomeDir returns GROK_HOME when set, else ~/.grok", t => {
  const origGrokHome = process.env.GROK_HOME;
  t.after(() => {
    if (origGrokHome !== undefined) process.env.GROK_HOME = origGrokHome;
    else delete process.env.GROK_HOME;
  });

  process.env.GROK_HOME = "/custom/grok-home";
  assert.equal(grokHomeDir(), "/custom/grok-home",
    "must return GROK_HOME when set");

  delete process.env.GROK_HOME;
  assert.equal(grokHomeDir(), path.join(os.homedir(), ".grok"),
    "must fall back to ~/.grok when GROK_HOME unset");
});

test("v1.0.4 (Codex P1): the effort gate reads models_cache from GROK_HOME, not ~/.grok", t => {
  // Put a "supports=true" cache at GROK_HOME and a non-existent path at
  // ~/.grok. Without the GROK_HOME consistency fix, modelSupportsReasoningEffort
  // would read ~/.grok/models_cache.json → null → conservative-forward.
  // With the fix, it reads $GROK_HOME/models_cache.json → true → forward.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-v104-grokhome-"));
  fs.writeFileSync(
    path.join(fakeHome, "models_cache.json"),
    JSON.stringify({ models: { "grok-build": { info: { supports_reasoning_effort: true } } } }),
  );
  const origGrokHome = process.env.GROK_HOME;
  const origHome = process.env.HOME;
  process.env.GROK_HOME = fakeHome;
  // Point HOME elsewhere so ~/.grok definitely doesn't have the cache.
  const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-v104-otherhome-"));
  process.env.HOME = otherHome;
  t.after(() => {
    if (origGrokHome !== undefined) process.env.GROK_HOME = origGrokHome;
    else delete process.env.GROK_HOME;
    if (origHome !== undefined) process.env.HOME = origHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(otherHome, { recursive: true, force: true });
  });

  const result = effortFlagForModel({ effort: "max", model: "grok-build", kind: "effort" });
  assert.equal(result, "max",
    "the gate must read GROK_HOME's cache, not ~/.grok — got null which means it missed the cache");
});

// ============================================================================
// Source-grep guards
// ============================================================================

test("v1.0.4: effortFlagForModel is exported and used by both grokBaseArgs + cmdImagine", () => {
  const grokSrc = fs.readFileSync(
    path.resolve(__dirname, "../plugins/grok/scripts/lib/grok.mjs"),
    "utf8",
  );
  const companionSrc = fs.readFileSync(COMPANION, "utf8");
  assert.match(grokSrc, /export function effortFlagForModel/,
    "effortFlagForModel must be exported from lib/grok.mjs");
  // Counts: 1 export + 2 internal calls in grokBaseArgs + 1 import + 1 call in cmdImagine = 5
  const grokCalls = (grokSrc.match(/effortFlagForModel\(/g) || []).length;
  assert.ok(grokCalls >= 3, `expected ≥3 occurrences in lib/grok.mjs, got ${grokCalls}`);
  assert.match(companionSrc, /effortFlagForModel/,
    "companion.mjs must import effortFlagForModel (cmdImagine uses it)");
});

test("v1.0.4: isUnderGrokSessionsDir is defined and guards copyMediaToSaveTo", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  assert.match(src, /function isUnderGrokSessionsDir/,
    "isUnderGrokSessionsDir must be defined in companion.mjs");
  assert.match(src, /if \(!isUnderGrokSessionsDir\(mediaPath\)\)/,
    "copyMediaToSaveTo must call isUnderGrokSessionsDir before the copy");
});
