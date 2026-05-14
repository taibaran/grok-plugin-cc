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

// Confine a job-log path to the jobs directory. Job metadata is JSON we wrote
// ourselves, but the file can be tampered with on disk by anything with write
// access to ${CLAUDE_PLUGIN_DATA}. Without confinement, a manipulated stdout_path
// could make /grok:result read any user-readable file. Returns the resolved
// path on success, or null if the path resolves outside jobsDir.
//
// Implementation note: a plain `path.resolve` + string equality check is
// unreliable on case-insensitive filesystems (macOS APFS/HFS+ default) and
// when symlinks are involved — `/Users/...` and `/users/...` can refer to
// the same inode while `===` reports them as different paths. We canonicalize
// both sides with `realpath` before comparing, falling back to `path.resolve`
// only when the file does not yet exist (e.g., a fresh job's stdout_path
// before the run has started).
export function safeJobLogPath(p, cwd) {
  if (typeof p !== "string" || !p) return null;
  const dirPlain = path.resolve(jobsDir(cwd));
  let dir = dirPlain;
  try { dir = fs.realpathSync.native(dirPlain); } catch {}
  const resolvedPlain = path.resolve(p);
  // Reject anything that doesn't even resolve into the right basename-parent
  // before we touch the FS — defends against `../` traversal at the string
  // level too.
  if (path.dirname(resolvedPlain) !== dirPlain && path.dirname(resolvedPlain) !== dir) {
    return null;
  }
  let resolved = resolvedPlain;
  try { resolved = fs.realpathSync.native(resolvedPlain); }
  catch (e) {
    // ENOENT is fine — the log file may not exist yet. We already verified
    // the parent dir match above, so accept the unresolved path. Any other
    // error (EACCES, EIO) is treated as suspicious and refused.
    if (!e || e.code !== "ENOENT") return null;
  }
  // After realpath, compare directory components case-sensitively against
  // the (also realpath'd) jobs dir. On a case-insensitive FS both sides
  // collapse to the canonical casing, so equality holds.
  if (path.dirname(resolved) !== dir && path.dirname(resolvedPlain) !== dirPlain) {
    return null;
  }
  return resolved;
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
