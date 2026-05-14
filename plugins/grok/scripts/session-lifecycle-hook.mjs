#!/usr/bin/env node
// Session lifecycle hook for Grok Companion.
// Invoked by Claude Code on SessionStart and SessionEnd.
//
// SessionStart: prune dead jobs (orphan PIDs from a previous Claude run).
// SessionEnd:   mark any still-running jobs as "ended" so /grok:status
//               doesn't lie. We do NOT kill running jobs here — the user
//               may have launched them deliberately as background tasks.

import fs from "node:fs";
import { listJobs, writeJobMeta, pruneJobs } from "./lib/state.mjs";
import { isAlive } from "./lib/process.mjs";

const phase = process.argv[2] || "SessionStart";

function resolveHookCwd() {
  try {
    const hookInput = fs.readFileSync(0, "utf8");
    if (hookInput) {
      const parsed = JSON.parse(hookInput);
      if (typeof parsed.cwd === "string" && parsed.cwd) return parsed.cwd;
    }
  } catch {}
  return process.cwd();
}

function reapDeadJobs(cwd) {
  const all = listJobs(cwd);
  let reaped = 0;
  for (const j of all) {
    if (j.status === "running" && !isAlive(j.pid)) {
      j.status = "ended";
      j.ended_at = j.ended_at || new Date().toISOString();
      writeJobMeta(j.id, j, cwd);
      reaped++;
    }
  }
  return reaped;
}

try {
  const cwd = resolveHookCwd();
  const reaped = reapDeadJobs(cwd);
  pruneJobs(cwd);
  if (reaped > 0) {
    process.stdout.write(JSON.stringify({
      systemMessage: `grok-plugin: reaped ${reaped} orphaned job(s) on ${phase}`
    }) + "\n");
  }
  process.exit(0);
} catch (err) {
  process.stderr.write(`grok-plugin lifecycle (${phase}) error: ${err.message}\n`);
  process.exit(0);
}
