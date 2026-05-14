// Regression test for the Gemini-flagged ANSI-before-JSON.parse issue.
//
// Grok's stdout is normally clean JSON when --output-format json is set, but
// its Rust tracing layer can leak colored log lines into stdout under certain
// terminal configurations. JSON.parse rejects any non-JSON prefix, so a
// single stray escape sequence would silently flip an error envelope to
// "unknown" — which the close handler then treats as a generic exit-0
// success and marks the job `completed`.
//
// We can't import the private `parseGrokJson` from companion.mjs (it's
// internal). The test instead asserts the source-level wiring: the
// sanitizer is called before JSON.parse.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const COMPANION_PATH = new URL("../plugins/grok/scripts/companion.mjs", import.meta.url).pathname;
const STOP_GATE_PATH = new URL("../plugins/grok/scripts/stop-review-gate-hook.mjs", import.meta.url).pathname;

test("companion.mjs parseGrokJson sanitizes before JSON.parse", () => {
  const src = fs.readFileSync(COMPANION_PATH, "utf8");
  // The function must (a) call sanitizeForTerminal and (b) feed the cleaned
  // string into JSON.parse, not the raw blob.
  assert.match(src, /function parseGrokJson\(/);
  // Look for sanitizeForTerminal usage WITHIN ~30 lines of parseGrokJson.
  const start = src.indexOf("function parseGrokJson(");
  assert.ok(start >= 0, "parseGrokJson must exist");
  const slice = src.slice(start, start + 2000);
  assert.match(slice, /sanitizeForTerminal\(raw\)/,
    "parseGrokJson must call sanitizeForTerminal(raw) before parsing");
  assert.match(slice, /JSON\.parse\(\s*clean\s*\)/,
    "parseGrokJson must JSON.parse the sanitized `clean` value, not raw");
});

test("stop-review-gate-hook.mjs parseGrokJsonEnvelope sanitizes before JSON.parse", () => {
  const src = fs.readFileSync(STOP_GATE_PATH, "utf8");
  assert.match(src, /function parseGrokJsonEnvelope\(/);
  const start = src.indexOf("function parseGrokJsonEnvelope(");
  assert.ok(start >= 0);
  const slice = src.slice(start, start + 2000);
  assert.match(slice, /sanitizeForTerminal\(raw\)/);
  assert.match(slice, /JSON\.parse\(\s*clean\s*\)/);
});

test("stop-review-gate-hook.mjs writes stdout to a temp file and re-reads at close", () => {
  // Regression for Gemini's truncation-fail-open bug. The previous version
  // capped stdout at MAX_HOOK_BUF (256 KiB) in memory; if the verdict
  // landed after that cap, parsing failed silently and the gate emitted
  // "allow" by default. The fix tees stdout to disk and reads back the
  // full file (bounded by MAX_GATE_STDOUT_PARSE_BYTES = 8 MiB) for parse.
  const src = fs.readFileSync(STOP_GATE_PATH, "utf8");
  assert.match(src, /openStdoutTempFile/,
    "stop-gate must open a temp file for stdout capture");
  assert.match(src, /readBoundedStdout/,
    "stop-gate must read the stdout file back via readBoundedStdout");
  // Ensure the parse uses the on-disk content, not a 256-KiB in-memory buffer.
  assert.match(src, /parseGrokJsonEnvelope\(stdoutContent\)/);
});

test("stop-review-gate-hook.mjs imports sanitizeForTerminal", () => {
  const src = fs.readFileSync(STOP_GATE_PATH, "utf8");
  // If a future refactor drops the sanitizer import, the parseGrokJsonEnvelope
  // call becomes a ReferenceError at hook runtime. Lock it down with a test.
  assert.match(src, /import \{[^}]*sanitizeForTerminal[^}]*\} from "\.\/lib\/render\.mjs"/);
});
