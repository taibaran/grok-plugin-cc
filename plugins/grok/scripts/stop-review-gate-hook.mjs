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
import { parseVerdict } from "./lib/verdict.mjs";
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

// Strip ANSI / OSC / DCS / C0 noise before attempting JSON parse. Grok can
// leak colored tracing lines into stdout under some terminal configurations;
// JSON.parse rejects any non-JSON prefix, and a silent parse failure here
// flips the gate to fail-open ("allow"). Sanitize first to match how
// companion.mjs::parseGrokJson handles the same envelope shape.
function parseGrokJsonEnvelope(raw) {
  if (!raw) return null;
  const clean = sanitizeForTerminal(raw).trim();
  if (!clean) return null;
  try {
    const parsed = JSON.parse(clean);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {}
  return null;
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

function readBoundedStdout(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); }
  catch { return ""; }
  // Truncate explicitly — reading the first N bytes of a too-large file is
  // better than refusing entirely. The verdict envelope is at the END of
  // the file, but if a runaway Grok wedged 2 GB of thinking before that
  // we cannot recover the verdict anyway; surfacing the truncated prefix
  // for diagnostics is the least-bad option.
  const size = Math.min(stat.size, MAX_GATE_STDOUT_PARSE_BYTES);
  if (size === 0) return "";
  const buf = Buffer.alloc(size);
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    fs.readSync(fd, buf, 0, size, 0);
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
  const { fd: stdoutFd, path: stdoutPath } = openStdoutTempFile();
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
    try { fs.closeSync(stdoutFd); } catch {}
    safeUnlink(promptFile);

    // Read the full captured stdout (bounded) for the envelope parse. The
    // on-disk file is unlinked at the end so we don't leave per-hook
    // stdout litter under /tmp.
    const stdoutContent = readBoundedStdout(stdoutPath);
    safeUnlink(stdoutPath);

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
    safeUnlink(promptFile);
    emitInfraFailure(`review gate error: ${err.message}`);
  });
}

try {
  main();
} catch (err) {
  process.stderr.write(`stop-review-gate-hook fatal: ${err.message}\n`);
  emitInfraFailure(`review gate fatal error: ${err.message}`);
}
