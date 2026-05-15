// Regression tests for the eight v0.4.0 hardening fixes.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

import {
  findLastJsonObject,
  parseVerdict,
  findBalancedJsonEnd
} from "../plugins/grok/scripts/lib/verdict.mjs";

import {
  READ_ONLY_DISALLOWED_TOOLS,
  AUTH_PROBE_DISALLOWED_TOOLS,
  grokBaseArgs
} from "../plugins/grok/scripts/lib/grok.mjs";

import { isAlive } from "../plugins/grok/scripts/lib/process.mjs";

const COMPANION_PATH = new URL("../plugins/grok/scripts/companion.mjs", import.meta.url).pathname;
const STOP_GATE_PATH = new URL("../plugins/grok/scripts/stop-review-gate-hook.mjs", import.meta.url).pathname;
const GIT_LIB_PATH = new URL("../plugins/grok/scripts/lib/git.mjs", import.meta.url).pathname;
const PROMPT_REVIEW_PATH = new URL("../plugins/grok/prompts/review.md", import.meta.url).pathname;

// ============================================================================
// B1 — UTF-8 chunk tearing defense (Gemini round-3 finding)
// ============================================================================

test("B1: companion.mjs::runJob sets utf8 encoding on spawned stdio", () => {
  const src = fs.readFileSync(COMPANION_PATH, "utf8");
  // The setEncoding calls must be present right after the spawn in runJob.
  assert.match(src, /proc\.stdout\.setEncoding\("utf8"\)/,
    "runJob must setEncoding('utf8') on proc.stdout");
  assert.match(src, /proc\.stderr\.setEncoding\("utf8"\)/,
    "runJob must setEncoding('utf8') on proc.stderr");
});

test("B1: stop-review-gate-hook.mjs sets utf8 encoding on spawned stdio", () => {
  const src = fs.readFileSync(STOP_GATE_PATH, "utf8");
  assert.match(src, /proc\.stdout\.setEncoding\("utf8"\)/);
  assert.match(src, /proc\.stderr\.setEncoding\("utf8"\)/);
});

// ============================================================================
// B2 — git diff branch refspec must NOT be preceded by `--` (Codex finding)
// ============================================================================

test("B2: lib/git.mjs no longer puts `--` before the refspec in branch diff", () => {
  const src = fs.readFileSync(GIT_LIB_PATH, "utf8");
  // The buggy form was: git diff -- <ref>...HEAD
  // The fix is: git diff <ref>...HEAD (with optional `--` AFTER if needed).
  // We check that the substring `"diff", "--", \`${ref}...HEAD\`` is gone.
  assert.equal(
    src.includes(`"diff", "--", \`\${ref}...HEAD\``),
    false,
    "lib/git.mjs must not call `git diff -- <ref>...HEAD` (git treats the refspec as a pathspec)"
  );
  // And the new correct form must be present.
  assert.match(src, /"diff",\s*`\$\{ref\}\.\.\.HEAD`/,
    "lib/git.mjs must call git diff <ref>...HEAD without a preceding `--`");
});

// ============================================================================
// B3 — read-only vs auth-probe tool policy is exported as named constants
// ============================================================================

test("B3: READ_ONLY_DISALLOWED_TOOLS bans writes + shell but leaves web tools", () => {
  // Read-only ops (ask/review/adversarial-review) should NOT ban web_search /
  // web_fetch / Agent — Grok's biggest differentiator vs Claude is live web
  // search, and the prompting skill explicitly tells the model to use it.
  const banned = new Set(READ_ONLY_DISALLOWED_TOOLS.split(","));
  assert.ok(banned.has("search_replace"), "search_replace must be banned in read-only");
  assert.ok(banned.has("run_terminal_cmd"), "run_terminal_cmd must be banned in read-only");
  assert.ok(banned.has("todo_write"), "todo_write must be banned in read-only");
  assert.ok(!banned.has("web_search"), "web_search must NOT be banned in read-only (Grok strength)");
  assert.ok(!banned.has("web_fetch"), "web_fetch must NOT be banned in read-only");
  assert.ok(!banned.has("Agent"), "Agent must NOT be banned in read-only");
});

test("B3: AUTH_PROBE_DISALLOWED_TOOLS bans every tool for the deterministic probe", () => {
  const banned = new Set(AUTH_PROBE_DISALLOWED_TOOLS.split(","));
  for (const tool of ["Agent", "run_terminal_cmd", "search_replace", "web_search", "web_fetch", "todo_write"]) {
    assert.ok(banned.has(tool), `${tool} must be banned during auth probe`);
  }
});

test("B3: grokBaseArgs uses the shared READ_ONLY_DISALLOWED_TOOLS constant", () => {
  const args = grokBaseArgs({ readOnly: true });
  const idx = args.indexOf("--disallowed-tools");
  assert.notEqual(idx, -1);
  assert.equal(args[idx + 1], READ_ONLY_DISALLOWED_TOOLS);
});

// ============================================================================
// B4 — parseGrokJson uses shared findLastJsonObject (matches stop-gate)
// ============================================================================

test("B4: companion.mjs::parseGrokJson uses findLastJsonObject in slow path", () => {
  const src = fs.readFileSync(COMPANION_PATH, "utf8");
  const start = src.indexOf("function parseGrokJson(");
  assert.ok(start >= 0);
  const slice = src.slice(start, start + 2500);
  assert.match(slice, /findLastJsonObject/,
    "parseGrokJson must use findLastJsonObject in its slow path");
  // Import is at the top.
  assert.match(src, /import\s*\{[^}]*findLastJsonObject[^}]*\}\s*from\s*"\.\/lib\/verdict\.mjs"/);
});

test("B4: findLastJsonObject returns the LAST balanced object", () => {
  const obj = findLastJsonObject(`some preface {"a":1} mid {"b":2} end`);
  assert.deepEqual(obj, { b: 2 });
});

test("B4: findLastJsonObject handles mid-string starts gracefully", () => {
  // Simulate the tail-read case where the buffer starts mid-string.
  const tail = `cated string"} prefix {"text":"real envelope","stopReason":"EndTurn"}`;
  const obj = findLastJsonObject(tail);
  assert.equal(obj.text, "real envelope");
  assert.equal(obj.stopReason, "EndTurn");
});

test("B4: findLastJsonObject returns null on empty/null/non-string", () => {
  assert.equal(findLastJsonObject(""), null);
  assert.equal(findLastJsonObject(null), null);
  assert.equal(findLastJsonObject(undefined), null);
  assert.equal(findLastJsonObject(12345), null);
});

// ============================================================================
// B5 — /grok:result bounded reads (Codex finding)
// ============================================================================

test("B5: companion.mjs::cmdResult uses readBoundedFile with a cap", () => {
  const src = fs.readFileSync(COMPANION_PATH, "utf8");
  assert.match(src, /function readBoundedFile\(/);
  // cmdResult must call readBoundedFile, not fs.readFileSync directly.
  const start = src.indexOf("function cmdResult(");
  assert.ok(start >= 0);
  const slice = src.slice(start, start + 2500);
  assert.match(slice, /readBoundedFile\(safeOut,\s*MAX_REVIEW_JSON_BYTES\)/,
    "cmdResult must bound stdout reads at MAX_REVIEW_JSON_BYTES");
  assert.match(slice, /readBoundedFile\(safeErr,\s*MAX_REVIEW_JSON_BYTES\)/,
    "cmdResult must bound stderr reads at MAX_REVIEW_JSON_BYTES");
});

test("B5: readBoundedFile-like flow truncates with a marker on oversized files", () => {
  // We can't import readBoundedFile (it's private to companion.mjs), but we
  // can assert the truncation marker is part of the implementation so
  // future refactors keep it.
  const src = fs.readFileSync(COMPANION_PATH, "utf8");
  assert.match(src, /\[\.\.\. output truncated by grok-plugin/,
    "readBoundedFile must include a truncation marker in the returned text");
});

// ============================================================================
// B6 — /grok:imagine media-path shell-injection defense (Gemini finding)
// ============================================================================

test("B6: companion.mjs validates media path before generating an `open` hint", () => {
  const src = fs.readFileSync(COMPANION_PATH, "utf8");
  assert.match(src, /function isSafeMediaPath\(/);
  assert.match(src, /SAFE_MEDIA_PATH_PATTERN/);
  // The cmdImagine output path must consult isSafeMediaPath BEFORE writing
  // the open command.
  const start = src.indexOf("async function cmdImagine(");
  assert.ok(start >= 0);
  const slice = src.slice(start, start + 5000);
  assert.match(slice, /isSafeMediaPath\(mediaPath\)/);
});

test("B6: isSafeMediaPath-style regex rejects shell metacharacters", () => {
  // We reproduce the pattern here to test it end-to-end. If the source
  // pattern ever changes, this test will detect drift via the next test.
  const SAFE = /^[A-Za-z0-9._\/\-%@+]+$/;
  // Legitimate Grok output:
  assert.ok(SAFE.test("/Users/me/.grok/sessions/abc%2Fdef/images/1.jpg"));
  assert.ok(SAFE.test("/tmp/grok-out/video.mp4"));
  // Hostile payloads must be rejected:
  for (const bad of [
    '"; rm -rf ~; #',
    "'\"';rm",
    "/tmp/a;ls",
    "/tmp/a|whoami",
    "/tmp/a$(id)",
    "/tmp/a`id`",
    "/tmp/a\nrm /etc",
    "/tmp/a&background"
  ]) {
    assert.equal(SAFE.test(bad), false, `should reject: ${bad}`);
  }
});

test("B6: companion.mjs::SAFE_MEDIA_PATH_PATTERN matches the regex used in the source", () => {
  const src = fs.readFileSync(COMPANION_PATH, "utf8");
  // The exact pattern in companion.mjs must be the conservative
  // alphanumeric+path-chars regex. If a future refactor relaxes it, this
  // test breaks.
  assert.match(src, /SAFE_MEDIA_PATH_PATTERN = \/\^\[A-Za-z0-9\._\\\/\\\-%@\+\]\+\$\//);
});

// ============================================================================
// B7 — review schema/prose alignment + strict validation (Grok finding)
// ============================================================================

test("B7: review prompt severity vocabulary matches the JSON schema", () => {
  const prompt = fs.readFileSync(PROMPT_REVIEW_PATH, "utf8");
  // The four schema severities must each appear in the prompt's finding_bar.
  for (const sev of ["critical", "high", "medium", "low"]) {
    assert.ok(prompt.includes(`**${sev}**`),
      `review prompt must teach the model the **${sev}** severity (matches schema enum)`);
  }
  // The old severities must NOT appear as severity labels.
  for (const oldSev of ["Important", "Nit"]) {
    assert.equal(prompt.includes(`**${oldSev}**`), false,
      `review prompt must not still use the old **${oldSev}** label`);
  }
});

test("B7: strict review-schema validator enforces severity enum on findings", () => {
  // We can't import the private validator, but we can assert the constants
  // it uses are present and complete.
  const src = fs.readFileSync(COMPANION_PATH, "utf8");
  assert.match(src, /const SCHEMA_SEVERITIES = new Set\(\["critical", "high", "medium", "low"\]\)/);
  assert.match(src, /SCHEMA_MAX_STRING_BYTES/);
  assert.match(src, /SCHEMA_MAX_ARRAY_LEN/);
  // The strict validator must be the active export name in the rest of the file.
  assert.match(src, /function validateReviewSchema\(obj\)/);
});

// ============================================================================
// B8 — isAlive EPERM handling (Gemini finding)
// ============================================================================

test("B8: isAlive(pid) treats EPERM as `not our process anymore` (returns false)", () => {
  // We can't easily synthesize an EPERM PID in tests, but we CAN assert
  // the source-level contract: the catch clause for EPERM returns false,
  // not true.
  const src = fs.readFileSync(
    new URL("../plugins/grok/scripts/lib/process.mjs", import.meta.url).pathname,
    "utf8"
  );
  // The fix: the EPERM branch must return false.
  const m = src.match(/if \(e && e\.code === "EPERM"\) return (\w+);/);
  assert.ok(m, "process.mjs must have an EPERM branch in isAlive");
  assert.equal(m[1], "false", `EPERM branch must return false, found return ${m[1]}`);
});

test("B8: isAlive(process.pid) still returns true for our own PID", () => {
  // The normal case stays correct.
  assert.equal(isAlive(process.pid), true);
});

test("B8: isAlive rejects PID 0 and PID 1 (regression)", () => {
  // These are not new but pinning them keeps the safety guard.
  assert.equal(isAlive(0), false);
  assert.equal(isAlive(1), false);
});
