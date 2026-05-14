// Regression tests for the Codex-flagged `safeJobLogPath` symlink bypass.
//
// Old behavior: a symlink planted INSIDE jobsDir (so the plain dirname check
// passed) that pointed OUTSIDE jobsDir was followed and returned — letting
// `/grok:result <id>` read any file the user could read.
//
// New behavior: realpath of the file's parent must equal the realpath of
// jobsDir. Plain string check + realpath check both gate the return.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { safeJobLogPath, jobsDir, PLUGIN_DATA_ENV } from "../plugins/grok/scripts/lib/state.mjs";

function withFixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-symlink-test-"));
  const previous = process.env[PLUGIN_DATA_ENV];
  process.env[PLUGIN_DATA_ENV] = root;
  try {
    const jobs = jobsDir();
    fs.mkdirSync(jobs, { recursive: true });
    return fn({ root, jobs });
  } finally {
    if (previous === undefined) delete process.env[PLUGIN_DATA_ENV];
    else process.env[PLUGIN_DATA_ENV] = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("safeJobLogPath accepts a regular file inside jobsDir", () => {
  withFixture(({ jobs }) => {
    const f = path.join(jobs, "x-abc-1234.stdout.log");
    fs.writeFileSync(f, "ok");
    const out = safeJobLogPath(f);
    assert.ok(out, "expected a non-null safe path for a regular file in jobsDir");
    // The returned path must point at our file (after realpath canonicalization).
    assert.equal(fs.realpathSync.native(out), fs.realpathSync.native(f));
  });
});

test("safeJobLogPath rejects a symlink planted inside jobsDir pointing OUTSIDE (Codex bug)", () => {
  withFixture(({ root, jobs }) => {
    // Plant `/etc/hosts` (a file every macOS / Linux user can read) and a
    // symlink inside jobsDir that points at it. Old code would return
    // `/etc/hosts` because the symlink's `path.dirname` was jobsDir.
    const linkPath = path.join(jobs, "x-evil-0001.stdout.log");
    fs.symlinkSync("/etc/hosts", linkPath);
    const out = safeJobLogPath(linkPath);
    assert.equal(out, null,
      `expected null for a symlink that escapes jobsDir, got ${out}`);
  });
});

test("safeJobLogPath rejects a path that string-resolves outside jobsDir", () => {
  withFixture(({ jobs }) => {
    // No FS at all — `../../../etc/passwd` should be rejected by the
    // plain string check before we touch any inode.
    const out = safeJobLogPath(path.join(jobs, "..", "..", "..", "etc", "passwd"));
    assert.equal(out, null);
  });
});

test("safeJobLogPath accepts a not-yet-existing path inside jobsDir", () => {
  withFixture(({ jobs }) => {
    // Fresh job: writeJobMeta sets stdout_path before the file exists.
    // safeJobLogPath must accept it (so the eventual write can happen) as
    // long as the path string is inside jobsDir.
    const future = path.join(jobs, "x-future-9999.stdout.log");
    assert.equal(fs.existsSync(future), false);
    const out = safeJobLogPath(future);
    assert.ok(out, "expected non-null for a fresh path inside jobsDir");
  });
});

test("safeJobLogPath rejects a symlink chain that eventually escapes jobsDir", () => {
  withFixture(({ root, jobs }) => {
    // A → B → /etc/hosts. Even an indirect chain must be caught by realpath.
    const outsideTarget = "/etc/hosts";
    const linkB = path.join(root, "intermediate-link");
    fs.symlinkSync(outsideTarget, linkB);
    const linkA = path.join(jobs, "x-chain-0002.stdout.log");
    fs.symlinkSync(linkB, linkA);
    const out = safeJobLogPath(linkA);
    assert.equal(out, null,
      `expected null for chain-symlink that escapes jobsDir, got ${out}`);
  });
});

test("safeJobLogPath rejects empty / null / non-string", () => {
  withFixture(() => {
    assert.equal(safeJobLogPath(""), null);
    assert.equal(safeJobLogPath(null), null);
    assert.equal(safeJobLogPath(undefined), null);
    assert.equal(safeJobLogPath(12345), null);
    assert.equal(safeJobLogPath({}), null);
  });
});
