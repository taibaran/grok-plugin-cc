#!/usr/bin/env node
// Stop-time review gate for Grok Companion.
//
// Activated only when /grok:setup --enable-review-gate has been run for the
// workspace identified by the hook's `cwd` field. On Stop, it asks Grok
// whether the previous Claude turn actually shipped code changes and, if so,
// whether they should ship.
//
// Returns hook JSON in Claude Code's Stop-hook format:
//   (no output / empty)              -> allow stop (default)
//   { "decision": "block", "reason": "..." } -> block stop; reason shown to model
//
// Failure modes (grok missing, auth missing, parse error, timeout) all fall
// through as "allow" -- the review gate is a soft suggestion gate, not a CI
// blocker. A broken Grok install must not strand the user.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

import { readConfig } from "./lib/state.mjs";
import { which, classifyAuthBlob, grokBaseArgs, cleanGrokEnv } from "./lib/grok.mjs";
import { captureDiff } from "./lib/git.mjs";
import { buildStopGatePrompt } from "./lib/prompts.mjs";
import { parseVerdict, findBalancedJsonEnd } from "./lib/verdict.mjs";
import { terminateProcessTree } from "./lib/process.mjs";
import { sanitizeForTerminal } from "./lib/render.mjs";

const HOOK_TIMEOUT_MS = 12 * 60 * 1000;

// Strict mode: instead of fail-open on infrastructure errors (grok missing,
// auth failed, timeout, parse error), block the stop with an explanatory
// reason. Off by default. Opt in by setting GROK_REVIEW_GATE_STRICT=1.
const STRICT = process.env.GROK_REVIEW_GATE_STRICT === "1";

// Each of these helpers terminates the process. They are also the only
// callers of `process.exit` in this file, so once they fire the function
// flow ends. Tests sometimes mock `process.exit` to inspect the verdict
// without killing the test process — in that case the callers MUST also
// `return` after invoking these, otherwise execution falls through and the
// hook can emit two contradictory verdicts. We mark the helpers as
// `process.exit` callers AND defensively `return` after each call site.
function emitAllow(reason = "") {
  if (reason) {
    process.stdout.write(JSON.stringify({ systemMessage: `grok-plugin: ${reason}` }) + "\n");
  }
  process.exit(0);
}

function emitBlock(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
  process.exit(0);
}

function emitInfraFailure(reason) {
  if (STRICT) {
    emitBlock(`Grok review gate (strict): ${reason}`);
    return;
  }
  emitAllow(reason);
}

function readStdinSync() {
  try { return fs.readFileSync(0, "utf8"); }
  catch { return ""; }
}

function resolveHookCwd(hookInput) {
  try {
    const parsed = JSON.parse(hookInput || "{}");
    if (typeof parsed.cwd === "string" && parsed.cwd) return parsed.cwd;
  } catch {}
  return process.cwd();
}

function extractClaudeResponse(hookInput) {
  try {
    const parsed = JSON.parse(hookInput || "{}");
    return parsed.last_message || parsed.transcript_snippet || "";
  } catch {
    return "";
  }
}

// Retry on EEXIST mirrors companion.mjs::writePromptToTempFile — the 48-bit
// random suffix is not collision-free under concurrent hook activity.
function writePromptToTempFile(prompt) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const p = path.join(os.tmpdir(), `grok-gate-${Date.now()}-${randomBytes(12).toString("hex")}.txt`);
    let fd;
    try { fd = fs.openSync(p, "wx", 0o600); }
    catch (e) {
      if (e && e.code === "EEXIST") continue;
      throw e;
    }
    try { fs.writeSync(fd, prompt); }
    finally { fs.closeSync(fd); }
    return p;
  }
  throw new Error("writePromptToTempFile: exhausted retries");
}

function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch {}
}

// Extract Grok's `--output-format json` envelope from raw stdout.
//
// Two layers of defense:
//   1. ANSI / OSC / DCS / C0 stripping (`sanitizeForTerminal`). Grok can
//      leak colored tracing lines into stdout under some terminal
//      configurations; JSON.parse rejects any non-JSON prefix, and a
//      silent parse failure flips the gate to fail-open ("allow").
//   2. LAST-balanced-object extraction. We do NOT call `JSON.parse(clean)`
//      on the whole blob — Grok's stdout often contains streaming `thought`
//      text BEFORE the final envelope, and (after the v0.3.0 round-2 fix
//      to `readBoundedStdout`) we may even be looking at a tail that starts
//      mid-string. The envelope is by contract the FINAL JSON object Grok
//      emits, so we scan for ALL balanced JSON objects and return the
//      last one that parses cleanly. This defends against:
//        - prefix noise (tracing lines, thought streams)
//        - mid-string starts (tail reads)
//        - any model-emitted-JSON-before-the-final-envelope
function parseGrokJsonEnvelope(raw) {
  if (!raw) return null;
  const clean = sanitizeForTerminal(raw).trim();
  if (!clean) return null;
  // Fast path: the common case is the whole blob IS the envelope, no noise.
  try {
    const parsed = JSON.parse(clean);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {}
  // Slow path: scan for the last balanced JSON object in the cleaned blob.
  let last = null;
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] !== "{") continue;
    const end = findBalancedJsonEnd(clean, i);
    if (end < 0) continue;
    try {
      const parsed = JSON.parse(clean.slice(i, end + 1));
      if (parsed && typeof parsed === "object") last = parsed;
    } catch {}
    i = end;
  }
  return last;
}

// Same temp-file pattern as the prompt file. The grok stdout could be
// several MB if it streams thoughts before the final JSON envelope, so we
// write to disk and re-read at close — the previous "outBuf capped at 256 KiB"
// design silently failed open whenever the verdict landed past the cap.
function openStdoutTempFile() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const p = path.join(os.tmpdir(), `grok-gate-stdout-${Date.now()}-${randomBytes(12).toString("hex")}.log`);
    let fd;
    try { fd = fs.openSync(p, "wx", 0o600); }
    catch (e) {
      if (e && e.code === "EEXIST") continue;
      throw e;
    }
    return { fd, path: p };
  }
  throw new Error("openStdoutTempFile: exhausted retries");
}

// Hard cap on how much of the stdout file we will read back into memory for
// JSON parsing. The on-disk file itself is uncapped (so the raw bytes are
// available for postmortem) but JSON.parse on a multi-GB string would OOM
// the hook. Aligned with companion.mjs::MAX_REVIEW_JSON_BYTES.
const MAX_GATE_STDOUT_PARSE_BYTES = 8 * 1024 * 1024;

// Bounded stderr buffer is fine — stderr only carries auth/error hints we
// classify, not the JSON verdict. 256 KiB is plenty for any realistic
// error message.
const MAX_GATE_STDERR_BUF = 256 * 1024;

// Read up to MAX_GATE_STDOUT_PARSE_BYTES of the stdout temp file, taking the
// TAIL of the file when it is larger than the cap.
//
// Why the tail and not the head: Grok streams its `thought` field before
// the final JSON envelope, so the verdict-bearing object is at the END of
// stdout. The old "read first 8 MiB" design dropped the envelope entirely
// for any run that wedged > 8 MiB of thinking text before it — exactly the
// pathological runs the gate is supposed to catch.
//
// Reading the tail can land mid-string (the cut point isn't necessarily a
// JSON boundary). parseGrokJsonEnvelope handles this by scanning for the
// LAST balanced JSON object in the read buffer rather than parsing the
// whole thing as one blob, so a partial JSON prefix at the start of the
// tail does not break the verdict extraction.
function readBoundedStdout(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); }
  catch { return ""; }
  if (stat.size === 0) return "";
  const size = Math.min(stat.size, MAX_GATE_STDOUT_PARSE_BYTES);
  const position = Math.max(0, stat.size - size);
  const buf = Buffer.alloc(size);
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    fs.readSync(fd, buf, 0, size, position);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  return buf.toString("utf8");
}

function main() {
  const hookInput = readStdinSync();
  const cwd = resolveHookCwd(hookInput);

  const cfg = readConfig(cwd);
  if (!cfg.reviewGateEnabled) {
    emitAllow();
    return;
  }
  if (!which("grok")) {
    emitInfraFailure("grok not installed - review gate skipped");
    return;
  }

  const claudeResponse = extractClaudeResponse(hookInput);

  const diffResult = captureDiff({ scope: "auto", cwd });
  if (!diffResult.diff || !diffResult.diff.trim()) {
    emitAllow("no code changes detected in last turn");
    return;
  }

  const prompt = buildStopGatePrompt({ claudeResponse, diff: diffResult.diff });
  const promptFile = writePromptToTempFile(prompt);

  // Tee stdout to a temp file so we can read the full envelope on close,
  // not just the first 256 KiB. Without this, a Grok run that emits a long
  // `thought` stream before its final JSON object would truncate at the
  // buffer cap, parseGrokJsonEnvelope returns null, and the gate silently
  // emits "allow" — defeating the gate's purpose for the cases it is
  // supposed to catch.
  //
  // If allocating the stdout temp file fails (out-of-space, /tmp permission
  // problem) we must unlink the promptFile we just allocated. Without this
  // try/catch, a thrown openStdoutTempFile leaks promptFile under /tmp.
  let stdoutFd, stdoutPath;
  try {
    ({ fd: stdoutFd, path: stdoutPath } = openStdoutTempFile());
  } catch (err) {
    safeUnlink(promptFile);
    throw err;
  }

  // Centralized cleanup. Called from BOTH proc.on("close") and
  // proc.on("error"); the error path used to skip closing stdoutFd and
  // unlinking stdoutPath, leaking a file descriptor and a temp file every
  // time the spawn failed.
  let cleanedUp = false;
  function cleanupResources() {
    if (cleanedUp) return;
    cleanedUp = true;
    try { fs.closeSync(stdoutFd); } catch {}
    safeUnlink(promptFile);
    safeUnlink(stdoutPath);
  }

  let errBuf = "";
  let timedOut = false;

  // Request JSON output to make the verdict shape robust; max-turns guards
  // against runaway agent loops chewing through the hook budget. Thread the
  // hook's cwd into the arg builder so workspace-scoped model overrides
  // resolve against the actual project, not whatever cwd Claude Code spawned
  // this hook from.
  const args = ["--prompt-file", promptFile, ...grokBaseArgs({ readOnly: true, jsonOutput: true, cwd }), "--max-turns", "20"];

  const proc = spawn("grok", args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    cwd,
    env: cleanGrokEnv()
  });

  proc.stdout.on("data", d => {
    try { fs.writeSync(stdoutFd, d); } catch {}
  });
  proc.stderr.on("data", d => {
    if (errBuf.length < MAX_GATE_STDERR_BUF) {
      errBuf += d.toString().slice(0, MAX_GATE_STDERR_BUF - errBuf.length);
    }
  });

  const timer = setTimeout(() => {
    timedOut = true;
    terminateProcessTree(proc.pid).catch(() => {});
  }, HOOK_TIMEOUT_MS);

  proc.on("close", code => {
    clearTimeout(timer);

    // Read the on-disk stdout BEFORE the centralized cleanup unlinks it.
    // The order matters: closeSync must come first (so writes are flushed),
    // then read, then unlink. cleanupResources handles closeSync + unlink
    // of both promptFile and stdoutPath in one place.
    try { fs.closeSync(stdoutFd); } catch {}
    const stdoutContent = readBoundedStdout(stdoutPath);
    safeUnlink(promptFile);
    safeUnlink(stdoutPath);
    cleanedUp = true;

    if (timedOut) {
      emitInfraFailure("review gate timed out");
      return;
    }
    const why = classifyAuthBlob(stdoutContent + "\n" + errBuf);
    if (why) {
      emitInfraFailure(`review gate skipped (${why})`);
      return;
    }
    // Grok returns exit 0 even on internal error; check for the error envelope.
    const envelope = parseGrokJsonEnvelope(stdoutContent);
    if (envelope && envelope.type === "error") {
      emitInfraFailure(`review gate skipped (grok internal error: ${envelope.message})`);
      return;
    }
    if (code !== 0) {
      emitInfraFailure(`review gate skipped (grok exit ${code})`);
      return;
    }
    // Extract the inner text from the JSON envelope, then parse the verdict
    // out of it. We accept a bare JSON or a ```json fenced block.
    const innerText = envelope && typeof envelope.text === "string" ? envelope.text : stdoutContent;
    const verdict = parseVerdict(innerText);
    if (!verdict) {
      emitInfraFailure(`review gate verdict unparseable (raw: ${(innerText || "").trim().slice(0, 80)})`);
      return;
    }
    if (verdict.decision === "block") {
      emitBlock(`Grok review gate blocked stop: ${verdict.reason || "(no reason supplied)"}`);
      return;
    }
    emitAllow(verdict.reason || "review gate allowed");
    return;
  });

  proc.on("error", err => {
    clearTimeout(timer);
    // Spawn-error path: stdoutFd may still be open and stdoutPath / promptFile
    // both exist. The previous version only unlinked promptFile, leaking the
    // stdout fd + temp file every time the spawn failed (rare but real, e.g.
    // ENOENT if grok disappears between which() and spawn(), or EMFILE under
    // fd exhaustion).
    cleanupResources();
    emitInfraFailure(`review gate error: ${err.message}`);
  });
}

try {
  main();
} catch (err) {
  process.stderr.write(`stop-review-gate-hook fatal: ${err.message}\n`);
  emitInfraFailure(`review gate fatal error: ${err.message}`);
}
