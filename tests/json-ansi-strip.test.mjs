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

test("lib/grok.mjs parseGrokJson sanitizes before JSON.parse", () => {
  // v0.5.0 moved parseGrokJson from companion.mjs to lib/grok.mjs.
  const GROK_LIB_PATH = new URL("../plugins/grok/scripts/lib/grok.mjs", import.meta.url).pathname;
  const src = fs.readFileSync(GROK_LIB_PATH, "utf8");
  assert.match(src, /export function parseGrokJson\(/);
  const start = src.indexOf("export function parseGrokJson(");
  assert.ok(start >= 0, "parseGrokJson must exist in lib/grok.mjs");
  const slice = src.slice(start, start + 2000);
  assert.match(slice, /sanitizeForTerminal\(raw\)/,
    "parseGrokJson must call sanitizeForTerminal(raw) before parsing");
  assert.match(slice, /JSON\.parse\(clean\)/,
    "parseGrokJson must JSON.parse the sanitized `clean` value, not raw");
});

test("stop-review-gate-hook.mjs uses shared parseGrokJson (which already sanitizes)", () => {
  // v0.5.0 removed the local parseGrokJsonEnvelope. Stop-gate now uses
  // the shared parseGrokJson from lib/grok.mjs, which has the
  // sanitize-before-parse defense built in. We assert the import + call.
  const src = fs.readFileSync(STOP_GATE_PATH, "utf8");
  assert.match(src, /parseGrokJson/);
  assert.match(src, /import\s*\{[^}]*parseGrokJson[^}]*\}\s*from\s*"\.\/lib\/grok\.mjs"/);
});

test("stop-review-gate-hook.mjs writes stdout to a temp file and re-reads at close", () => {
  // Regression for Gemini's truncation-fail-open bug. The fix tees
  // stdout to disk and reads back the full file (bounded by
  // MAX_GATE_STDOUT_PARSE_BYTES = 8 MiB) for parse.
  const src = fs.readFileSync(STOP_GATE_PATH, "utf8");
  assert.match(src, /openStdoutTempFile/);
  assert.match(src, /readBoundedStdout/);
  // After v0.5.0 unification, parsing goes through the shared parseGrokJson.
  assert.match(src, /parseGrokJson\(stdoutContent\)/);
});

test("stop-review-gate-hook.mjs imports parseGrokJson from lib/grok.mjs", () => {
  // v0.5.0: the local parseGrokJsonEnvelope was removed and replaced
  // by the shared lib/grok.mjs::parseGrokJson, which carries the
  // sanitizer + last-balanced-object defenses we previously duplicated.
  const src = fs.readFileSync(STOP_GATE_PATH, "utf8");
  assert.match(src, /import \{[^}]*parseGrokJson[^}]*\} from "\.\/lib\/grok\.mjs"/);
});

test("stop-review-gate-hook.mjs cleans up promptFile if openStdoutTempFile throws (Grok-flagged leak)", () => {
  // Regression for the resource-leak path Grok flagged on v0.3.0 round 2:
  // if `openStdoutTempFile()` throws after `writePromptToTempFile()`
  // succeeds, the prompt file would linger under /tmp forever. The fix
  // wraps openStdoutTempFile in try/catch and unlinks promptFile on throw.
  const src = fs.readFileSync(STOP_GATE_PATH, "utf8");

  // Find the CALL site (`= openStdoutTempFile()` inside a destructure),
  // not the function declaration at the top of the file. The call site
  // must be inside a try block whose catch unlinks promptFile.
  const callMatch = src.match(/=\s*openStdoutTempFile\(\)/);
  assert.ok(callMatch, "stop-gate hook must call openStdoutTempFile() somewhere");
  const callIdx = callMatch.index;
  const context = src.slice(Math.max(0, callIdx - 200), callIdx + 400);
  assert.match(context, /try\s*\{/,
    "openStdoutTempFile call site must be inside a try block");
  assert.match(context, /safeUnlink\(promptFile\)/,
    "the surrounding scope must unlink promptFile when openStdoutTempFile throws");
});

test("stop-review-gate-hook.mjs uses cleanupResources() in proc.on('error') (Grok-flagged leak)", () => {
  // The error path used to only unlink promptFile and never close
  // stdoutFd / unlink stdoutPath — leaking a file descriptor and a temp
  // file every time `grok` failed to spawn (e.g. ENOENT, EMFILE).
  const src = fs.readFileSync(STOP_GATE_PATH, "utf8");
  assert.match(src, /function cleanupResources\(\)/,
    "cleanupResources helper must exist to centralize fd/file teardown");
  // Find the proc.on("error", ...) handler block and confirm it calls
  // cleanupResources before emitting infra failure.
  const errIdx = src.indexOf("proc.on(\"error\"");
  assert.ok(errIdx >= 0);
  const errBlock = src.slice(errIdx, errIdx + 800);
  assert.match(errBlock, /cleanupResources\(\)/,
    "the proc.on('error') handler must call cleanupResources()");
});
