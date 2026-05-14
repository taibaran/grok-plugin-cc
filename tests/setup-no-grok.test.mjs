// Smoke test: when `grok` is not on PATH, /grok:setup must still produce a
// well-formed JSON report. This is the same contract CI's smoke job exercises,
// but run as a normal unit test so failures show up at `npm test` time.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const COMPANION_PATH = new URL("../plugins/grok/scripts/companion.mjs", import.meta.url).pathname;

function withTempPluginData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-setup-smoke-"));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("setup --json with grok unreachable returns a parseable report and exits 1", () => {
  // Drop `grok` from PATH so `which("grok")` returns null inside the
  // companion. The companion must still print a complete report.
  const { dir, cleanup } = withTempPluginData();
  try {
    const r = spawnSync(process.execPath, [COMPANION_PATH, "setup", "--json"], {
      encoding: "utf8",
      env: {
        // /usr/bin and /bin do not contain grok on any reasonable machine
        PATH: "/usr/bin:/bin",
        HOME: process.env.HOME || "",
        CLAUDE_PLUGIN_DATA: dir
      }
    });
    // Companion returns exit 1 when not ready, not 127 — that's the
    // documented contract. 127 only fires when an action-subcommand
    // (ask/review/task) tries to actually spawn grok.
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}. stderr: ${r.stderr}`);

    let parsed;
    try { parsed = JSON.parse(r.stdout); }
    catch (e) {
      assert.fail(`stdout was not valid JSON: ${e.message}. stdout: ${r.stdout.slice(0, 400)}`);
    }

    assert.equal(parsed.ready, false, "ready must be false when grok is missing");
    assert.equal(parsed.grok.available, false, "grok.available must be false");
    // The report should include an installation next-step, with the
    // official xAI install URL — not a third-party domain.
    assert.ok(Array.isArray(parsed.nextSteps), "nextSteps must be an array");
    const installStep = parsed.nextSteps.find(s => /Install Grok CLI/i.test(s));
    assert.ok(installStep, "nextSteps must include an install hint");
    assert.match(installStep, /x\.ai\/cli\/install\.sh/, "install hint must point at the official x.ai installer");
  } finally {
    cleanup();
  }
});

test("setup --enable-review-gate followed by --json reports it as enabled", () => {
  // This test only relies on the config-toggle path, which works even without
  // grok installed (the toggle happens before the auth probe).
  const { dir, cleanup } = withTempPluginData();
  try {
    const enable = spawnSync(process.execPath, [COMPANION_PATH, "setup", "--enable-review-gate", "--json"], {
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        HOME: process.env.HOME || "",
        CLAUDE_PLUGIN_DATA: dir
      }
    });
    const parsed = JSON.parse(enable.stdout);
    assert.equal(parsed.reviewGateEnabled, true);
    assert.ok(parsed.actionsTaken.some(s => /Enabled the stop-time review gate/i.test(s)));
  } finally {
    cleanup();
  }
});
