#!/usr/bin/env node
// Grok Companion — slim dispatcher.
// Subcommands: setup | ask | review | adversarial-review | task | status | result | cancel | purge
//
// Heavy lifting lives in scripts/lib/ — this file just routes.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import { parseArgs, COMMON_BOOL_FLAGS, COMMON_VALUE_FLAGS, parseDuration } from "./lib/args.mjs";
import {
  ensureDir, jobsDir, newJobId,
  writeJobMeta, readJobMeta, listJobs, pruneJobs,
  readConfig, setReviewGate, safeJobLogPath, purgeJobs, setActiveModel
} from "./lib/state.mjs";
import { isAlive, terminateProcessTree } from "./lib/process.mjs";
import { captureDiff } from "./lib/git.mjs";
import {
  which, grokVersion, classifyAuthBlob,
  detectAuthSource, grokBaseArgs, effectiveModel, DEFAULT_MODEL,
  cleanGrokEnv, probeWithFallback, checkMinVersion, MIN_GROK_VERSION,
  MODEL_FALLBACK_CHAIN, capabilityProbe
} from "./lib/grok.mjs";
import { buildReviewPrompt } from "./lib/prompts.mjs";
import { renderJobTable, renderJobDetails, fmtTime, TerminalSanitizer, sanitizeForTerminal } from "./lib/render.mjs";

// Conservative timeouts. Override with `--timeout <duration>`, or pass
// `--timeout 0` to disable. Task has no default — rescue work is open-ended
// by design and the user can /grok:cancel a stuck job.
const DEFAULT_ASK_TIMEOUT_MS = 5 * 60 * 1000;       // 5 min
const DEFAULT_REVIEW_TIMEOUT_MS = 20 * 60 * 1000;   // 20 min
const DEFAULT_TASK_TIMEOUT_MS = 0;                  // unbounded

// Default max-turns budgets. The probe-time discovery (~/.grok/README +
// hands-on testing) showed Grok consumes ~4 internal messages even for a
// trivial reply, so the floor must be well above 4 for any real interaction.
const DEFAULT_ASK_MAX_TURNS = 30;
const DEFAULT_REVIEW_MAX_TURNS = 60;

// Node's setTimeout silently truncates delays exceeding 2^31-1 ms (~24.85d):
// instead of waiting that long, the timer fires at ~1ms and Node prints a
// TimeoutOverflowWarning. So `--timeout 30d` would wrap to "instantly" without
// this clamp.
const MAX_SETTIMEOUT_MS = 2_147_483_647;

function resolveTimeoutMs(rawFlag, defaultMs) {
  if (rawFlag === undefined) return defaultMs;
  const parsed = parseDuration(String(rawFlag));
  if (parsed === null) {
    console.error(`Invalid --timeout value: ${rawFlag}. Use forms like 300s, 20m, or 0 to disable.`);
    process.exit(2);
  }
  if (parsed > MAX_SETTIMEOUT_MS) {
    process.stderr.write(`[grok-plugin] --timeout ${rawFlag} exceeds Node's max setTimeout delay (${MAX_SETTIMEOUT_MS} ms ~ 24.85d). Clamping; pass --timeout 0 to disable instead.\n`);
    return MAX_SETTIMEOUT_MS;
  }
  return parsed;
}

// Hard cap on how much of the on-disk log we will read into memory for JSON
// parsing. The disk log is uncapped (raw bytes kept for debugging), but
// JSON.parse on a multi-GB string would OOM the process.
const MAX_REVIEW_JSON_BYTES = 8 * 1024 * 1024;      // 8 MB

// Standard exit code for "command terminated by timeout" (matches GNU
// timeout(1)). Distinguishable from policy refusals (2) and missing-binary
// (127) so wrappers can tell timeouts apart from other failures.
const EXIT_TIMEOUT = 124;

// Valid values for --effort, per `grok --help`. We let the user pass any of
// these through unchanged; anything else is rejected at parse time rather
// than being surfaced as a confusing CLI error.
const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function validateEffort(effort) {
  if (effort === undefined || effort === null || effort === "") return null;
  const e = String(effort).toLowerCase().trim();
  if (!VALID_EFFORTS.has(e)) {
    console.error(`Invalid --effort: ${effort}. Valid values: ${[...VALID_EFFORTS].join(", ")}.`);
    process.exit(2);
  }
  return e;
}

// Grok does not consume stdin in headless mode (`-p`). For payloads larger
// than what we want to put on the command line (reviews with a multi-MB
// diff), write the prompt to a temp file and use `--prompt-file <path>`.
// Returns the temp path; caller is responsible for unlinking when done.
//
// Retries on EEXIST: O_EXCL gives us per-attempt symlink defense, but the
// 48-bit random suffix + millisecond timestamp is not collision-free under
// concurrent review/gate activity. A small retry loop is enough to make the
// collision case quiet rather than fatal.
function writePromptToTempFile(prompt) {
  const dir = os.tmpdir();
  for (let attempt = 0; attempt < 8; attempt++) {
    const name = `grok-prompt-${Date.now()}-${randomBytes(12).toString("hex")}.txt`;
    const p = path.join(dir, name);
    let fd;
    try {
      // O_EXCL: refuse to overwrite a pre-planted symlink in tmp.
      fd = fs.openSync(p, "wx", 0o600);
    } catch (e) {
      if (e && e.code === "EEXIST") continue;
      throw e;
    }
    try { fs.writeSync(fd, prompt); }
    finally { fs.closeSync(fd); }
    return p;
  }
  throw new Error("writePromptToTempFile: exhausted retries trying to find a free name");
}

function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch {}
}

// ---------- subcommand: setup ----------

function cmdSetup({ flags }) {
  const wantJson = !!flags.json;
  const result = {
    ready: false,
    node: { available: !!process.versions.node, detail: `v${process.versions.node}` },
    grok: { available: false, detail: null, version_ok: false },
    capabilities: { ok: false, missing: [] },
    auth: { available: false, detail: null, source: null },
    model: { active: effectiveModel(), default: DEFAULT_MODEL, override: process.env.GROK_PLUGIN_MODEL || null },
    reviewGateEnabled: false,
    actionsTaken: [],
    nextSteps: []
  };

  // Toggle review gate first so the result reflects the new state.
  if (flags["enable-review-gate"]) {
    setReviewGate(process.cwd(), true);
    result.actionsTaken.push("Enabled the stop-time review gate for this workspace.");
  } else if (flags["disable-review-gate"]) {
    setReviewGate(process.cwd(), false);
    result.actionsTaken.push("Disabled the stop-time review gate for this workspace.");
  }
  const cfg = readConfig(process.cwd());
  result.reviewGateEnabled = !!cfg.reviewGateEnabled;

  const grokBin = which("grok");
  if (grokBin) {
    result.grok.available = true;
    const rawVer = grokVersion();
    result.grok.detail = rawVer || "installed";
    const verCheck = checkMinVersion(rawVer);
    result.grok.version_ok = verCheck.ok;
    if (!verCheck.ok) {
      result.grok.version_warning = verCheck.reason;
      result.nextSteps.push(
        `Upgrade Grok CLI: \`grok update\` (or reinstall via \`curl -fsSL https://x.ai/cli/install.sh | bash\`). Plugin requires >= ${MIN_GROK_VERSION}; detected ${verCheck.current || "unknown"}.`
      );
    }
  } else {
    result.grok.detail = "not installed";
    result.nextSteps.push("Install Grok CLI: `curl -fsSL https://x.ai/cli/install.sh | bash`");
  }

  if (result.grok.available) {
    const cap = capabilityProbe();
    result.capabilities = cap;
    if (!cap.ok) {
      result.nextSteps.push(
        `Grok CLI is missing flags this plugin depends on: ${cap.missing.join(", ")}. Upgrade with \`grok update\`.`
      );
    }
  }

  if (result.grok.available && result.capabilities.ok) {
    const probe = probeWithFallback();
    result.auth.available = probe.ok;
    result.auth.detail = probe.detail;
    result.auth.source = probe.ok ? detectAuthSource() : null;
    if (probe.fallbackUsed) {
      setActiveModel(process.cwd(), probe.fallbackUsed);
      result.model.active = probe.fallbackUsed;
      result.model.fallbackUsed = probe.fallbackUsed;
      result.actionsTaken.push(
        `Default model ${result.model.default} unavailable; persisting fallback ${probe.fallbackUsed} for this workspace. Override with --model or GROK_PLUGIN_MODEL.`
      );
    } else if (probe.ok) {
      const cur = readConfig(process.cwd());
      if (cur.activeModel && cur.activeModel !== result.model.default) {
        setActiveModel(process.cwd(), null);
        result.actionsTaken.push(
          `Default model ${result.model.default} is available again; cleared persisted fallback ${cur.activeModel}.`
        );
      }
    }
    if (!probe.ok) {
      if (probe.detail === "model unavailable") {
        const tried = [result.model.default, ...MODEL_FALLBACK_CHAIN.filter(m => m !== result.model.default)];
        result.nextSteps.push(
          `No fallback-chain model is available for this account. Tried: ${tried.join(", ")}. Override with --model or GROK_PLUGIN_MODEL.`
        );
      } else if (probe.detail === "no auth method configured") {
        result.nextSteps.push(
          "Authenticate Grok. Either:\n  - Run `!grok login` and complete the browser OAuth flow, OR\n  - Set GROK_CODE_XAI_API_KEY (get a key from https://console.x.ai) - either inline (`export GROK_CODE_XAI_API_KEY=...`) or in `~/.claude/settings.json` under `env`."
        );
      } else {
        result.nextSteps.push(`Grok auth probe failed (${probe.detail}). Try \`!grok login\` to refresh credentials.`);
      }
    }
  }

  if (result.grok.available && result.capabilities.ok && result.auth.available && !result.reviewGateEnabled) {
    result.nextSteps.push("Optional: run `/grok:setup --enable-review-gate` to require a fresh review before stop.");
  }

  result.ready = result.grok.available && result.capabilities.ok && result.auth.available;

  if (wantJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    if (result.actionsTaken.length) {
      for (const a of result.actionsTaken) console.log(a);
      console.log("");
    }
    console.log(`Node:         ${result.node.detail}`);
    console.log(`Grok:         ${result.grok.detail}`);
    console.log(`Capabilities: ${result.capabilities.ok ? "ok" : `missing: ${result.capabilities.missing.join(", ")}`}`);
    console.log(`Auth:         ${result.auth.available ? "OK working" : "FAIL " + result.auth.detail}${result.auth.source ? ` (${result.auth.source})` : ""}`);
    console.log(`Model:        ${result.model.active}${result.model.override ? "  (via GROK_PLUGIN_MODEL)" : "  (plugin default)"}`);
    console.log(`Review gate:  ${result.reviewGateEnabled ? "enabled" : "disabled"}`);
    if (result.nextSteps.length) {
      console.log("\nNext steps:");
      for (const step of result.nextSteps) console.log(`- ${step}`);
    } else {
      console.log("\nGrok plugin is ready.");
    }
  }
  process.exit(result.ready ? 0 : 1);
}

// ---------- subcommand: ask ----------

// Parse Grok's --output-format json envelope. Shape:
//   success: { text, stopReason, sessionId, requestId, thought? }
//   error:   { type: "error", message }
// Returns { kind: "text" | "error" | "unknown", text, message, sessionId } where
// unknown means the payload could not be parsed as either shape.
function parseGrokJson(raw) {
  if (!raw) return { kind: "unknown" };
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed && typeof parsed === "object") {
      if (parsed.type === "error") {
        return { kind: "error", message: parsed.message || "" };
      }
      if (typeof parsed.text === "string") {
        return {
          kind: "text",
          text: parsed.text,
          sessionId: parsed.sessionId || null,
          stopReason: parsed.stopReason || null
        };
      }
    }
  } catch {}
  return { kind: "unknown" };
}

function cmdAsk({ flags, positional }) {
  const prompt = positional.join(" ").trim();
  if (!prompt) {
    console.error("Usage: ask <question>");
    process.exit(2);
  }
  const timeoutMs = resolveTimeoutMs(flags.timeout, DEFAULT_ASK_TIMEOUT_MS);
  const effort = validateEffort(flags.effort);
  if (!which("grok")) {
    console.error("Grok CLI not installed. Run `/grok:setup`.");
    process.exit(127);
  }
  // Always request json output internally so we can detect Grok's
  // exit-0-on-internal-error case and surface a clean error.
  const args = ["-p", prompt, ...grokBaseArgs({ readOnly: true, model: flags.model, jsonOutput: true })];
  args.push("--max-turns", String(DEFAULT_ASK_MAX_TURNS));
  if (effort) args.push("--effort", effort);
  const spawnOpts = { encoding: "utf8", env: cleanGrokEnv() };
  if (timeoutMs > 0) spawnOpts.timeout = Math.min(timeoutMs, MAX_SETTIMEOUT_MS);
  const r = spawnSync("grok", args, spawnOpts);
  if (r.error && r.error.code === "ETIMEDOUT") {
    if (r.stdout) process.stdout.write(sanitizeForTerminal(r.stdout));
    if (r.stderr) process.stderr.write(sanitizeForTerminal(r.stderr));
    process.stderr.write(`\n[grok-plugin] ask timed out after ${timeoutMs}ms. Re-run with --timeout 0 to disable, or pick a longer duration like --timeout 15m.\n`);
    process.exit(EXIT_TIMEOUT);
  }
  const parsed = parseGrokJson(r.stdout || "");
  if (parsed.kind === "text") {
    process.stdout.write(parsed.text + "\n");
    process.exit(0);
  }
  if (parsed.kind === "error") {
    const why = classifyAuthBlob(parsed.message);
    process.stderr.write(`Grok error: ${parsed.message}\n`);
    if (why) process.stderr.write(`[hint: ${why}. Run /grok:setup.]\n`);
    process.exit(1);
  }
  // Couldn't parse — fall back to whatever Grok printed, but also surface stderr.
  if (r.stdout) process.stdout.write(sanitizeForTerminal(r.stdout));
  if (r.status !== 0) {
    if (r.stderr) process.stderr.write(sanitizeForTerminal(r.stderr));
    const why = classifyAuthBlob((r.stdout || "") + "\n" + (r.stderr || ""));
    if (why) process.stderr.write(`\n[hint: ${why}. Run /grok:setup.]\n`);
  }
  process.exit(r.status ?? 0);
}

// ---------- shared job runner ----------

const MAX_JOB_BUF = 256 * 1024;

// Spawn `grok`, stream output to a job log on disk (and optionally to the
// user's stdout, sanitized), and resolve when the process closes. Used by
// both cmdReview and cmdTask.
function runJob({ args, meta, showStdout = true, timeoutMs = 0, cleanupPaths = [] }) {
  return new Promise((resolve, reject) => {
    ensureDir(jobsDir());
    const stdoutFd = fs.openSync(meta.stdout_path, "w");
    const stderrFd = fs.openSync(meta.stderr_path, "w");

    const proc = spawn("grok", args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: cleanGrokEnv()
    });
    meta.pid = proc.pid;
    if (timeoutMs > 0) meta.timeout_ms = timeoutMs;
    writeJobMeta(meta.id, meta);
    pruneJobs();

    let outBuf = "", errBuf = "";
    const sanitizer = new TerminalSanitizer();

    let timedOut = false;
    let timeoutTimer = null;
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        if (proc.exitCode !== null || proc.signalCode !== null) return;
        timedOut = true;
        meta.status = "timed-out";
        meta.ended_at = new Date().toISOString();
        try { writeJobMeta(meta.id, meta); } catch {}
        terminateProcessTree(proc.pid).catch(() => {});
      }, timeoutMs);
    }

    proc.stdout.on("data", d => {
      fs.writeSync(stdoutFd, d);
      if (showStdout) {
        const safe = sanitizer.push(d);
        if (safe) process.stdout.write(safe);
      }
      if (outBuf.length < MAX_JOB_BUF) {
        outBuf += d.toString().slice(0, MAX_JOB_BUF - outBuf.length);
      }
    });
    proc.stderr.on("data", d => {
      fs.writeSync(stderrFd, d);
      if (errBuf.length < MAX_JOB_BUF) {
        errBuf += d.toString().slice(0, MAX_JOB_BUF - errBuf.length);
      }
    });

    proc.on("close", code => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      try { fs.closeSync(stdoutFd); } catch {}
      try { fs.closeSync(stderrFd); } catch {}
      if (showStdout) {
        const tail = sanitizer.flush();
        if (tail) process.stdout.write(tail);
      }
      for (const p of cleanupPaths) safeUnlink(p);

      const current = readJobMeta(meta.id) || meta;
      // Grok returns exit 0 even on internal `{"type":"error"}` payloads.
      // Look at the parsed JSON envelope to set the right job status.
      //
      // outBuf is capped at MAX_JOB_BUF (256 KiB), so for any output above
      // that cap the truncated buffer cannot parse as valid JSON and we
      // would silently flip an error payload to "completed". Re-read the
      // full file from disk for the envelope check, but bound the read at
      // MAX_REVIEW_JSON_BYTES so a runaway response cannot OOM us.
      let parsedOut = parseGrokJson(outBuf);
      if (parsedOut.kind === "unknown") {
        try {
          const stat = fs.statSync(meta.stdout_path);
          if (stat.size > outBuf.length && stat.size <= MAX_REVIEW_JSON_BYTES) {
            const full = fs.readFileSync(meta.stdout_path, "utf8");
            parsedOut = parseGrokJson(full);
          }
        } catch {}
      }
      const grokInternalError = parsedOut.kind === "error";

      if (current.status === "cancelled" || current.status === "timed-out") {
        current.exit_code = code;
        writeJobMeta(meta.id, current);
        meta.status = current.status;
      } else if (grokInternalError) {
        meta.status = "failed";
        meta.exit_code = code;
        meta.error = parsedOut.message;
        meta.ended_at = new Date().toISOString();
        writeJobMeta(meta.id, meta);
      } else {
        meta.status = code === 0 ? "completed" : "failed";
        meta.exit_code = code;
        if (parsedOut.kind === "text" && parsedOut.sessionId) {
          meta.session_id = parsedOut.sessionId;
        }
        meta.ended_at = new Date().toISOString();
        writeJobMeta(meta.id, meta);
      }

      if (timedOut) {
        process.stderr.write(`\n[grok-plugin] Job ${meta.id} timed out after ${timeoutMs}ms. Re-run with --timeout 0 to disable, or pick a longer duration like --timeout 30m.\n`);
      } else if ((code !== 0 || grokInternalError) && meta.status !== "cancelled") {
        if (errBuf) process.stderr.write(sanitizeForTerminal(errBuf));
        const why = classifyAuthBlob(outBuf + "\n" + errBuf);
        if (why) process.stderr.write(`\n[hint: ${why}. Run /grok:setup.]\n`);
      }

      resolve({ code, outBuf, errBuf, timedOut, parsedOut });
    });

    proc.on("error", err => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      try { fs.closeSync(stdoutFd); } catch {}
      try { fs.closeSync(stderrFd); } catch {}
      for (const p of cleanupPaths) safeUnlink(p);
      meta.status = "failed";
      meta.exit_code = -1;
      meta.error = err.message;
      meta.ended_at = new Date().toISOString();
      writeJobMeta(meta.id, meta);
      reject(err);
    });
  });
}

function buildJobMeta({ kind, args, task_text, extra = {} }) {
  const id = newJobId();
  const dir = jobsDir();
  return {
    version: 1,
    id,
    kind,
    pid: null,
    command: ["grok", ...args],
    started_at: new Date().toISOString(),
    status: "running",
    stdout_path: path.join(dir, `${id}.stdout.log`),
    stderr_path: path.join(dir, `${id}.stderr.log`),
    task_text,
    ...extra
  };
}

// ---------- subcommand: review / adversarial-review ----------

function validateReviewSchemaShallow(obj) {
  if (!obj || typeof obj !== "object") return "not an object";
  for (const key of ["verdict", "summary", "findings", "next_steps"]) {
    if (!(key in obj)) return `missing required key: ${key}`;
  }
  if (!["approve", "needs-attention"].includes(obj.verdict)) return `bad verdict: ${obj.verdict}`;
  if (!Array.isArray(obj.findings)) return "findings is not an array";
  return null;
}

async function cmdReview({ flags, positional }, { adversarial }) {
  if (!which("grok")) {
    console.error("Grok CLI not installed. Run `/grok:setup`.");
    process.exit(127);
  }
  const scope = flags.scope || "auto";
  const base = flags.base || null;
  const focus = positional.join(" ").trim();
  const jsonOutput = !!flags.json;
  const effort = validateEffort(flags.effort);
  const diffResult = captureDiff({ scope: scope === "branch" ? "branch" : scope, base });

  if (diffResult.kind === "no-repo") {
    console.log("Not inside a git repository - nothing to review.");
    process.exit(0);
  }
  if (diffResult.kind === "no-base") {
    console.error("Branch review needs a base ref. Pass --base <ref> (no origin/main, origin/master, main, or master found).");
    process.exit(2);
  }
  if (diffResult.kind === "bad-ref") {
    console.error(`Invalid git ref for --base: ${base}`);
    process.exit(2);
  }
  if (!diffResult.diff.trim()) {
    console.log(`Nothing to review (scope: ${diffResult.kind}${diffResult.base ? `, base: ${diffResult.base}` : ""}).`);
    process.exit(0);
  }

  const target = diffResult.kind + (diffResult.base ? ` (base: ${diffResult.base})` : "");
  const prompt = buildReviewPrompt({
    adversarial,
    focus,
    target,
    jsonOutput,
    diff: diffResult.diff
  });

  // Grok's headless mode does not consume stdin. The diff goes through
  // --prompt-file so we don't blow ARG_MAX with a multi-MB prompt.
  const promptFile = writePromptToTempFile(prompt);

  // Internal output is always JSON so we can detect Grok's
  // exit-0-on-internal-error contract. We re-serialize for the user when
  // they asked for plain.
  const args = ["--prompt-file", promptFile, ...grokBaseArgs({ readOnly: true, model: flags.model, jsonOutput: true })];
  args.push("--max-turns", String(DEFAULT_REVIEW_MAX_TURNS));
  if (effort) args.push("--effort", effort);
  const timeoutMs = resolveTimeoutMs(flags.timeout, DEFAULT_REVIEW_TIMEOUT_MS);

  const meta = buildJobMeta({
    kind: adversarial ? "adversarial-review" : "review",
    args,
    task_text: `${target}${focus ? ` - focus: ${focus}` : ""}`,
    extra: { json_output: jsonOutput, model: flags.model || null, effort: effort || null }
  });

  let result;
  try {
    // Don't stream stdout to the user during review — wait for the full
    // JSON envelope, then render either the inner text or parsed JSON.
    result = await runJob({ args, meta, showStdout: false, timeoutMs, cleanupPaths: [promptFile] });
  } catch (err) {
    safeUnlink(promptFile);
    console.error(`Failed to spawn grok: ${err.message}`);
    process.exit(127);
  }

  if (result.timedOut) process.exit(EXIT_TIMEOUT);

  // Read the full on-disk stdout to get the full payload (outBuf is capped).
  let fullOut = result.outBuf;
  try {
    const stat = fs.statSync(meta.stdout_path);
    if (stat.size <= MAX_REVIEW_JSON_BYTES) {
      fullOut = fs.readFileSync(meta.stdout_path, "utf8");
    } else {
      process.stderr.write(
        `[grok-plugin] review: output is ${stat.size} bytes, > ${MAX_REVIEW_JSON_BYTES} cap. Will only render the truncated prefix; full output stays on disk at ${meta.stdout_path}.\n`
      );
    }
  } catch {}

  const parsed = parseGrokJson(fullOut);
  if (parsed.kind === "error") {
    process.stderr.write(`Grok error: ${parsed.message}\n`);
    const why = classifyAuthBlob(parsed.message);
    if (why) process.stderr.write(`[hint: ${why}. Run /grok:setup.]\n`);
    process.exit(1);
  }
  if (parsed.kind === "unknown") {
    // Fall back to whatever Grok printed.
    process.stdout.write(sanitizeForTerminal(fullOut));
    process.exit(result.code ?? 1);
  }

  // parsed.kind === "text"
  if (!jsonOutput) {
    process.stdout.write(parsed.text + "\n");
    process.exit(0);
  }

  // The user asked for JSON. The model was told to emit JSON matching our
  // review-output schema, but it may wrap it in ```json fences or extra prose.
  let inner = parsed.text.trim();
  const fenced = inner.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenced) inner = fenced[1].trim();
  try {
    const innerParsed = JSON.parse(inner);
    const why = validateReviewSchemaShallow(innerParsed);
    if (why) {
      process.stderr.write(`[grok-plugin] review --json: schema mismatch (${why}). Returning unwrapped payload.\n`);
    }
    process.stdout.write(JSON.stringify(innerParsed, null, 2) + "\n");
  } catch {
    // Couldn't parse the inner text as JSON either; return the text as-is.
    process.stdout.write(parsed.text + "\n");
  }
  process.exit(0);
}

// ---------- subcommand: imagine / imagine-video ----------

// Default per-call deadlines for media generation. Image generation is fast
// (~5-30s); video generation routinely takes a minute or two. Override via
// --timeout; pass --timeout 0 to disable.
const DEFAULT_IMAGE_TIMEOUT_MS = 5 * 60 * 1000;    // 5 min
const DEFAULT_VIDEO_TIMEOUT_MS = 15 * 60 * 1000;   // 15 min

// Extract the saved image / video path from Grok's response text. Grok's
// /imagine and /imagine-video builtins respond with markdown of the shape
// `![alt](/absolute/path/to/file.ext)`. We pull out the URL portion so the
// user gets a direct path they can `open` (macOS), `xdg-open` (Linux), or
// drag into a chat. Falls back to the raw text if the markdown shape isn't
// matched — Grok occasionally returns extra prose for safety/refusal cases.
function extractMediaPath(text) {
  if (typeof text !== "string") return null;
  const m = text.match(/!\[[^\]]*\]\(([^)]+)\)/);
  if (m && m[1]) return m[1];
  return null;
}

async function cmdImagine({ flags, positional }, { video }) {
  const description = positional.join(" ").trim();
  if (!description) {
    console.error(`Usage: ${video ? "imagine-video" : "imagine"} <description>`);
    process.exit(2);
  }
  if (!which("grok")) {
    console.error("Grok CLI not installed. Run `/grok:setup`.");
    process.exit(127);
  }

  // Reject obvious shell-injection patterns in the description before
  // shipping it to a child process. Grok's /imagine takes a prompt, not a
  // command, but we still defense-in-depth against newlines that could
  // truncate or stack additional headless directives.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(description)) {
    console.error("Description contains control bytes; refusing to forward to Grok.");
    process.exit(2);
  }

  const slashCommand = video ? "/imagine-video" : "/imagine";
  const defaultMs = video ? DEFAULT_VIDEO_TIMEOUT_MS : DEFAULT_IMAGE_TIMEOUT_MS;
  const timeoutMs = resolveTimeoutMs(flags.timeout, defaultMs);
  const effort = validateEffort(flags.effort);

  // We do NOT use grokBaseArgs here. /imagine is a builtin "shell"
  // command, not an agentic task — it doesn't run tools, so the
  // --permission-mode plan + --disallowed-tools layer is unnecessary, and
  // forcing JSON output is what gives us a parseable response.
  const prompt = `${slashCommand} ${description}`;
  const args = [
    "-p", prompt,
    "--output-format", "json",
    "-m", effectiveModel(flags.model),
    "--max-turns", "10"
  ];
  if (effort) args.push("--effort", effort);

  const spawnOpts = { encoding: "utf8", env: cleanGrokEnv() };
  if (timeoutMs > 0) spawnOpts.timeout = Math.min(timeoutMs, MAX_SETTIMEOUT_MS);

  const r = spawnSync("grok", args, spawnOpts);
  if (r.error && r.error.code === "ETIMEDOUT") {
    if (r.stdout) process.stdout.write(sanitizeForTerminal(r.stdout));
    if (r.stderr) process.stderr.write(sanitizeForTerminal(r.stderr));
    process.stderr.write(`\n[grok-plugin] ${video ? "imagine-video" : "imagine"} timed out after ${timeoutMs}ms. Re-run with --timeout 0 to disable, or pick a longer duration.\n`);
    process.exit(EXIT_TIMEOUT);
  }

  const parsed = parseGrokJson(r.stdout || "");
  if (parsed.kind === "error") {
    const why = classifyAuthBlob(parsed.message);
    process.stderr.write(`Grok error: ${parsed.message}\n`);
    if (why) process.stderr.write(`[hint: ${why}. Run /grok:setup.]\n`);
    process.exit(1);
  }
  if (parsed.kind !== "text") {
    if (r.stdout) process.stdout.write(sanitizeForTerminal(r.stdout));
    if (r.stderr) process.stderr.write(sanitizeForTerminal(r.stderr));
    process.exit(r.status ?? 1);
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify({
      kind: video ? "video" : "image",
      description,
      path: extractMediaPath(parsed.text),
      sessionId: parsed.sessionId || null,
      raw: parsed.text
    }, null, 2) + "\n");
    process.exit(0);
  }

  const mediaPath = extractMediaPath(parsed.text);
  if (mediaPath) {
    const noun = video ? "Video" : "Image";
    process.stdout.write(`${noun}: ${mediaPath}\n`);
    process.stdout.write(`\nOpen with:\n  open "${mediaPath}"\n`);
    if (parsed.sessionId) {
      process.stdout.write(`\nSession: ${parsed.sessionId}  (resume: grok -r ${parsed.sessionId})\n`);
    }
  } else {
    // No markdown link in the response — surface the raw text so the user
    // can see the model's refusal or content-policy explanation.
    process.stdout.write(parsed.text + "\n");
  }
  process.exit(0);
}

// ---------- subcommand: task ----------

async function cmdTask({ flags, positional }) {
  const taskText = positional.join(" ").trim();
  if (!taskText) {
    console.error("Usage: task <description of what to do>");
    process.exit(2);
  }

  // Write-mode gate runs BEFORE the binary check so a "refused for safety"
  // error is never masked by "Grok not installed".
  const isWrite = !!flags.write && !flags["read-only"];
  if (isWrite && process.env.GROK_PLUGIN_ALLOW_WRITE !== "1") {
    console.error("--write refused: GROK_PLUGIN_ALLOW_WRITE is not set to 1.");
    console.error("");
    console.error("--write puts Grok in --yolo mode, which lets it modify files in this");
    console.error("workspace without per-action confirmation. Only enable in a workspace");
    console.error("where you already trust running an unattended agent.");
    console.error("");
    console.error("To enable for this session:    export GROK_PLUGIN_ALLOW_WRITE=1");
    console.error("To enable persistently:        add it to ~/.claude/settings.json env.");
    process.exit(2);
  }

  const timeoutMs = resolveTimeoutMs(flags.timeout, DEFAULT_TASK_TIMEOUT_MS);
  const effort = validateEffort(flags.effort);

  if (!which("grok")) {
    console.error("Grok CLI not installed. Run `/grok:setup`.");
    process.exit(127);
  }

  if (isWrite) {
    process.stderr.write("[grok-plugin] WRITE MODE ACTIVE - Grok may modify files in this workspace.\n");
  }

  // Plain output during a task: the user is interactively watching Grok
  // think. JSON detection still applies via the on-close handler.
  const args = ["-p", taskText, ...grokBaseArgs({ readOnly: !isWrite, model: flags.model, jsonOutput: false })];
  if (effort) args.push("--effort", effort);

  // Optional session-id continuation: -s creates a new session if not found,
  // -r requires it exists. We surface both via --session-id and --resume on
  // the slash-command surface; here, just thread it through.
  if (flags["session-id"]) args.push("-s", String(flags["session-id"]));

  const meta = buildJobMeta({
    kind: "task",
    args,
    task_text: taskText,
    extra: {
      write: isWrite,
      model: flags.model || null,
      effort: effort || null,
      requested_session_id: flags["session-id"] || null
    }
  });

  let result;
  try {
    result = await runJob({ args, meta, showStdout: true, timeoutMs });
  } catch (err) {
    console.error(`Failed to spawn grok: ${err.message}`);
    process.exit(127);
  }

  process.stdout.write(`\n\n[grok-plugin] Job ${meta.id} ${meta.status} (exit ${result.code}).\n`);
  // sessionId only ends up on meta.session_id when the underlying invocation
  // used JSON output and we parsed the envelope. `task` uses plain output for
  // streaming UX, so this footer only fires when the user passed a named
  // --session-id (we record it as requested_session_id; the runtime then uses
  // that exact name as the session handle).
  const sessionLabel = meta.session_id || meta.requested_session_id;
  if (sessionLabel) {
    process.stdout.write(`[grok-plugin] Session: ${sessionLabel}  (resume: grok -r ${sessionLabel})\n`);
  }
  process.stdout.write(`[grok-plugin] /grok:result ${meta.id}\n`);
  if (result.timedOut) process.exit(EXIT_TIMEOUT);
  if (meta.status === "failed") process.exit(1);
  process.exit(result.code ?? 0);
}

// ---------- subcommand: status ----------

function refreshStatus(meta) {
  if (meta.status === "running" && !isAlive(meta.pid)) {
    meta.status = "ended";
    meta.ended_at = meta.ended_at || new Date().toISOString();
    writeJobMeta(meta.id, meta);
  }
}

function cmdStatus({ flags, positional }) {
  const target = positional[0];
  if (target) {
    const meta = readJobMeta(target);
    if (!meta) { console.log(`No job ${target}.`); process.exit(1); }
    refreshStatus(meta);
    console.log(renderJobDetails(meta));
    process.exit(0);
  }
  const limit = flags.all ? 50 : 10;
  const all = listJobs().slice(0, limit);
  for (const j of all) refreshStatus(j);
  console.log(renderJobTable(all));
  process.exit(0);
}

// ---------- subcommand: result ----------

function cmdResult({ positional }) {
  const target = positional[0];
  let meta;
  if (target) {
    meta = readJobMeta(target);
    if (!meta) { console.log(`No job ${target}.`); process.exit(1); }
    refreshStatus(meta);
  } else {
    const all = listJobs();
    for (const j of all) refreshStatus(j);
    const completed = all.filter(j => j.status !== "running");
    if (completed.length === 0) {
      console.log("No completed Grok jobs in this workspace.");
      process.exit(0);
    }
    meta = completed[0];
  }
  console.log(`# Job ${meta.id}`);
  console.log(`Kind: ${meta.kind}${meta.write ? " (write)" : ""}`);
  console.log(`Status: ${meta.status}`);
  console.log(`Task: ${meta.task_text || "-"}`);
  console.log(`Started: ${fmtTime(meta.started_at)}${meta.ended_at ? `   Ended: ${fmtTime(meta.ended_at)}` : ""}`);
  if (meta.exit_code !== undefined) console.log(`Exit: ${meta.exit_code}`);
  if (meta.session_id) console.log(`Session: ${meta.session_id}  (resume: grok -r ${meta.session_id})`);
  console.log("\n## Output\n");
  const safeOut = safeJobLogPath(meta.stdout_path);
  if (!safeOut) {
    console.log("(stdout path is outside the jobs directory - refusing to read)");
  } else {
    try {
      const raw = fs.readFileSync(safeOut, "utf8");
      // If the captured output was JSON, render the inner text; otherwise raw.
      const parsed = parseGrokJson(raw);
      if (parsed.kind === "text") {
        process.stdout.write(sanitizeForTerminal(parsed.text + "\n"));
      } else if (parsed.kind === "error") {
        process.stdout.write(sanitizeForTerminal(`(grok internal error) ${parsed.message}\n`));
      } else {
        process.stdout.write(sanitizeForTerminal(raw || "(no output)\n"));
      }
    } catch (e) {
      console.log(`(could not read stdout: ${e.message})`);
    }
  }
  if (meta.exit_code && meta.exit_code !== 0) {
    console.log("\n## Errors\n");
    const safeErr = safeJobLogPath(meta.stderr_path);
    if (safeErr) {
      try {
        const err = fs.readFileSync(safeErr, "utf8");
        process.stdout.write(sanitizeForTerminal(err));
      } catch {}
    }
  }
  console.log(`\n---\nFollow-up: /grok:status ${meta.id}`);
  process.exit(0);
}

// ---------- subcommand: cancel ----------

async function killJob(meta) {
  meta.status = "cancelled";
  meta.ended_at = new Date().toISOString();
  writeJobMeta(meta.id, meta);
  await terminateProcessTree(meta.pid);
}

async function cmdCancel({ positional }) {
  const target = positional[0];
  if (!target) {
    const running = listJobs().filter(j => j.status === "running" && isAlive(j.pid));
    if (running.length === 0) {
      console.log("No running Grok jobs to cancel.");
      process.exit(0);
    }
    await Promise.all(running.map(j => killJob(j)));
    console.log(`Cancelled ${running.length} job(s).`);
    process.exit(0);
  }
  const meta = readJobMeta(target);
  if (!meta) { console.log(`No job ${target}.`); process.exit(1); }
  if (meta.status !== "running" || !isAlive(meta.pid)) {
    console.log(`Job ${meta.id} is not running (status: ${meta.status}). Nothing to cancel.`);
    process.exit(0);
  }
  await killJob(meta);
  console.log(`Cancelled ${meta.id}.`);
  process.exit(0);
}

// ---------- subcommand: purge ----------

function cmdPurge({ flags }) {
  const ageRaw = flags["older-than"] || null;
  const maxAgeMs = ageRaw ? parseDuration(ageRaw) : null;
  if (ageRaw && !maxAgeMs) {
    console.error(`Invalid --older-than value: ${ageRaw}. Use forms like 30d, 12h, 45m, 60s.`);
    process.exit(2);
  }
  const purged = purgeJobs({ maxAgeMs });
  if (maxAgeMs) {
    console.log(`Purged ${purged} job(s) older than ${ageRaw}.`);
  } else {
    console.log(`Purged ${purged} job(s).`);
  }
  process.exit(0);
}

// ---------- main ----------

async function main() {
  const [, , sub, ...rest] = process.argv;
  if (!sub) {
    console.error("Usage: companion.mjs <setup|ask|review|adversarial-review|imagine|imagine-video|task|status|result|cancel|purge> [args...]");
    process.exit(2);
  }
  let args;
  try {
    args = parseArgs(rest, { boolFlags: COMMON_BOOL_FLAGS, valueFlags: COMMON_VALUE_FLAGS });
  } catch (e) {
    if (e.code === "MISSING_VALUE") { console.error(e.message); process.exit(2); }
    throw e;
  }
  switch (sub) {
    case "setup": return cmdSetup(args);
    case "ask": return cmdAsk(args);
    case "review": return await cmdReview(args, { adversarial: false });
    case "adversarial-review": return await cmdReview(args, { adversarial: true });
    case "imagine": return await cmdImagine(args, { video: false });
    case "imagine-video": return await cmdImagine(args, { video: true });
    case "task": return await cmdTask(args);
    case "status": return cmdStatus(args);
    case "result": return cmdResult(args);
    case "cancel": return await cmdCancel(args);
    case "purge": return cmdPurge(args);
    default:
      console.error(`Unknown subcommand: ${sub}`);
      console.error("Usage: companion.mjs <setup|ask|review|adversarial-review|imagine|imagine-video|task|status|result|cancel|purge> [args...]");
      process.exit(2);
  }
}

main().catch(err => {
  console.error(`grok-plugin fatal: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
