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

test("v0.9.5 (Grok HIGH #2 round-5): cmdTask records resume/continue provenance in job meta", () => {
  // Grok HIGH round-5: v0.9.4 advertised /grok:rescue --resume=<id>
  // but cmdTask only recorded `requested_session_id` in job meta —
  // the footer hint never surfaced when the session was started via
  // --resume or --continue.
  // v0.9.5 added requested_resume + requested_continue to the extra
  // block. Verify the source-shape (behavioral test would require
  // a fake-grok task spawn which is heavier than warranted here).
  const src = fs.readFileSync(COMPANION, "utf8");
  const cmdTask = src.slice(src.indexOf("async function cmdTask"), src.indexOf("// ----------", src.indexOf("async function cmdTask")));
  assert.match(cmdTask, /requested_resume:\s*flags\.resume/);
  assert.match(cmdTask, /requested_continue:\s*!!flags\.continue/);
  // And the footer surfaces all three entry points.
  assert.match(cmdTask, /typeof meta\.requested_resume === "string"/);
  assert.match(cmdTask, /meta\.requested_continue/);
});

test("v0.9.5 (3/3 round-5): rescue command + skills + agent all mention --resume / --continue", () => {
  const rescueMd = fs.readFileSync(
    new URL("../plugins/grok/commands/rescue.md", import.meta.url),
    "utf8"
  );
  const agentMd = fs.readFileSync(
    new URL("../plugins/grok/agents/grok-rescue.md", import.meta.url),
    "utf8"
  );
  const skillRuntime = fs.readFileSync(
    new URL("../plugins/grok/skills/grok-cli-runtime/SKILL.md", import.meta.url),
    "utf8"
  );
  const skillPrompting = fs.readFileSync(
    new URL("../plugins/grok/skills/grok-prompting/SKILL.md", import.meta.url),
    "utf8"
  );
  // All four files must mention --resume + --continue per Grok HIGH #1
  // round-5: the v0.9.4 fix was incomplete because rescue.md and the
  // two skills were not updated alongside the agent prompt.
  for (const [name, content] of [["rescue.md", rescueMd], ["grok-rescue.md", agentMd], ["grok-cli-runtime/SKILL.md", skillRuntime], ["grok-prompting/SKILL.md", skillPrompting]]) {
    assert.match(content, /--resume/, `${name} must mention --resume`);
    assert.match(content, /--continue/, `${name} must mention --continue`);
  }
});

test("v0.9.2 (3/3 round-2): top-level dispatch does NOT enable short aliases (prompt safety)", () => {
  // v0.9.1 enabled short aliases globally → `/grok:ask explain grep
  // -r foo` set resume=true and dropped foo. v0.9.2 (Codex P2 #2 +
  // Gemini Important #3) removes them from the top-level parseArgs call.
  const r = parseArgs(["-r", "foo", "bar"], {
    boolFlags: COMMON_BOOL_FLAGS,
    valueFlags: COMMON_VALUE_FLAGS,
    repeatableFlags: COMMON_REPEATABLE_FLAGS,
    optionalValueFlags: COMMON_OPTIONAL_VALUE_FLAGS
    // NO shortAliases passed — same as the top-level main() dispatch.
  });
  assert.equal(r.flags.resume, undefined, "without shortAliases, -r must NOT set resume");
  // `-r` becomes positional, where the wrapper would refuse it as a
  // flag-like positional unless allowFlagLikePositionals is set.
  assert.deepEqual(r.positional, ["-r", "foo", "bar"]);
});

test("v0.9.2: parser still SUPPORTS shortAliases when callers opt in (feature available, off by default)", () => {
  const r = parseArgs(["-r", "session-1", "task"], {
    boolFlags: COMMON_BOOL_FLAGS,
    valueFlags: COMMON_VALUE_FLAGS,
    repeatableFlags: COMMON_REPEATABLE_FLAGS,
    optionalValueFlags: COMMON_OPTIONAL_VALUE_FLAGS,
    shortAliases: { r: "resume" }   // explicit opt-in
  });
  assert.equal(r.flags.resume, true);
});

test("v0.9.2 (Gemini Nit #4 round-2): control-byte denylist allows TAB + LF + CR for free-text positionals", t => {
  const d = makeFakeGrokDir(t);
  setFakeMode(d, "subcmd-list");
  // `memory add "multi\nline fact"` is a legitimate use case — the user
  // is storing a multi-line memory entry. TAB and CR are similarly
  // legitimate for pasted code or terminal output.
  const r = runComp(d, ["memory", "add", "fact1\nfact2"]);
  assert.equal(r.status, 0, `multi-line memory entry must be allowed; got: ${r.stderr}`);
});

test("v0.9.2: BEL (0x07) and ESC (0x1B) still blocked", t => {
  const d = makeFakeGrokDir(t);
  setFakeMode(d, "ok-plain");
  const r1 = runComp(d, ["worktree", "list\x07bell"]);
  assert.notEqual(r1.status, 0);
  assert.match(r1.stderr, /control bytes/i);
  const r2 = runComp(d, ["worktree", "list\x1b[31m"]);
  assert.notEqual(r2.status, 0);
});

test("v0.9.2 (Codex P3 + Grok MED round-2): EMPTY_VALUE returns exit 2 (usage error)", t => {
  const d = makeFakeGrokDir(t);
  setFakeMode(d, "ok-json");
  // `--worktree=` with empty inline triggers EMPTY_VALUE in parseArgs.
  // v0.9.1's main() catch only handled MISSING_VALUE → exited 1.
  // v0.9.2 catches both.
  const r = runComp(d, ["ask", "--worktree=", "what now"]);
  assert.equal(r.status, 2, "EMPTY_VALUE must exit 2 (usage), not 1 (fatal)");
  assert.match(r.stderr, /Empty value for --worktree/i);
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

test("v0.9.2 (3/3 round-2 critical): `--` terminator is re-emitted before literals when forwarding", t => {
  // v0.9.1 added the POSIX `--` terminator but DID NOT re-emit it when
  // building the forwarded argv → grok itself saw `sessions search
  // --timeout` and reinterpreted --timeout as a flag → the workaround
  // silently regressed. v0.9.2 re-inserts `--` before any literal
  // positionals so grok also treats them literally.
  const d = makeFakeGrokDir(t);
  setFakeMode(d, "subcmd-list");
  const r = runComp(d, ["sessions", "search", "--", "--timeout"]);
  assert.equal(r.status, 0, `sessions search via -- terminator must accept flag-like queries; got: ${r.stderr}`);
  const recorded = readArgs(d);
  // The forwarded argv must contain `--` immediately before the literals.
  const dashIdx = recorded.indexOf("--");
  assert.notEqual(dashIdx, -1, "`--` must be re-emitted in the forwarded argv");
  assert.equal(recorded[dashIdx + 1], "--timeout",
    "the literal `--timeout` must come AFTER the `--` so grok treats it as a positional");
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

test("v0.9.3 (Grok LOW #2 round-3): parseArgs returns literalStartIndex directly", () => {
  // Direct assertion on the return value, not just the side effect on
  // `positional`. A future refactor that breaks the index calculation
  // while preserving `positional` contents would only be caught here.
  const r1 = parseArgs(["a", "b", "--", "c", "d"], {});
  assert.equal(r1.literalStartIndex, 2, "literalStartIndex must point to the first post-terminator token (index 2: 'c')");
  assert.deepEqual(r1.positional, ["a", "b", "c", "d"]);
  // Slicing reproduces the regular vs literal split.
  assert.deepEqual(r1.positional.slice(0, r1.literalStartIndex), ["a", "b"]);
  assert.deepEqual(r1.positional.slice(r1.literalStartIndex), ["c", "d"]);

  // No terminator → literalStartIndex === -1
  const r2 = parseArgs(["a", "b"], {});
  assert.equal(r2.literalStartIndex, -1);

  // `--` immediately first → literalStartIndex === 0
  const r3 = parseArgs(["--", "a", "b"], {});
  assert.equal(r3.literalStartIndex, 0);
  assert.deepEqual(r3.positional, ["a", "b"]);
});

test("v0.9.3 (Grok LOW #1 round-3): control-byte refusal error uses JSON.stringify to defuse the bytes", t => {
  const d = makeFakeGrokDir(t);
  setFakeMode(d, "ok-plain");
  // A BEL byte is the canonical case — emitting it raw rings the terminal.
  const r = runComp(d, ["worktree", "list\x07bell"]);
  assert.notEqual(r.status, 0);
  // The error message must show the bytes as a visible  escape,
  // not emit them raw. JSON.stringify('\x07') = '"\\u0007"'.
  assert.match(r.stderr, /\\u0007/,
    "error message must render control bytes as visible \\u00XX escapes (Grok LOW #1)");
  // And it must NOT contain the raw BEL.
  assert.equal(r.stderr.includes("\x07"), false,
    "stderr must not contain the raw control byte");
});

test("v0.9.3 (Gemini Nit #1 round-3): allowFlagLikePositionals removed from wrapper signature", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  // The parameter should be gone from the function signature.
  const sigLine = src.slice(src.indexOf("function cmdGrokSubcommandPassthrough"));
  const closeParen = sigLine.indexOf(")");
  assert.equal(sigLine.slice(0, closeParen).includes("allowFlagLikePositionals"), false,
    "dead `allowFlagLikePositionals` parameter must be removed");
});

test("v0.9.3 (Gemini Nit #2 round-3): allowed flag values use the same control-byte denylist as positionals", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  // The flag-value validation should use CONTROL_BYTE_FREETEXT_DENYLIST,
  // not the inline strict regex from v0.9.2.
  const block = src.slice(src.indexOf("for (const [k, v] of Object.entries(flags))"), src.indexOf("const argv = [subcommand"));
  assert.match(block, /CONTROL_BYTE_FREETEXT_DENYLIST\.test\(sv\)/);
  assert.equal(block.includes('/[\\x00-\\x1f\\x7f]/.test(sv)'), false,
    "old inline strict regex must be replaced with the named constant");
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
