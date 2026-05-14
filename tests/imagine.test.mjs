// Unit tests for the /grok:imagine helpers. The actual subprocess spawn is
// not exercised here — that's covered by manual E2E. We just verify the
// source-level wiring + the path-extraction helper.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

const COMPANION_PATH = new URL("../plugins/grok/scripts/companion.mjs", import.meta.url).pathname;

test("companion.mjs defines DEFAULT_IMAGE_TIMEOUT_MS and DEFAULT_VIDEO_TIMEOUT_MS", () => {
  const source = fs.readFileSync(COMPANION_PATH, "utf8");
  assert.match(source, /DEFAULT_IMAGE_TIMEOUT_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/);
  assert.match(source, /DEFAULT_VIDEO_TIMEOUT_MS\s*=\s*15\s*\*\s*60\s*\*\s*1000/);
});

test("companion.mjs extractMediaPath helper is wired up", () => {
  const source = fs.readFileSync(COMPANION_PATH, "utf8");
  assert.match(source, /function extractMediaPath\(/);
  // The helper must look for the markdown `![alt](path)` shape Grok uses.
  // The source contains the literal substring `text.match(/!\[`, which is
  // the start of the regex `!\[[^\]]*\]\(([^)]+)\)`.
  assert.ok(source.includes("text.match(/!\\["),
    "extractMediaPath must use the `![alt](path)` markdown regex");
});

test("companion.mjs cmdImagine routes /imagine and /imagine-video distinctly", () => {
  const source = fs.readFileSync(COMPANION_PATH, "utf8");
  // The cmdImagine function takes a second arg { video } that flips between
  // the two slash commands.
  assert.match(source, /async function cmdImagine\(\{[^}]*\},\s*\{\s*video\s*\}\)/);
  // The slash command itself must be derived from the video flag.
  assert.match(source, /video\s*\?\s*"\/imagine-video"\s*:\s*"\/imagine"/);
});

test("companion.mjs rejects descriptions with control bytes (defense-in-depth)", () => {
  // The companion refuses control characters in the description before
  // shipping it to the child process. Use \x07 (BEL) because Node's
  // spawnSync rejects \x00 outright before our code runs — \x07 makes it
  // through Node and into our refusal path.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-imagine-test-"));
  try {
    const r = spawnSync(process.execPath, [COMPANION_PATH, "imagine", "an apple\x07stitched in"], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH || "/usr/bin:/bin",
        HOME: process.env.HOME || "",
        CLAUDE_PLUGIN_DATA: dir
      }
    });
    assert.equal(r.status, 2, `expected exit 2 (refusal), got ${r.status}. stderr: ${r.stderr}`);
    assert.match(r.stderr, /control bytes/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("companion.mjs imagine usage error exits 2 with a helpful message", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-imagine-usage-"));
  try {
    const r = spawnSync(process.execPath, [COMPANION_PATH, "imagine"], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH || "/usr/bin:/bin",
        HOME: process.env.HOME || "",
        CLAUDE_PLUGIN_DATA: dir
      }
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Usage:/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("companion.mjs imagine-video usage error mentions imagine-video subcommand by name", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-imagine-vid-usage-"));
  try {
    const r = spawnSync(process.execPath, [COMPANION_PATH, "imagine-video"], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH || "/usr/bin:/bin",
        HOME: process.env.HOME || "",
        CLAUDE_PLUGIN_DATA: dir
      }
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /imagine-video/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
