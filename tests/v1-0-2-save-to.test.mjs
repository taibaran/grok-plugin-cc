// v1.0.2 — fix for issue #5 (eyalRonen1): --save-to flag on imagine + imagine-video
//
// Before v1.0.2 every imagine / imagine-video invocation forced the user
// to parse the `Video: <internal grok session path>` stdout line and `cp`
// to wherever the artifact actually belonged. For an 8-clip commercial
// shoot that meant 8x parse + 8x cp on top of the actual generation.
//
// The fix: `--save-to <path>` flag. The plugin copies the generated
// media from grok's internal session dir (`~/.grok/sessions/<URL-encoded
// -cwd>/<session>/{images,videos}/N.X`) to the user-specified path. The
// session copy stays in place so `grok -r <session-id>` resume / audit
// still works.

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

// Fake-grok stub that fakes a /imagine-video response with a real on-disk
// media file. The stub:
//   1. Pre-creates an actual file at a path that mimics the real grok
//      session-dir layout (~/.grok/sessions/<encoded>/<session>/videos/1.mp4).
//   2. Returns a JSON envelope containing a markdown link to that file.
//
// This lets the plugin's --save-to copy logic actually execute against
// a real source file, so we test the END-TO-END behavior (copy happened,
// dest file exists, contents match), not just source-grep guards.
function makeFakeGrokDir(t, { sessionDir }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-v102-"));
  const fakeMediaPath = path.join(sessionDir, "videos", "1.mp4");
  fs.mkdirSync(path.dirname(fakeMediaPath), { recursive: true });
  fs.writeFileSync(fakeMediaPath, "FAKE_MP4_CONTENT_v102_save_to_test");

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
  console.log("grok 0.1.999 (fake-v102)");
  process.exit(0);
}
// Return a JSON envelope pointing at the pre-created fake media file.
process.stdout.write(JSON.stringify({
  text: "![generated](${fakeMediaPath})",
  stopReason: "EndTurn",
  sessionId: "fake-v102-session"
}) + "\\n");
process.exit(0);
`, { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(grokScript, 0o755);
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });
  return { dir, fakeMediaPath };
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
// Behavioral: end-to-end --save-to actually copies the file
// ============================================================================

test("v1.0.2 (issue #5): --save-to copies the generated media to the user's path", t => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-session-"));
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-dest-"));
  const destPath = path.join(destDir, "beat1.mp4");
  t.after(() => fs.rmSync(destDir, { recursive: true, force: true }));

  const { dir: fakeDir, fakeMediaPath } = makeFakeGrokDir(t, { sessionDir });
  const r = runCompanion(fakeDir, ["imagine-video", "--save-to", destPath, "a red apple"]);

  assert.equal(r.status, 0, `companion exited ${r.status}: ${r.stderr}`);
  // 1. The dest file actually exists.
  assert.ok(fs.existsSync(destPath), `dest file ${destPath} must exist after --save-to`);
  // 2. The dest contents match the source (true copy, not a stub).
  assert.equal(
    fs.readFileSync(destPath, "utf8"),
    fs.readFileSync(fakeMediaPath, "utf8"),
    "dest file contents must match the fake source file (real copy)"
  );
  // 3. The session copy still exists (preserved for `grok -r` resume).
  assert.ok(fs.existsSync(fakeMediaPath),
    "the internal session copy must be preserved for `grok -r` resume");
  // 4. The display path printed to stdout is the dest path, not the session path.
  assert.match(r.stdout, new RegExp(`Video:\\s+${destPath.replace(/[.\/]/g, "\\$&")}`),
    "stdout must show the --save-to destination as the Video: path");
  assert.equal(r.stdout.includes(fakeMediaPath), false,
    "stdout must NOT leak the internal session path when --save-to is given");
});

test("v1.0.2 (issue #5): --save-to to an existing directory appends the source basename", t => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-session-"));
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-destdir-"));
  t.after(() => fs.rmSync(destDir, { recursive: true, force: true }));

  const { dir: fakeDir } = makeFakeGrokDir(t, { sessionDir });
  // Pass the existing directory itself as --save-to (no trailing slash, no basename).
  const r = runCompanion(fakeDir, ["imagine-video", "--save-to", destDir, "a red apple"]);

  assert.equal(r.status, 0, `companion exited ${r.status}: ${r.stderr}`);
  // The plugin should have appended "1.mp4" (basename of fake source) to destDir.
  const expectedDest = path.join(destDir, "1.mp4");
  assert.ok(fs.existsSync(expectedDest),
    `dest file ${expectedDest} must exist when --save-to is a directory (basename appended)`);
});

test("v1.0.2 (issue #5): --save-to with trailing slash appends the source basename", t => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-session-"));
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-destslash-"));
  t.after(() => fs.rmSync(destDir, { recursive: true, force: true }));

  const { dir: fakeDir } = makeFakeGrokDir(t, { sessionDir });
  // Pass the directory WITH a trailing slash — should also trigger basename append.
  const r = runCompanion(fakeDir, ["imagine-video", "--save-to", destDir + "/", "a red apple"]);

  assert.equal(r.status, 0, `companion exited ${r.status}: ${r.stderr}`);
  const expectedDest = path.join(destDir, "1.mp4");
  assert.ok(fs.existsSync(expectedDest),
    "trailing slash on --save-to must trigger basename-append even if dir doesn't exist yet");
});

test("v1.0.2 (issue #5): --save-to creates missing parent dirs (mkdirp)", t => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-session-"));
  const destBase = fs.mkdtempSync(path.join(os.tmpdir(), "grok-mkdirp-"));
  // Deeply nested path that doesn't exist yet.
  const destPath = path.join(destBase, "shots", "v8", "beat3.mp4");
  t.after(() => fs.rmSync(destBase, { recursive: true, force: true }));

  const { dir: fakeDir } = makeFakeGrokDir(t, { sessionDir });
  const r = runCompanion(fakeDir, ["imagine-video", "--save-to", destPath, "..."]);

  assert.equal(r.status, 0, `companion exited ${r.status}: ${r.stderr}`);
  assert.ok(fs.existsSync(destPath),
    "missing parent dirs (shots/v8/) must be created by --save-to");
});

test("v1.0.2 (issue #5): --save-to refuses control bytes (terminal-attack defense)", t => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-session-"));
  const { dir: fakeDir } = makeFakeGrokDir(t, { sessionDir });
  // --save-to value with an embedded ANSI escape byte (\x1b). Node's
  // spawnSync rejects NUL (\x00) at the argv boundary itself, so we use
  // ESC instead — same defense, but actually reaches the companion.
  // If the companion accepted it, the ESC would corrupt the terminal
  // when echoed back in the `open --` hint.
  const evilPath = "/tmp/grok-evil\x1b[2J.mp4";
  const r = runCompanion(fakeDir, ["imagine-video", "--save-to", evilPath, "..."]);

  // The companion should still exit 0 (generation succeeded). The --save-to
  // step surfaces an error AND falls back to the internal session path so
  // the user can recover.
  assert.match(r.stderr, /--save-to.*(control bytes|refusing)/i,
    "control bytes in --save-to must be refused with an explanatory error");
});

// ============================================================================
// Behavioral: --json output exposes both paths
// ============================================================================

test("v1.0.2 (issue #5): --save-to + --json exposes both savedTo and sessionPath", t => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-session-"));
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-jsondest-"));
  const destPath = path.join(destDir, "beat1.mp4");
  t.after(() => fs.rmSync(destDir, { recursive: true, force: true }));

  const { dir: fakeDir, fakeMediaPath } = makeFakeGrokDir(t, { sessionDir });
  const r = runCompanion(fakeDir, ["imagine-video", "--save-to", destPath, "--json", "..."]);

  assert.equal(r.status, 0, `companion exited ${r.status}: ${r.stderr}`);
  const obj = JSON.parse(r.stdout);

  // .path is the file's actual current location — savedTo when --save-to
  // succeeded, internal session path otherwise. Preserves backward compat
  // (old callers reading .path still get a usable file location).
  assert.equal(obj.path, destPath,
    ".path must point to the saved-to destination when --save-to succeeded");
  // .savedTo is non-null only when --save-to was supplied AND succeeded.
  assert.equal(obj.savedTo, destPath,
    ".savedTo must equal the resolved --save-to destination");
  // .sessionPath is always the internal grok session-dir path so callers
  // that want to inspect or re-find via `grok -r` can do so.
  assert.equal(obj.sessionPath, fakeMediaPath,
    ".sessionPath must always carry the internal grok session-dir path");
  // .saveError is null on success.
  assert.equal(obj.saveError, null, ".saveError must be null when copy succeeded");
});

test("v1.0.2 (issue #5): --json WITHOUT --save-to preserves the existing shape (path=session)", t => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-session-"));
  const { dir: fakeDir, fakeMediaPath } = makeFakeGrokDir(t, { sessionDir });
  const r = runCompanion(fakeDir, ["imagine-video", "--json", "..."]);

  assert.equal(r.status, 0, `companion exited ${r.status}: ${r.stderr}`);
  const obj = JSON.parse(r.stdout);
  // No --save-to → .path = internal session path (backward compat).
  assert.equal(obj.path, fakeMediaPath,
    ".path must be the internal session path when --save-to is NOT given");
  assert.equal(obj.savedTo, null, ".savedTo must be null when --save-to not supplied");
  assert.equal(obj.saveError, null, ".saveError must be null when --save-to not supplied");
});

// ============================================================================
// Source-grep guards (cheap regression markers)
// ============================================================================

test("v1.0.2: save-to is registered in COMMON_VALUE_FLAGS", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../plugins/grok/scripts/lib/args.mjs"),
    "utf8"
  );
  assert.match(src, /"save-to"/,
    "save-to must be in COMMON_VALUE_FLAGS so parseArgs treats it as a value flag");
});

test("v1.0.2: imagine.md + imagine-video.md document --save-to in argument-hint", () => {
  const imagineDoc = fs.readFileSync(
    path.resolve(__dirname, "../plugins/grok/commands/imagine.md"),
    "utf8"
  );
  const videoDoc = fs.readFileSync(
    path.resolve(__dirname, "../plugins/grok/commands/imagine-video.md"),
    "utf8"
  );
  assert.match(imagineDoc, /--save-to/, "imagine.md must mention --save-to");
  assert.match(videoDoc, /--save-to/, "imagine-video.md must mention --save-to");
  // Both should reference it in the argument-hint frontmatter (visible to
  // Claude Code's slash-command UI).
  assert.match(imagineDoc, /argument-hint:.*--save-to/,
    "imagine.md argument-hint must list --save-to");
  assert.match(videoDoc, /argument-hint:.*--save-to/,
    "imagine-video.md argument-hint must list --save-to");
});
