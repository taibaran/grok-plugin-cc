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

// Create a directory chain with strict owner-only permissions on EVERY
// component, not just the leaf.
//
// Gemini round-8/9 finding: O_NOFOLLOW on the leaf only prevents the
// FINAL path component from being a symlink. An attacker who can write
// into ANY parent directory along the chain can swap that parent for a
// symlink to `/etc/`, and openSync will follow the parent symlink and
// yield arbitrary files. Mode 0700 on only the LEAF (the previous
// implementation) left intermediate dirs at the umask default (0755 or
// even 0777 in shared /tmp), so attackers could pre-create or swap
// stateDir / its parents.
//
// This implementation walks the chain bottom-up after the recursive
// mkdirSync and applies 0700 to each component that we just created or
// already exists. It stops at the first failing chmod (e.g., when we
// hit `/tmp` or `/`, which we don't own).
export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  // Walk up the chain from the leaf, chmod each. Stop at the first
  // directory we cannot chmod (typically `/tmp` or `/` which we don't
  // own).
  let cur = path.resolve(p);
  for (let i = 0; i < 64; i++) {
    try { fs.chmodSync(cur, 0o700); }
    catch { break; }
    const parent = path.dirname(cur);
    if (parent === cur) break;        // reached root
    // Stop chmod-ing once we leave the directory tree we own. The
    // simplest check: don't chmod past the first directory whose
    // own ownership we cannot verify; in practice this stops at
    // /Users/<me>, ~/.claude, /tmp, etc. — all directories we either
    // own (0700-safe) or shouldn't be modifying.
    let parentStat;
    try { parentStat = fs.lstatSync(parent); }
    catch { break; }
    if (parentStat.uid !== process.getuid()) break;
    cur = parent;
  }
}

// Verify that the entire directory chain leading to jobsDir is a
// chain of REAL directories owned by us (not symlinks). Used by
// readBoundedJobLog to detect a parent-directory swap before
// trusting `fs.realpathSync.native(jobsDir(cwd))` (which would
// otherwise dynamically resolve through the attacker's symlink).
//
// Returns true if every component from jobsDir up to the first
// non-owned directory is a regular directory we own.
function isOwnedDirectoryChain(dirPath) {
  let cur = path.resolve(dirPath);
  const myUid = process.getuid();
  for (let i = 0; i < 64; i++) {
    let st;
    try { st = fs.lstatSync(cur); }
    catch { return false; }
    if (!st.isDirectory()) return false;        // symlink or non-dir → reject
    if (st.uid !== myUid) return true;           // reached a parent we don't own — fine, stop here
    const parent = path.dirname(cur);
    if (parent === cur) return true;
    cur = parent;
  }
  return false;
}

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
//      LEAF is a symlink at open time. An attacker who plants a symlink
//      AFTER safeJobLogPath returns cannot win this race — they would
//      have to win the kernel-internal open syscall.
//   3. `fstatSync(fd)` verifies the opened inode is a regular file
//      (not a directory, device, fifo, etc.).
//   4. **Realpath-on-fd verification** (Gemini round-8 finding):
//      O_NOFOLLOW only guards the leaf. An attacker who swaps the
//      parent `jobs/` directory itself for a symlink to `/etc/` opens
//      `/etc/shadow` because the leaf `shadow` IS a regular file. We
//      resolve the opened fd via /dev/fd/<N> (or /proc/self/fd/<N>
//      on Linux) and confirm the realpath lives under the realpath of
//      jobsDir. Combined with 0700 permissions on jobsDir from
//      `ensureDir`, this closes the directory-swap bypass.
//   5. Read at most `maxBytes` from offset 0 of that exact fd.
//
// Returns the file content (with a truncation marker if it exceeds
// maxBytes), or null if any safety check failed.
export function readBoundedJobLog(filePath, cwd, maxBytes = MAX_JOB_LOG_READ_BYTES) {
  // Pre-flight: verify the WHOLE directory chain leading to jobsDir is
  // composed of regular directories that we own. If any component is a
  // symlink or owned by a different user, the chain is compromised and
  // we must not trust the realpath result (which would dynamically
  // resolve through whatever the attacker swapped in).
  //
  // This closes the gap Gemini flagged in round-9: with the previous
  // version, realpath(jobsDir) followed the attacker's symlink and
  // returned `/etc/`, making `fdRealPath.startsWith(realJobsDir + "/")`
  // pass for `/etc/shadow`.
  if (!isOwnedDirectoryChain(jobsDir(cwd))) return null;

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

    // Defense layer 4: verify that the fd we opened actually lives
    // inside jobsDir, not a parent-directory-swapped symlink target.
    //
    // On Linux, /proc/self/fd/<N> resolves via the kernel's open-file
    // table — race-free, cannot be retargeted by an attacker who has
    // already lost the open() race.
    //
    // On macOS, /dev/fd/<N> is a separate fdesc filesystem that
    // resolves to `/dev/fd/<filename>` rather than the real path, so
    // this check is non-functional there. We try /proc/self/fd first
    // (Linux), fall back to /dev/fd (other platforms), then verify
    // the resolved path starts with /dev/fd/ — if it does, the
    // platform doesn't support fd-realpath and we fall back to
    // layers 1-3 + the 0700 permissions on jobsDir from ensureDir.
    //
    // The 0700 permissions are the actual cross-platform defense:
    // they prevent any other UID from manipulating the directory
    // tree, which is the only way a parent-dir swap can happen
    // without already-equivalent privileges to read the target file
    // directly.
    let fdRealPath = null;
    for (const prefix of ["/proc/self/fd/", "/dev/fd/"]) {
      try {
        const candidate = fs.realpathSync.native(prefix + fd);
        if (!candidate.startsWith("/dev/fd/")) {
          fdRealPath = candidate;
          break;
        }
      } catch {}
    }
    if (fdRealPath) {
      let realJobsDir;
      try { realJobsDir = fs.realpathSync.native(jobsDir(cwd)); }
      catch { return null; }
      if (!fdRealPath.startsWith(realJobsDir + path.sep)) {
        return null;
      }
    }
    // If neither /proc/self/fd nor a real /dev/fd was available
    // (macOS fdesc returns /dev/fd/<filename>), we rely on the
    // 0700-mode jobsDir + O_NOFOLLOW leaf protection. An attacker who
    // can write into a 0700 user-owned directory already has
    // user-equivalent access and a more direct attack vector.

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
