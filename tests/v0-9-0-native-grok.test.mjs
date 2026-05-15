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

test("v0.9.1: --worktree my-feature (space form) treats my-feature as positional, NOT the worktree name", () => {
  // v0.9.1 removed the peek-ahead semantics that ate prompt tokens.
  // To set a named worktree, users must use --worktree=name (inline `=`).
  // Space form: --worktree is bool, next token is part of the prompt.
  const r = parseArgs(["--worktree", "my-feature", "fix bug"], {
    boolFlags: COMMON_BOOL_FLAGS,
    valueFlags: COMMON_VALUE_FLAGS,
    repeatableFlags: COMMON_REPEATABLE_FLAGS,
    optionalValueFlags: COMMON_OPTIONAL_VALUE_FLAGS
  });
  assert.equal(r.flags.worktree, true);
  assert.deepEqual(r.positional, ["my-feature", "fix bug"]);
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

test("v0.9.1: --resume abc-123 space form treats id as positional (use --resume=abc-123 for named)", () => {
  const a = parseArgs(["--resume", "abc-123", "--continue"], {
    boolFlags: COMMON_BOOL_FLAGS,
    valueFlags: COMMON_VALUE_FLAGS,
    repeatableFlags: COMMON_REPEATABLE_FLAGS,
    optionalValueFlags: COMMON_OPTIONAL_VALUE_FLAGS
  });
  assert.equal(a.flags.resume, true);
  assert.equal(a.flags.continue, true);
  assert.deepEqual(a.positional, ["abc-123"]);
});

test("v0.9.1: --resume=abc-123 inline form parses the id as the value", () => {
  const r = parseArgs(["--resume=abc-123", "what next"], {
    boolFlags: COMMON_BOOL_FLAGS,
    valueFlags: COMMON_VALUE_FLAGS,
    repeatableFlags: COMMON_REPEATABLE_FLAGS,
    optionalValueFlags: COMMON_OPTIONAL_VALUE_FLAGS
  });
  assert.equal(r.flags.resume, "abc-123");
  assert.deepEqual(r.positional, ["what next"]);
});

test("v0.9.1: --worktree= (empty inline) throws — user must pick true or a value", () => {
  assert.throws(() => parseArgs(["--worktree=", "task"], {
    boolFlags: COMMON_BOOL_FLAGS,
    valueFlags: COMMON_VALUE_FLAGS,
    repeatableFlags: COMMON_REPEATABLE_FLAGS,
    optionalValueFlags: COMMON_OPTIONAL_VALUE_FLAGS
  }), /Empty value for --worktree/i);
});

test("v0.9.1: --worktree=false treats as bool false", () => {
  const r = parseArgs(["--worktree=false", "task"], {
    boolFlags: COMMON_BOOL_FLAGS,
    valueFlags: COMMON_VALUE_FLAGS,
    repeatableFlags: COMMON_REPEATABLE_FLAGS,
    optionalValueFlags: COMMON_OPTIONAL_VALUE_FLAGS
  });
  assert.equal(r.flags.worktree, false);
});

test("v0.9.1 (Codex round-1): short-flag aliases -w / -r / -c", () => {
  const r1 = parseArgs(["-r", "session-1", "task"], {
    boolFlags: COMMON_BOOL_FLAGS,
    valueFlags: COMMON_VALUE_FLAGS,
    repeatableFlags: COMMON_REPEATABLE_FLAGS,
    optionalValueFlags: COMMON_OPTIONAL_VALUE_FLAGS,
    shortAliases: { r: "resume" }
  });
  // -r without `=` is bool form (same semantics as --resume)
  assert.equal(r1.flags.resume, true);
  assert.deepEqual(r1.positional, ["session-1", "task"]);

  // -rsession-id bundled form rewrites to --resume=session-id
  const r2 = parseArgs(["-rabc-xyz", "task"], {
    boolFlags: COMMON_BOOL_FLAGS,
    valueFlags: COMMON_VALUE_FLAGS,
    repeatableFlags: COMMON_REPEATABLE_FLAGS,
    optionalValueFlags: COMMON_OPTIONAL_VALUE_FLAGS,
    shortAliases: { r: "resume" }
  });
  assert.equal(r2.flags.resume, "abc-xyz");

  // -c (continue) — bool flag
  const r3 = parseArgs(["-c", "task"], {
    boolFlags: new Set(["continue"]),
    shortAliases: { c: "continue" }
  });
  assert.equal(r3.flags.continue, true);
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

test("v0.9.1 SECURITY: subcommand passthrough refuses CONTROL BYTES in positional args", t => {
  // v0.9.1 widened the allowlist (was over-rejecting valid MCP URLs).
  // spawnSync is no-shell so shell-meta like `; rm -rf /` is safe — it
  // becomes a literal argv string passed to grok, which would reject it
  // as an unknown subcommand. The real defense is against control bytes
  // (which get rendered when grok echoes the bad arg back).
  const d = makeFakeGrokDir(t);
  setFakeMode(d, "ok-plain");
  // Control byte (0x07 BEL) must still be refused.
  const r = runComp(d, ["worktree", "list\x07bell"]);
  assert.notEqual(r.status, 0,
    "control bytes in positional must be refused");
  assert.match(r.stderr, /control bytes/i);
});

test("v0.9.1: MCP URLs with ? & % # are accepted", t => {
  const d = makeFakeGrokDir(t);
  setFakeMode(d, "subcmd-list");
  // Real-world MCP URL with query params + fragment.
  const r = runComp(d, ["mcp", "add", "myserver", "https://example.com/api?token=abc&format=json#prod"]);
  assert.equal(r.status, 0, `MCP URL must be forwarded; got stderr: ${r.stderr}`);
  const recorded = readArgs(d);
  assert.equal(recorded[0], "mcp");
  assert.ok(recorded.includes("https://example.com/api?token=abc&format=json#prod"));
});

test("v0.9.1: /grok:sessions search with `--` terminator allows flag-like text", t => {
  const d = makeFakeGrokDir(t);
  setFakeMode(d, "subcmd-list");
  // POSIX `--` terminator: everything after is literal positional.
  // Users wanting to search for previous "--timeout" mentions type:
  //   /grok:sessions search -- --timeout
  const r = runComp(d, ["sessions", "search", "--", "--timeout"]);
  assert.equal(r.status, 0, `sessions search via -- terminator must accept flag-like queries; got: ${r.stderr}`);
  const recorded = readArgs(d);
  assert.ok(recorded.includes("--timeout"),
    "the literal `--timeout` must reach grok as a positional argv after `--`");
});

test("v0.9.1: POSIX `--` terminator collects everything after as positional", () => {
  const r = parseArgs(["--continue", "--", "--worktree", "task"], {
    boolFlags: COMMON_BOOL_FLAGS,
    valueFlags: COMMON_VALUE_FLAGS,
    repeatableFlags: COMMON_REPEATABLE_FLAGS,
    optionalValueFlags: COMMON_OPTIONAL_VALUE_FLAGS
  });
  assert.equal(r.flags.continue, true);
  // After `--`, both `--worktree` and `task` are literal positionals.
  assert.deepEqual(r.positional, ["--worktree", "task"]);
});

test("v0.9.1: /grok:worktree still refuses flag-like positionals (no opt-in for this subcmd)", t => {
  const d = makeFakeGrokDir(t);
  setFakeMode(d, "ok-plain");
  const r = runComp(d, ["worktree", "list", "--bad-flag"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Refusing to forward unknown flag-like/i);
});

test("v0.9.1 (Grok MED round-1): --timeout passes through subcommand wrappers", t => {
  const d = makeFakeGrokDir(t);
  setFakeMode(d, "subcmd-list");
  // --timeout was in the .md arg-hints but dropped by allowFlags before
  // v0.9.1. After the fix it's in SUBCMD_BASE_ALLOW for all 4 wrappers.
  const r = runComp(d, ["worktree", "list", "--timeout", "60s"]);
  assert.equal(r.status, 0);
  const recorded = readArgs(d);
  // Note: --timeout drives spawnSync's timeout AND is forwarded to grok.
  assert.ok(recorded.includes("--timeout"),
    "--timeout must be forwarded to grok (was dropped by allowFlags before v0.9.1)");
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
