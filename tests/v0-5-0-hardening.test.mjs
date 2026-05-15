// Regression tests for the v0.5.0 hardening fixes.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseVerdict } from "../plugins/grok/scripts/lib/verdict.mjs";
import { TerminalSanitizer, MAX_PENDING_ESCAPE_BYTES } from "../plugins/grok/scripts/lib/render.mjs";
import { readBoundedJobLog, jobsDir, PLUGIN_DATA_ENV, MAX_JOB_LOG_READ_BYTES } from "../plugins/grok/scripts/lib/state.mjs";
import { parseGrokJson, writePromptToTempFile } from "../plugins/grok/scripts/lib/grok.mjs";

const COMPANION_PATH = new URL("../plugins/grok/scripts/companion.mjs", import.meta.url).pathname;

// ============================================================================
// C1 — findLastVerdictInString failed-scan cap (Codex round-7)
// ============================================================================

test("C1: parseVerdict survives pathological N-`{` input in bounded time", () => {
  // The verdict scanner inside parseVerdict (findLastVerdictInString) had
  // the same O(n²) shape as findLastJsonObject before this fix. Wall of
  // `{` chars with no `}` would have caused N independent scans-to-EOF.
  const wall = "{".repeat(4 * 1024);
  const t0 = Date.now();
  const result = parseVerdict(wall);
  const dt = Date.now() - t0;
  assert.equal(result, null, "no verdict in a wall of `{` chars");
  assert.ok(dt < 1000, `must complete in <1s, took ${dt}ms`);
});

test("C1: parseVerdict still finds a real verdict after partial-JSON noise", () => {
  // 20 unbalanced fragments before the real verdict — well below the
  // 128-failure cap. Must still find it.
  const noise = Array.from({ length: 20 }, (_, i) => `{partial${i}`).join(" ");
  const v = parseVerdict(`${noise}\n{"decision":"allow","reason":"clean"}`);
  assert.deepEqual(v, { decision: "allow", reason: "clean" });
});

// ============================================================================
// C2 — Disk exhaustion via unbounded job logs (Gemini round-7)
// ============================================================================

test("C2: companion.mjs caps on-disk job log at MAX_JOB_LOG_BYTES", () => {
  const src = fs.readFileSync(COMPANION_PATH, "utf8");
  assert.match(src, /MAX_JOB_LOG_BYTES\s*=\s*500\s*\*\s*1024\s*\*\s*1024/);
  // runJob must track stdoutBytes + stderrBytes against the cap and
  // call tripDiskOverflow when exceeded.
  assert.match(src, /tripDiskOverflow/);
  // The disk-overflow status must be preserved by the close handler
  // (alongside cancelled and timed-out, so the close exit code doesn't
  // race-overwrite the sticky status).
  assert.match(src, /current\.status === "cancelled" \|\| current\.status === "timed-out" \|\| current\.status === "disk-overflow"/);
});

// ============================================================================
// C3 — TOCTOU-safe readBoundedJobLog (Gemini round-7)
// ============================================================================

test("C3: readBoundedJobLog returns null for paths outside jobsDir", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-c3-test-"));
  const prev = process.env[PLUGIN_DATA_ENV];
  process.env[PLUGIN_DATA_ENV] = dir;
  try {
    // /etc/hosts is outside jobsDir for sure.
    assert.equal(readBoundedJobLog("/etc/hosts"), null);
  } finally {
    if (prev === undefined) delete process.env[PLUGIN_DATA_ENV];
    else process.env[PLUGIN_DATA_ENV] = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("C3: readBoundedJobLog reads a regular file under jobsDir", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-c3-test-"));
  const prev = process.env[PLUGIN_DATA_ENV];
  process.env[PLUGIN_DATA_ENV] = root;
  try {
    const jobs = jobsDir();
    fs.mkdirSync(jobs, { recursive: true });
    const f = path.join(jobs, "x-test-0001.stdout.log");
    fs.writeFileSync(f, "hello world");
    const text = readBoundedJobLog(f);
    assert.equal(text, "hello world");
  } finally {
    if (prev === undefined) delete process.env[PLUGIN_DATA_ENV];
    else process.env[PLUGIN_DATA_ENV] = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("C3: readBoundedJobLog refuses a symlink leaf (O_NOFOLLOW)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-c3-test-"));
  const prev = process.env[PLUGIN_DATA_ENV];
  process.env[PLUGIN_DATA_ENV] = root;
  try {
    const jobs = jobsDir();
    fs.mkdirSync(jobs, { recursive: true });
    // Plant a symlink to /etc/hosts inside jobsDir. With O_NOFOLLOW the
    // open() syscall fails with ELOOP and readBoundedJobLog returns null.
    const link = path.join(jobs, "x-evil-0001.stdout.log");
    fs.symlinkSync("/etc/hosts", link);
    const text = readBoundedJobLog(link);
    assert.equal(text, null,
      "O_NOFOLLOW must reject a symlink leaf — got non-null, possible /etc/hosts leak");
  } finally {
    if (prev === undefined) delete process.env[PLUGIN_DATA_ENV];
    else process.env[PLUGIN_DATA_ENV] = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("C3: readBoundedJobLog truncates oversized files with a marker", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-c3-test-"));
  const prev = process.env[PLUGIN_DATA_ENV];
  process.env[PLUGIN_DATA_ENV] = root;
  try {
    const jobs = jobsDir();
    fs.mkdirSync(jobs, { recursive: true });
    const f = path.join(jobs, "x-big-0001.stdout.log");
    // Write 16 KiB; read with a 4 KiB cap.
    fs.writeFileSync(f, "A".repeat(16 * 1024));
    const text = readBoundedJobLog(f, undefined, 4 * 1024);
    assert.ok(text.length > 4 * 1024, "output should include truncation marker");
    assert.match(text, /output truncated by grok-plugin/);
  } finally {
    if (prev === undefined) delete process.env[PLUGIN_DATA_ENV];
    else process.env[PLUGIN_DATA_ENV] = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// C4 — TerminalSanitizer pending-buffer cap (Gemini round-7)
// ============================================================================

test("C4: TerminalSanitizer rejects an unterminated ANSI longer than the cap", () => {
  const sanitizer = new TerminalSanitizer();
  // Build a 16 KiB-long unterminated CSI sequence: ESC [ followed by
  // thousands of digits with no final letter. Without the cap, this
  // would grow `this.pending` without bound and OOM the Node process.
  const longUnterminated = "\x1b[" + "1".repeat(16 * 1024);
  const out = sanitizer.push(longUnterminated);
  // The over-long tail must NOT be retained as pending — flush should
  // produce empty (any partial sequence is dropped).
  const flushed = sanitizer.flush();
  assert.equal(flushed, "", "flushed pending buffer must be empty after cap trip");
  // The visible output should not include the unterminated bytes
  // (sanitize() strips the ESC byte under the C0 fallback and the
  // remaining digits are inert).
  assert.ok(out.length < longUnterminated.length,
    "output must be shorter than the malicious input after the cap trips");
});

test("C4: TerminalSanitizer MAX_PENDING_ESCAPE_BYTES is exported and >= 256", () => {
  // The cap must be exported so callers (and tests) can rely on the
  // documented contract. 256 bytes is the absolute minimum; we picked
  // 4 KiB for production margin.
  assert.ok(typeof MAX_PENDING_ESCAPE_BYTES === "number");
  assert.ok(MAX_PENDING_ESCAPE_BYTES >= 256);
});

// ============================================================================
// C5 — Task default timeout is now bounded
// ============================================================================

test("C5: DEFAULT_TASK_TIMEOUT_MS is finite (2h backstop, was 0/unbounded)", () => {
  const src = fs.readFileSync(COMPANION_PATH, "utf8");
  assert.match(src, /DEFAULT_TASK_TIMEOUT_MS\s*=\s*2\s*\*\s*60\s*\*\s*60\s*\*\s*1000/,
    "task timeout default must be 2h");
});

// ============================================================================
// C6 — Helper extraction to lib/grok.mjs
// ============================================================================

test("C6: parseGrokJson and writePromptToTempFile are now importable from lib/grok.mjs", () => {
  // Verify the import surface — these used to be private to companion.mjs
  // and stop-review-gate-hook.mjs (each had its own copy). v0.5.0 made
  // them shared exports so behavior tests can call them directly.
  assert.equal(typeof parseGrokJson, "function");
  assert.equal(typeof writePromptToTempFile, "function");
});

test("C6: parseGrokJson handles { kind: 'text' } envelope shape", () => {
  // Behavior test (not source-shape) — exercises the exported function.
  const out = parseGrokJson('{"text":"hello","stopReason":"EndTurn","sessionId":"abc"}');
  assert.equal(out.kind, "text");
  assert.equal(out.text, "hello");
  assert.equal(out.sessionId, "abc");
});

test("C6: parseGrokJson handles { type: 'error' } envelope shape", () => {
  const out = parseGrokJson('{"type":"error","message":"quota exhausted"}');
  assert.equal(out.kind, "error");
  assert.equal(out.message, "quota exhausted");
});

test("C6: parseGrokJson returns kind: 'unknown' on garbage", () => {
  assert.equal(parseGrokJson("").kind, "unknown");
  assert.equal(parseGrokJson("not json at all").kind, "unknown");
  assert.equal(parseGrokJson('{"unrelated":"thing"}').kind, "unknown");
});

test("C6: writePromptToTempFile creates a unique file with O_EXCL", () => {
  const p1 = writePromptToTempFile("prompt one", "grok-c6-test");
  const p2 = writePromptToTempFile("prompt two", "grok-c6-test");
  assert.notEqual(p1, p2, "two calls must produce distinct paths");
  try {
    assert.equal(fs.readFileSync(p1, "utf8"), "prompt one");
    assert.equal(fs.readFileSync(p2, "utf8"), "prompt two");
  } finally {
    try { fs.unlinkSync(p1); } catch {}
    try { fs.unlinkSync(p2); } catch {}
  }
});
