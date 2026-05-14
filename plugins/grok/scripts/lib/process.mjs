// Process helpers — alive checks and process-group-aware termination.

// PID validation: must be a positive integer > 1. We reject:
//  - 0 (POSIX: signal to process group of caller — never useful here)
//  - 1 (init/launchd — kill -1 here would mean kill(-1,...) which BROADCASTS
//       SIGTERM to all processes the user owns, taking down the session)
//  - non-integers, NaN, strings, negatives
export function isValidPid(pid) {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 1;
}

export function isAlive(pid) {
  if (!isValidPid(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) {
    // EPERM means a process exists but we cannot signal it (different uid).
    // For liveness purposes that is "alive" — returning false here would
    // cause session-lifecycle-hook to reap a job owned by another user.
    if (e && e.code === "EPERM") return true;
    return false;
  }
}

// Send SIGTERM to the process group (negative PID), fall back to PID-only kill.
// After the grace window, escalate to SIGKILL. Returns a Promise that resolves
// after the SIGKILL escalation step — callers MUST await this before exiting,
// otherwise the timer is cancelled by process.exit and SIGKILL never fires.
export function terminateProcessTree(pid, { graceMs = 2000 } = {}) {
  if (!isValidPid(pid) || !isAlive(pid)) return Promise.resolve();
  let groupKilled = false;
  try {
    process.kill(-pid, "SIGTERM");
    groupKilled = true;
  } catch {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  return new Promise(resolve => {
    setTimeout(() => {
      if (isAlive(pid)) {
        if (groupKilled) {
          try { process.kill(-pid, "SIGKILL"); } catch {
            try { process.kill(pid, "SIGKILL"); } catch {}
          }
        } else {
          try { process.kill(pid, "SIGKILL"); } catch {}
        }
      }
      resolve();
    }, graceMs);
  });
}
