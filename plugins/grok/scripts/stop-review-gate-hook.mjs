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

function parseGrokJsonEnvelope(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed && typeof parsed === "object") return parsed;
  } catch {}
  return null;
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

  let outBuf = "";
  let errBuf = "";
  let timedOut = false;

  // Hard cap on hook buffers. The verdict JSON is tiny — a runaway Grok
  // process emitting GBs of output during the 12-min hook window would
  // otherwise OOM Node and kill the Stop hook entirely.
  const MAX_HOOK_BUF = 256 * 1024;

  // Request JSON output to make the verdict shape robust; max-turns guards
  // against runaway agent loops chewing through the hook budget.
  const args = ["--prompt-file", promptFile, ...grokBaseArgs({ readOnly: true, jsonOutput: true }), "--max-turns", "20"];

  const proc = spawn("grok", args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    cwd,
    env: cleanGrokEnv()
  });

  proc.stdout.on("data", d => {
    if (outBuf.length < MAX_HOOK_BUF) {
      outBuf += d.toString().slice(0, MAX_HOOK_BUF - outBuf.length);
    }
  });
  proc.stderr.on("data", d => {
    if (errBuf.length < MAX_HOOK_BUF) {
      errBuf += d.toString().slice(0, MAX_HOOK_BUF - errBuf.length);
    }
  });

  const timer = setTimeout(() => {
    timedOut = true;
    terminateProcessTree(proc.pid).catch(() => {});
  }, HOOK_TIMEOUT_MS);

  proc.on("close", code => {
    clearTimeout(timer);
    safeUnlink(promptFile);

    if (timedOut) {
      emitInfraFailure("review gate timed out");
      return;
    }
    const why = classifyAuthBlob(outBuf + "\n" + errBuf);
    if (why) {
      emitInfraFailure(`review gate skipped (${why})`);
      return;
    }
    // Grok returns exit 0 even on internal error; check for the error envelope.
    const envelope = parseGrokJsonEnvelope(outBuf);
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
    const innerText = envelope && typeof envelope.text === "string" ? envelope.text : outBuf;
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
