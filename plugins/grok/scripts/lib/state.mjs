// Workspace-scoped state for the Grok companion: job tracking + plugin config.
// Mirrors gemini-plugin-cc's state.mjs in shape.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const STATE_VERSION = 1;
export const MAX_JOBS = 50;
export const FALLBACK_STATE_ROOT = path.join(os.tmpdir(), "grok-plugin-cc");
export const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
// Hard cap on JSON state files we'll read from disk. Defends against DoS
// from a hostile workspace that planted an enormous metadata file.
export const MAX_STATE_FILE_BYTES = 256 * 1024;

const CONFIG_FILE_NAME = "config.json";
const JOBS_DIR_NAME = "jobs";

// Job IDs come from `newJobId()` which uses base36 timestamps + random suffix.
// Prefix `x-` (for xAI) so they're visually distinct from Gemini's `g-` jobs
// when both plugins are installed in the same workspace.
export const JOB_ID_PATTERN = /^x-[a-z0-9]+-[a-z0-9]+$/;
export function isValidJobId(s) {
  return typeof s === "string" && JOB_ID_PATTERN.test(s);
}

export function workspaceRoot(cwd = process.cwd()) {
  let dir = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(cwd);
    dir = parent;
  }
}

export function stateDir(cwd = process.cwd()) {
  const root = workspaceRoot(cwd);
  let canonical = root;
  try { canonical = fs.realpathSync.native(root); } catch {}
  const slugSource = path.basename(root) || "workspace";
  const slug =
    slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const base = process.env[PLUGIN_DATA_ENV]
    ? path.join(process.env[PLUGIN_DATA_ENV], "state")
    : FALLBACK_STATE_ROOT;
  return path.join(base, `${slug}-${hash}`);
}

export function jobsDir(cwd) { return path.join(stateDir(cwd), JOBS_DIR_NAME); }

export function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

// ---------- jobs ----------

export function newJobId() {
  return "x-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
}

function atomicWrite(target, content) {
  // write-then-rename so concurrent readers/writers can never see a torn file.
  // Using crypto.randomBytes (not pid+timestamp) defeats predictable-name
  // symlink attacks in shared tmp dirs. `wx` flag is exclusive-create:
  // `open` fails (EEXIST) if the path already exists, including when an
  // attacker pre-planted a symlink there.
  const tmp = `${target}.tmp.${randomBytes(12).toString("hex")}`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
}

function readBoundedJson(filePath) {
  // Refuse to parse files larger than MAX_STATE_FILE_BYTES so a hostile
  // workspace can't OOM us via a giant config.json.
  let stat;
  try { stat = fs.statSync(filePath); } catch { return null; }
  if (!stat.isFile()) return null;
  if (stat.size > MAX_STATE_FILE_BYTES) {
    throw new Error(`state file too large: ${filePath} (${stat.size} > ${MAX_STATE_FILE_BYTES})`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeJobMeta(jobId, meta, cwd) {
  if (!isValidJobId(jobId)) {
    throw new Error(`invalid jobId: ${String(jobId).slice(0, 64)}`);
  }
  ensureDir(jobsDir(cwd));
  atomicWrite(
    path.join(jobsDir(cwd), `${jobId}.json`),
    JSON.stringify(meta, null, 2)
  );
}

export function readJobMeta(jobId, cwd) {
  if (!isValidJobId(jobId)) return null;
  try {
    return readBoundedJson(path.join(jobsDir(cwd), `${jobId}.json`));
  } catch { return null; }
}

export function listJobs(cwd) {
  const dir = jobsDir(cwd);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith(".json"))
    .map(f => readJobMeta(f.replace(/\.json$/, ""), cwd))
    .filter(Boolean)
    .sort((a, b) => (b.started_at || "").localeCompare(a.started_at || ""));
}

export function pruneJobs(cwd) {
  const all = listJobs(cwd);
  // Never delete still-running jobs — losing their metadata orphans the PID
  // and breaks /grok:status / /grok:cancel.
  const candidates = all.filter(j => j.status !== "running");
  if (candidates.length <= MAX_JOBS) return;
  const dir = jobsDir(cwd);
  // Only unlink log paths that actually live inside our jobsDir, never blindly
  // trust whatever was recorded in a job file (defense-in-depth).
  for (const j of candidates.slice(MAX_JOBS)) {
    if (!isValidJobId(j.id)) continue;
    try { fs.unlinkSync(path.join(dir, `${j.id}.json`)); } catch {}
    if (j.stdout_path && safeJobLogPath(j.stdout_path, cwd)) {
      try { fs.unlinkSync(j.stdout_path); } catch {}
    }
    if (j.stderr_path && safeJobLogPath(j.stderr_path, cwd)) {
      try { fs.unlinkSync(j.stderr_path); } catch {}
    }
  }
}

// Hard cap on `readBoundedJobLog` reads. Aligned with companion.mjs's
// MAX_REVIEW_JSON_BYTES. The on-disk file itself is uncapped (raw bytes
// kept for postmortem) but bringing > 8 MiB into memory for display
// would OOM the dispatcher.
export const MAX_JOB_LOG_READ_BYTES = 8 * 1024 * 1024;

// Confine a job-log path to the jobs directory. Job metadata is JSON we wrote
// ourselves, but the file can be tampered with on disk by anything with write
// access to ${CLAUDE_PLUGIN_DATA}. Without confinement, a manipulated stdout_path
// could make /grok:result read any user-readable file. Returns the resolved
// path on success, or null if the path resolves outside jobsDir.
//
// Defense layers (BOTH must pass — symlink that escapes jobsDir is rejected):
//   1. Plain string check: `path.dirname(path.resolve(p))` must equal
//      `path.resolve(jobsDir)`. Defeats `..` traversal at the string level.
//   2. Realpath check (if the file exists): the realpath of the file's
//      parent must equal the realpath of jobsDir. Defeats a symlink planted
//      inside jobsDir that points to a file outside it.
//
// The earlier version used `&&` instead of two separate checks; a symlink
// inside jobsDir would pass the plain check (its dirname IS jobsDir) and we
// would then trust the realpath without re-validating it against jobsDir,
// returning a path pointing wherever the symlink targeted.
export function safeJobLogPath(p, cwd) {
  if (typeof p !== "string" || !p) return null;
  const dirPlain = path.resolve(jobsDir(cwd));
  let dirReal = dirPlain;
  try { dirReal = fs.realpathSync.native(dirPlain); } catch {}

  const resolvedPlain = path.resolve(p);
  // Layer 1: string-level confinement. Reject `..` traversal before we
  // touch the FS at all.
  if (path.dirname(resolvedPlain) !== dirPlain) return null;

  // Layer 2: realpath. If the file exists, its realpath must still live
  // under the realpath of jobsDir — defeats a symlink planted inside
  // jobsDir that points outside.
  let resolvedReal = null;
  let exists = false;
  try {
    resolvedReal = fs.realpathSync.native(resolvedPlain);
    exists = true;
  } catch (e) {
    // ENOENT is OK — the log file may not exist yet (fresh job, before
    // the run has started). Any other error (EACCES, EIO, ELOOP) is
    // treated as suspicious and refused.
    if (!e || e.code !== "ENOENT") return null;
  }
  if (exists && path.dirname(resolvedReal) !== dirReal) return null;

  return exists ? resolvedReal : resolvedPlain;
}

// TOCTOU-safe bounded read of a job log file. The previous flow —
// `safeJobLogPath` returns a string, caller `fs.openSync(path)` — has a
// race window in shared-machine environments: an attacker can swap a
// valid log for a symlink to `/etc/shadow` between the validation and
// the open call, leaking arbitrary user-readable files via /grok:result.
//
// Defenses layered here (all on a SINGLE fd, no path-string races):
//   1. safeJobLogPath confines the path string to jobsDir.
//   2. `O_NOFOLLOW` on the open() call: open fails with ELOOP if the
//      leaf is a symlink at open time. An attacker who plants a symlink
//      AFTER safeJobLogPath returns cannot win this race — they would
//      have to win the kernel-internal open syscall.
//   3. `fstatSync(fd)` verifies the opened inode is a regular file
//      (not a directory, device, fifo, etc.).
//   4. Read at most `maxBytes` from offset 0 of that exact fd.
//
// Returns the file content (with a truncation marker if it exceeds
// maxBytes), or null if any safety check failed. Gemini round-7
// finding (v0.5.0).
export function readBoundedJobLog(filePath, cwd, maxBytes = MAX_JOB_LOG_READ_BYTES) {
  const safe = safeJobLogPath(filePath, cwd);
  if (!safe) return null;

  let fd;
  try {
    fd = fs.openSync(safe, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return null;
  }

  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    if (st.size === 0) return "";
    const cap = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(cap);
    fs.readSync(fd, buf, 0, cap, 0);
    const text = buf.toString("utf8");
    if (st.size > maxBytes) {
      return text + `\n\n[... output truncated by grok-plugin: ${st.size - maxBytes} bytes omitted; full output remains at ${safe}]\n`;
    }
    return text;
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

// Purge non-running jobs older than maxAgeMs (default: all). Returns count.
export function purgeJobs({ maxAgeMs = null, cwd } = {}) {
  const all = listJobs(cwd);
  const dir = jobsDir(cwd);
  const cutoff = typeof maxAgeMs === "number" && maxAgeMs > 0
    ? Date.now() - maxAgeMs
    : null;
  let purged = 0;
  for (const j of all) {
    if (j.status === "running") continue;
    if (!isValidJobId(j.id)) continue;
    if (cutoff !== null) {
      const ts = Date.parse(j.ended_at || j.started_at || "");
      if (!Number.isFinite(ts) || ts > cutoff) continue;
    }
    try { fs.unlinkSync(path.join(dir, `${j.id}.json`)); purged++; } catch {}
    if (j.stdout_path && safeJobLogPath(j.stdout_path, cwd)) {
      try { fs.unlinkSync(j.stdout_path); } catch {}
    }
    if (j.stderr_path && safeJobLogPath(j.stderr_path, cwd)) {
      try { fs.unlinkSync(j.stderr_path); } catch {}
    }
  }
  return purged;
}

// ---------- config (review gate) ----------

function configFile(cwd) { return path.join(stateDir(cwd), CONFIG_FILE_NAME); }

export function readConfig(cwd) {
  try {
    const parsed = readBoundedJson(configFile(cwd));
    return parsed || { version: STATE_VERSION, reviewGateEnabled: false };
  } catch {
    return { version: STATE_VERSION, reviewGateEnabled: false };
  }
}

export function writeConfig(cwd, config) {
  ensureDir(stateDir(cwd));
  atomicWrite(configFile(cwd), JSON.stringify(config, null, 2));
}

// Cross-process lock around config.json read-modify-write.
const CONFIG_LOCK_TIMEOUT_MS = 5000;
const CONFIG_LOCK_STALE_MS = 30_000;
const CONFIG_LOCK_POLL_MS = 25;

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function withConfigLock(cwd, fn) {
  const dir = stateDir(cwd);
  ensureDir(dir);
  const lockPath = path.join(dir, CONFIG_FILE_NAME + ".lock");
  const start = Date.now();
  let fd = null;
  while (Date.now() - start < CONFIG_LOCK_TIMEOUT_MS) {
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        const lstat = fs.statSync(lockPath);
        if (Date.now() - lstat.mtimeMs > CONFIG_LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {}
      sleepSync(CONFIG_LOCK_POLL_MS);
    }
  }
  if (fd === null) {
    throw new Error(`config.json lock acquisition timeout: ${lockPath}`);
  }
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

export function setReviewGate(cwd, enabled) {
  return withConfigLock(cwd, () => {
    const c = readConfig(cwd);
    c.reviewGateEnabled = !!enabled;
    c.version = STATE_VERSION;
    writeConfig(cwd, c);
    return c;
  });
}

const MODEL_ID_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;
export function setActiveModel(cwd, model) {
  return withConfigLock(cwd, () => {
    const c = readConfig(cwd);
    if (model === null || model === undefined) {
      delete c.activeModel;
    } else {
      if (typeof model !== "string" || !MODEL_ID_PATTERN.test(model)) {
        throw new Error(`invalid model id: ${String(model).slice(0, 64)}`);
      }
      c.activeModel = model;
    }
    c.version = STATE_VERSION;
    writeConfig(cwd, c);
    return c;
  });
}
