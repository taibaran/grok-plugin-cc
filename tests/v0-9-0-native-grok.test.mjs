// v0.9.0 behavior tests — worktree / sessions / memory / mcp commands
// + session/worktree/resume/memory passthrough flags.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  parseArgs,
  COMMON_BOOL_FLAGS, COMMON_VALUE_FLAGS,
  COMMON_REPEATABLE_FLAGS, COMMON_OPTIONAL_VALUE_FLAGS
} from "../plugins/grok/scripts/lib/args.mjs";
import { grokBaseArgs } from "../plugins/grok/scripts/lib/grok.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPANION = path.resolve(__dirname, "../plugins/grok/scripts/companion.mjs");

// Re-use fake-grok pattern from v0.6.0/v0.8.0 test files.
function makeFakeGrokDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-fakebin-v09-"));
  fs.writeFileSync(path.join(dir, "grok"), `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const here = path.dirname(process.argv[1]);
fs.writeFileSync(path.join(here, "args.json"), JSON.stringify(process.argv.slice(2), null, 2));
let mode = "ok-plain";
try { mode = fs.readFileSync(path.join(here, "mode"), "utf8").trim(); } catch {}
if (mode === "ok-plain") { console.log("FAKE_OK"); process.exit(0); }
if (mode === "ok-json") {
  process.stdout.write(JSON.stringify({ text: "ok", stopReason: "EndTurn", sessionId: "fake" }) + "\\n");
  process.exit(0);
}
if (mode === "subcmd-list") { console.log("session-1\\nsession-2"); process.exit(0); }
console.log("ok");
process.exit(0);
`, { mode: 0o755 });
  fs.chmodSync(path.join(dir, "grok"), 0o755);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function setFakeMode(d, m) { fs.writeFileSync(path.join(d, "mode"), m); }
function readArgs(d) { return JSON.parse(fs.readFileSync(path.join(d, "args.json"), "utf8")); }
function runComp(d, argv, env = {}) {
  return spawnSync(process.execPath, [COMPANION, ...argv], {
    encoding: "utf8",
    env: { ...process.env, ...env, PATH: `${d}:${process.env.PATH}` }
  });
}

// ============================================================================
// Parser: optional-value flags
// ============================================================================

test("v0.9.0: --worktree as the final token parses as true (bool form)", () => {
  // The optional-value parser logic: if the next token doesn't start with
  // `--`, it's consumed as the value. With nothing after, --worktree is
  // bool. Note: a positional that doesn't start with `--` after --worktree
  // would be consumed as the worktree name — that's the inherent
  // ambiguity of optional-value flags and matches how grok itself
  // parses `-w/--worktree [<NAME>]`. Users wanting bare --worktree +
  // a free-form prompt should use `--worktree --` or `--worktree=`.
  const r = parseArgs(["--worktree"], {
    boolFlags: COMMON_BOOL_FLAGS,
    valueFlags: COMMON_VALUE_FLAGS,
    repeatableFlags: COMMON_REPEATABLE_FLAGS,
    optionalValueFlags: COMMON_OPTIONAL_VALUE_FLAGS
  });
  assert.equal(r.flags.worktree, true);
  assert.deepEqual(r.positional, []);
});

test("v0.9.0: --worktree before a `--`-prefixed flag stays bool", () => {
  const r = parseArgs(["--worktree", "--continue", "task"], {
    boolFlags: COMMON_BOOL_FLAGS,
    valueFlags: COMMON_VALUE_FLAGS,
    repeatableFlags: COMMON_REPEATABLE_FLAGS,
    optionalValueFlags: COMMON_OPTIONAL_VALUE_FLAGS
  });
  assert.equal(r.flags.worktree, true);
  assert.equal(r.flags.continue, true);
  assert.deepEqual(r.positional, ["task"]);
});

test("v0.9.0: --worktree <name> parses as named (value form)", () => {
  const r = parseArgs(["--worktree", "my-feature", "fix bug"], {
    boolFlags: COMMON_BOOL_FLAGS,
    valueFlags: COMMON_VALUE_FLAGS,
    repeatableFlags: COMMON_REPEATABLE_FLAGS,
    optionalValueFlags: COMMON_OPTIONAL_VALUE_FLAGS
  });
  assert.equal(r.flags.worktree, "my-feature");
  assert.deepEqual(r.positional, ["fix bug"]);
});

test("v0.9.0: --worktree=name inline form", () => {
  const r = parseArgs(["--worktree=hot-fix", "task"], {
    boolFlags: COMMON_BOOL_FLAGS,
    valueFlags: COMMON_VALUE_FLAGS,
    repeatableFlags: COMMON_REPEATABLE_FLAGS,
    optionalValueFlags: COMMON_OPTIONAL_VALUE_FLAGS
  });
  assert.equal(r.flags.worktree, "hot-fix");
});

test("v0.9.0: --worktree followed by --other flag treats --worktree as bool", () => {
  const r = parseArgs(["--worktree", "--continue", "task"], {
    boolFlags: COMMON_BOOL_FLAGS,
    valueFlags: COMMON_VALUE_FLAGS,
    repeatableFlags: COMMON_REPEATABLE_FLAGS,
    optionalValueFlags: COMMON_OPTIONAL_VALUE_FLAGS
  });
  assert.equal(r.flags.worktree, true, "next-token-starts-with-`--` must keep worktree as bool");
  assert.equal(r.flags.continue, true);
});

test("v0.9.0: --resume <id> parses the id as the value", () => {
  const a = parseArgs(["--resume", "abc-123", "--continue"], {
    boolFlags: COMMON_BOOL_FLAGS,
    valueFlags: COMMON_VALUE_FLAGS,
    repeatableFlags: COMMON_REPEATABLE_FLAGS,
    optionalValueFlags: COMMON_OPTIONAL_VALUE_FLAGS
  });
  assert.equal(a.flags.resume, "abc-123");
  assert.equal(a.flags.continue, true);
});

test("v0.9.0: bare --resume (no following token) is bool form", () => {
  const r = parseArgs(["--resume"], {
    boolFlags: COMMON_BOOL_FLAGS,
    valueFlags: COMMON_VALUE_FLAGS,
    repeatableFlags: COMMON_REPEATABLE_FLAGS,
    optionalValueFlags: COMMON_OPTIONAL_VALUE_FLAGS
  });
  assert.equal(r.flags.resume, true);
});

// ============================================================================
// grokBaseArgs: session / worktree / memory passthroughs
// ============================================================================

test("v0.9.0: grokBaseArgs --worktree (bool) emits bare --worktree", () => {
  const args = grokBaseArgs({ worktree: true });
  assert.ok(args.includes("--worktree"));
  // No value follows.
  const i = args.indexOf("--worktree");
  assert.ok(i === args.length - 1 || args[i + 1].startsWith("--"));
});

test("v0.9.0: grokBaseArgs --worktree (named) emits --worktree <name>", () => {
  const args = grokBaseArgs({ worktree: "my-fix" });
  const i = args.indexOf("--worktree");
  assert.equal(args[i + 1], "my-fix");
});

test("v0.9.0: grokBaseArgs rejects worktree name with control bytes", () => {
  assert.throws(() => grokBaseArgs({ worktree: "evil\nname" }), /control bytes|name invalid/i);
});

test("v0.9.0: grokBaseArgs rejects worktree name with `/`", () => {
  assert.throws(() => grokBaseArgs({ worktree: "../escape" }), /invalid/i);
});

test("v0.9.0: grokBaseArgs --continue emits --continue", () => {
  const args = grokBaseArgs({ continueSession: true });
  assert.ok(args.includes("--continue"));
});

test("v0.9.0: grokBaseArgs --resume <id> emits --resume <id>", () => {
  const args = grokBaseArgs({ resume: "session-xyz" });
  const i = args.indexOf("--resume");
  assert.equal(args[i + 1], "session-xyz");
});

test("v0.9.0: grokBaseArgs --resume (bool) emits bare --resume", () => {
  const args = grokBaseArgs({ resume: true });
  assert.ok(args.includes("--resume"));
});

test("v0.9.0: grokBaseArgs --restore-code", () => {
  const args = grokBaseArgs({ restoreCode: true });
  assert.ok(args.includes("--restore-code"));
});

test("v0.9.0: grokBaseArgs --no-memory + --experimental-memory mutex", () => {
  assert.throws(
    () => grokBaseArgs({ noMemory: true, experimentalMemory: true }),
    /mutually exclusive/i
  );
});

test("v0.9.0: grokBaseArgs --no-memory alone OK", () => {
  const args = grokBaseArgs({ noMemory: true });
  assert.ok(args.includes("--no-memory"));
});

test("v0.9.0: grokBaseArgs --experimental-memory alone OK", () => {
  const args = grokBaseArgs({ experimentalMemory: true });
  assert.ok(args.includes("--experimental-memory"));
});

// ============================================================================
// End-to-end subcommand passthrough
// ============================================================================

test("v0.9.0 E2E: /grok:worktree forwards to grok worktree subcommand", t => {
  const d = makeFakeGrokDir(t);
  setFakeMode(d, "subcmd-list");
  const r = runComp(d, ["worktree", "list"]);
  assert.equal(r.status, 0);
  const recorded = readArgs(d);
  assert.equal(recorded[0], "worktree");
  assert.equal(recorded[1], "list");
});

test("v0.9.0 E2E: /grok:sessions forwards to grok sessions", t => {
  const d = makeFakeGrokDir(t);
  setFakeMode(d, "subcmd-list");
  const r = runComp(d, ["sessions", "list", "--json"]);
  assert.equal(r.status, 0);
  const recorded = readArgs(d);
  assert.equal(recorded[0], "sessions");
  assert.equal(recorded[1], "list");
  assert.ok(recorded.includes("--json"));
});

test("v0.9.0 E2E: /grok:memory + /grok:mcp dispatch correctly", t => {
  const d = makeFakeGrokDir(t);
  setFakeMode(d, "ok-plain");
  const r1 = runComp(d, ["memory", "stats"]);
  assert.equal(r1.status, 0);
  assert.equal(readArgs(d)[0], "memory");
  const r2 = runComp(d, ["mcp", "list"]);
  assert.equal(r2.status, 0);
  assert.equal(readArgs(d)[0], "mcp");
});

test("v0.9.0 SECURITY: subcommand passthrough refuses shell-meta in positional args", t => {
  const d = makeFakeGrokDir(t);
  setFakeMode(d, "ok-plain");
  const r = runComp(d, ["worktree", "list; rm -rf /"]);
  assert.notEqual(r.status, 0,
    "shell metacharacters in positional must be refused (not forwarded to grok)");
  assert.match(r.stderr, /Refusing to forward/i);
});

test("v0.9.0 SECURITY: subcommand passthrough refuses unknown flag-like positionals", t => {
  const d = makeFakeGrokDir(t);
  setFakeMode(d, "subcmd-list");
  // --unknown is NOT in /grok:worktree's allow set. parseArgs puts unknown
  // flags into positional; cmdGrokSubcommandPassthrough refuses any
  // positional that starts with `--` so it doesn't get silently forwarded
  // to grok (where it would surface as a confusing "unknown option" stderr).
  const r = runComp(d, ["worktree", "list", "--unknown", "value"]);
  assert.notEqual(r.status, 0,
    "unknown `--*` arg in positional must be rejected, not forwarded");
  assert.match(r.stderr, /Refusing to forward unknown flag-like/i);
});

// ============================================================================
// capabilityProbe regression for the new flags
// ============================================================================

test("v0.9.0: capabilityProbe required list includes worktree/continue/resume/memory tokens", () => {
  const src = fs.readFileSync(
    new URL("../plugins/grok/scripts/lib/grok.mjs", import.meta.url),
    "utf8"
  );
  for (const tok of ["-w, --worktree", "-c, --continue", "-r, --resume", "--restore-code", "--no-memory", "--experimental-memory"]) {
    assert.ok(src.includes(`"${tok}"`),
      `capabilityProbe required list must include ${tok}`);
  }
});

test("v0.9.0: dispatcher routes worktree/sessions/memory/mcp", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  assert.match(src, /case "worktree":\s*return cmdWorktree/);
  assert.match(src, /case "sessions":\s*return cmdSessions/);
  assert.match(src, /case "memory":\s*return cmdMemory/);
  assert.match(src, /case "mcp":\s*return cmdMcp/);
});
