import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import {
  newJobId,
  isValidJobId,
  JOB_ID_PATTERN,
  writeJobMeta,
  readJobMeta,
  listJobs,
  pruneJobs,
  purgeJobs,
  safeJobLogPath,
  readConfig,
  setReviewGate,
  setActiveModel,
  PLUGIN_DATA_ENV
} from "../plugins/grok/scripts/lib/state.mjs";

function withTempPluginData(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-state-test-"));
  const previous = process.env[PLUGIN_DATA_ENV];
  process.env[PLUGIN_DATA_ENV] = dir;
  try {
    return fn(dir);
  } finally {
    if (previous === undefined) delete process.env[PLUGIN_DATA_ENV];
    else process.env[PLUGIN_DATA_ENV] = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("newJobId uses the x- prefix to avoid collisions with Gemini's g- prefix", () => {
  const id = newJobId();
  assert.match(id, /^x-/);
  assert.ok(JOB_ID_PATTERN.test(id), `id ${id} should match JOB_ID_PATTERN`);
  assert.ok(isValidJobId(id));
});

test("isValidJobId rejects path-traversal attempts", () => {
  assert.equal(isValidJobId("../../etc/passwd"), false);
  assert.equal(isValidJobId("x-../etc/passwd"), false);
  assert.equal(isValidJobId(""), false);
  assert.equal(isValidJobId(null), false);
  assert.equal(isValidJobId({ id: "x-abc-1234" }), false);
});

test("isValidJobId only allows the expected x-<ts>-<rand> shape", () => {
  assert.equal(isValidJobId("x-abc123-def4"), true);
  assert.equal(isValidJobId("x-abc"), false);            // no random suffix
  assert.equal(isValidJobId("g-abc123-def4"), false);    // gemini prefix
});

test("writeJobMeta + readJobMeta round-trip a job", () => {
  withTempPluginData(() => {
    const id = newJobId();
    const meta = {
      version: 1,
      id,
      kind: "task",
      pid: 12345,
      status: "running",
      started_at: new Date().toISOString(),
      stdout_path: "ignored",
      stderr_path: "ignored",
      task_text: "do the thing"
    };
    writeJobMeta(id, meta);
    const round = readJobMeta(id);
    assert.equal(round.id, id);
    assert.equal(round.kind, "task");
    assert.equal(round.task_text, "do the thing");
  });
});

test("writeJobMeta rejects an invalid jobId", () => {
  withTempPluginData(() => {
    assert.throws(() => writeJobMeta("not-a-valid-id", { id: "not-a-valid-id" }));
  });
});

test("listJobs sorts by started_at descending", () => {
  withTempPluginData(() => {
    const meta1 = {
      version: 1,
      id: newJobId(),
      kind: "task",
      status: "completed",
      started_at: "2026-01-01T00:00:00Z",
      stdout_path: "",
      stderr_path: "",
      task_text: "old"
    };
    // Sleep a tick to guarantee a different newJobId() value, then write
    // a second job with a newer started_at.
    const meta2 = {
      version: 1,
      id: newJobId() + "x",  // ensure unique id even within the same ms tick
      kind: "task",
      status: "completed",
      started_at: "2026-05-01T00:00:00Z",
      stdout_path: "",
      stderr_path: "",
      task_text: "new"
    };
    // The unique-id hack above breaks JOB_ID_PATTERN, so use proper unique
    // ids by inserting an artificial delay between the two newJobId calls.
    const id1 = newJobId();
    meta1.id = id1;
    writeJobMeta(id1, meta1);

    // Force second id to differ
    const id2 = "x-" + (Date.now() + 1).toString(36) + "-" + Math.random().toString(36).slice(2, 6);
    meta2.id = id2;
    writeJobMeta(id2, meta2);

    const all = listJobs();
    assert.equal(all.length, 2);
    assert.equal(all[0].id, id2);  // newer one first
    assert.equal(all[1].id, id1);
  });
});

test("safeJobLogPath rejects paths outside the jobs dir", () => {
  withTempPluginData(() => {
    assert.equal(safeJobLogPath("/etc/passwd"), null);
    assert.equal(safeJobLogPath("../../../etc/passwd"), null);
    assert.equal(safeJobLogPath(""), null);
    assert.equal(safeJobLogPath(null), null);
  });
});

test("setReviewGate persists the toggle through readConfig", () => {
  withTempPluginData(() => {
    setReviewGate(process.cwd(), true);
    assert.equal(readConfig().reviewGateEnabled, true);
    setReviewGate(process.cwd(), false);
    assert.equal(readConfig().reviewGateEnabled, false);
  });
});

test("setActiveModel rejects model ids with shell metacharacters", () => {
  withTempPluginData(() => {
    assert.throws(() => setActiveModel(process.cwd(), "grok'; rm -rf /;"));
    assert.throws(() => setActiveModel(process.cwd(), "../etc/passwd"));
    assert.throws(() => setActiveModel(process.cwd(), "a".repeat(100)));
  });
});

test("setActiveModel accepts well-formed model ids", () => {
  withTempPluginData(() => {
    setActiveModel(process.cwd(), "grok-build");
    assert.equal(readConfig().activeModel, "grok-build");
  });
});

test("setActiveModel(null) clears the persisted model", () => {
  withTempPluginData(() => {
    setActiveModel(process.cwd(), "grok-build");
    setActiveModel(process.cwd(), null);
    assert.equal(readConfig().activeModel, undefined);
  });
});

test("purgeJobs removes non-running jobs and returns the count", () => {
  withTempPluginData(() => {
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const id = "x-" + (Date.now() + i).toString(36) + "-" + Math.random().toString(36).slice(2, 6);
      ids.push(id);
      writeJobMeta(id, {
        version: 1,
        id,
        kind: "task",
        status: i === 0 ? "running" : "completed",
        started_at: new Date(Date.now() - i * 1000).toISOString(),
        stdout_path: "",
        stderr_path: "",
        task_text: `job ${i}`
      });
    }
    const purged = purgeJobs({});
    // 4 non-running jobs should be purged; the single running one should remain.
    assert.equal(purged, 4);
    const remaining = listJobs();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].status, "running");
  });
});
