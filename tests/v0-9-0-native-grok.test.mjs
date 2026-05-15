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
import { grokBaseArgs, commandUsesJsonOutput } from "../plugins/grok/scripts/lib/grok.mjs";
// v0.9.9 (Gemini Nit round-9): moved from dynamic `await import()` to
// top-level imports for consistency with the rest of this file.
import { renderJobDetails, formatSessionHint, formatSessionLabel } from "../plugins/grok/scripts/lib/render.mjs";

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

test("v0.9.7 (3/3 round-7): formatSessionHint renders all 5 priority cases (from render.mjs)", async () => {
  // v0.9.7: moved from companion.mjs to lib/render.mjs (single source
  // of truth shared with renderJobDetails). Import path updated.
  // (formatSessionHint imported at top of file in v0.9.9)
  // Priority 1: explicit --session-id (use --session-id= for create-or-resume + grok -r for raw)
  const hint1 = formatSessionHint({ requested_session_id: "myname" });
  assert.match(hint1, /Session: myname/);
  assert.match(hint1, /--session-id=myname/);
  assert.match(hint1, /grok -r myname/, "Codex P2 round-7: use grok -r for raw-CLI half");

  // Priority 2: --resume=<id> (string)
  const hint2 = formatSessionHint({ requested_resume: "abc-123" });
  assert.match(hint2, /Resumed session: abc-123/, "Gemini Nit round-7: consistent 'Resumed session' label");
  assert.match(hint2, /--resume=abc-123/);
  assert.match(hint2, /grok -r abc-123/);

  // Priority 3: bare --resume (true)
  const hint3 = formatSessionHint({ requested_resume: true });
  assert.match(hint3, /Resumed most-recent/);
  assert.equal(hint3.includes("=true"), false, "bool form must not emit `=true`");

  // Priority 4: --continue
  const hint4 = formatSessionHint({ requested_continue: true });
  assert.match(hint4, /Continued most-recent/);
  assert.match(hint4, /grok -c/);

  // Priority 5: legacy meta.session_id — only for trusted kinds
  // (review + adversarial-review). v0.9.8 (Gemini Nit round-8): switched
  // from blacklist (!== "task") to whitelist for fail-closed safety.
  const hint5 = formatSessionHint({ session_id: "legacy-x", kind: "review" });
  assert.match(hint5, /Session: legacy-x/);
  assert.match(hint5, /--session-id=legacy-x/);
  const hint5b = formatSessionHint({ session_id: "legacy-y", kind: "adversarial-review" });
  assert.match(hint5b, /Session: legacy-y/);

  // Task is NOT in the whitelist — suppressed.
  assert.equal(formatSessionHint({ session_id: "from-model", kind: "task" }), null,
    "task-kind session_id must be suppressed");
  // Unknown kind (a future job type) must also be suppressed (fail-closed).
  assert.equal(formatSessionHint({ session_id: "x", kind: "interactive-chat" }), null,
    "v0.9.8: unknown kinds must NOT trust session_id (fail-closed whitelist)");
  // Missing kind — also suppressed (no kind = can't whitelist).
  assert.equal(formatSessionHint({ session_id: "x" }), null,
    "missing kind must NOT trust session_id");

  // No provenance → null
  assert.equal(formatSessionHint({}), null);
  assert.equal(formatSessionHint(null), null);
});

test("v0.9.8 (Grok LOW #1 round-8): renderJobDetails consolidation verified behaviorally (not source-grep)", async () => {
  // v0.9.7 used a brittle `fs.readFileSync` + indexOf slice + regex
  // test to assert renderJobDetails called formatSessionLabel. Grok
  // flagged it as a maintenance hazard. Replaced with two behavioral
  // assertions: (1) renderJobDetails surfaces the correct session
  // label for every priority case AND (2) it does NOT surface a
  // session label for a `kind: "task"` job with a `session_id`
  // (which would prove the duplicated chain has been removed —
  // formatSessionLabel correctly suppresses, the old ladder did not).
  // (renderJobDetails imported at top of file in v0.9.9)
  const baseMeta = {
    id: "x-test", kind: "review", status: "completed",
    started_at: "2026-05-15T00:00:00.000Z", task_text: "t"
  };
  // Each priority case must render the corresponding label.
  assert.match(renderJobDetails({ ...baseMeta, requested_session_id: "ID-A" }), /Session: ID-A/);
  assert.match(renderJobDetails({ ...baseMeta, requested_resume: "R-1" }), /Resumed session: R-1/);
  assert.match(renderJobDetails({ ...baseMeta, requested_resume: true }), /Resumed most-recent/);
  assert.match(renderJobDetails({ ...baseMeta, requested_continue: true }), /Continued most-recent/);
  assert.match(renderJobDetails({ ...baseMeta, session_id: "LEG", kind: "review" }), /Session: LEG/);
  // Task-kind session_id MUST NOT appear (regression guard against
  // re-introducing the duplicated chain that ignored the gate).
  const taskOut = renderJobDetails({ ...baseMeta, session_id: "from-model", kind: "task" });
  assert.equal(taskOut.includes("from-model"), false,
    "task-kind session_id must NOT appear in renderJobDetails (would prove the duplicate ladder is back)");
});

test("v0.9.6 (3/3 round-6): cmdTask still records all 3 entry points in job meta", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  const cmdTask = src.slice(src.indexOf("async function cmdTask"), src.indexOf("// ----------", src.indexOf("async function cmdTask")));
  assert.match(cmdTask, /requested_session_id:\s*flags\["session-id"\]/);
  assert.match(cmdTask, /requested_resume:\s*flags\.resume/);
  assert.match(cmdTask, /requested_continue:\s*!!flags\.continue/);
});

test("v0.9.12 (Grok LOW + Gemini Important round-12): commandUsesJsonOutput recognizes all shapes", () => {
  // Space form (what grokBaseArgs emits today)
  assert.equal(commandUsesJsonOutput(["grok", "--output-format", "json", "-p", "x"]), true);
  assert.equal(commandUsesJsonOutput(["grok", "--output-format", "plain", "-p", "x"]), false);
  // Inline form (a future caller could legitimately use)
  assert.equal(commandUsesJsonOutput(["grok", "--output-format=json", "-p", "x"]), true);
  assert.equal(commandUsesJsonOutput(["grok", "--output-format=plain", "-p", "x"]), false);
  // Missing flag → false (no JSON envelope to trust)
  assert.equal(commandUsesJsonOutput(["grok", "-p", "x"]), false);
  // Edge cases
  assert.equal(commandUsesJsonOutput(null), false);
  assert.equal(commandUsesJsonOutput([]), false);
  assert.equal(commandUsesJsonOutput("not an array"), false);
  // Last-wins semantics: if duplicate flags, last value wins.
  assert.equal(commandUsesJsonOutput(["grok", "--output-format", "plain", "--output-format", "json"]), true);
  assert.equal(commandUsesJsonOutput(["grok", "--output-format=json", "--output-format=plain"]), false);
});

test("v0.9.11 (3/3 round-11): trust flag is derived from spawned argv automatically", () => {
  // v0.9.11 deleted the manual envelope_json field. The trust flag is
  // now computed by runJob from the actual `--output-format json` flag
  // in meta.command. The same scenarios still hold (review trusts, task
  // suppresses) but no command has to remember to set anything.
  const meta1 = {
    kind: "review",
    session_id: "review-session-1",
    session_id_trustworthy: true   // would be set by runJob from --output-format json
  };
  assert.ok(formatSessionHint(meta1));

  // Task always uses plain output → runJob sets trust=false.
  assert.equal(formatSessionHint({
    kind: "task",
    session_id: "from-model",
    session_id_trustworthy: false
  }), null);
});

test("v0.9.10 historical (kept): trust flag reads from envelope_json or session_id_trustworthy", () => {
  // The regression in v0.9.9: meta.json_output reflected the USER-FACING
  // --json render flag, but cmdReview ALWAYS invokes grok with --output-format
  // json regardless. So `meta.json_output: false` was emitting the wrong
  // trust signal, suppressing session hints for plain `/grok:review` runs.
  // v0.9.10 introduces a separate `envelope_json` field (set at job creation
  // time) that reflects the actual grok invocation.

  // Scenario 1: user ran /grok:review (no --json), runJob's close handler
  // populated session_id, envelope_json=true → trust flag set true.
  // formatSessionHint must return a hint.
  const meta1 = {
    kind: "review",
    json_output: false,             // user didn't pass --json
    envelope_json: true,            // but grok invocation DID use JSON
    session_id: "review-session-1",
    session_id_trustworthy: true    // set by runJob from envelope_json
  };
  assert.ok(formatSessionHint(meta1), "normal /grok:review (no --json) must still render the session hint");
  assert.match(formatSessionHint(meta1), /review-session-1/);

  // Scenario 2: user ran /grok:review --json. Same: trust flag set true,
  // hint rendered.
  const meta2 = {
    kind: "review",
    json_output: true,
    envelope_json: true,
    session_id: "review-session-2",
    session_id_trustworthy: true
  };
  assert.ok(formatSessionHint(meta2));

  // Scenario 3: task job with model-hallucinated JSON. envelope_json
  // not set → runJob wrote session_id_trustworthy: false. Hint suppressed.
  const meta3 = {
    kind: "task",
    session_id: "from-model-hallucination",
    session_id_trustworthy: false
  };
  assert.equal(formatSessionHint(meta3), null,
    "task with explicit trust=false must suppress hint regardless of session_id");
});

test("v0.9.7 (3/3 round-7): formatSessionLabel renders all 5 cases (short form)", async () => {
  // (formatSessionLabel imported at top of file in v0.9.9)
  assert.equal(formatSessionLabel({ requested_session_id: "x" }), "Session: x");
  assert.equal(formatSessionLabel({ requested_resume: "abc" }), "Resumed session: abc");
  assert.equal(formatSessionLabel({ requested_resume: true }), "Resumed most-recent Grok session");
  assert.equal(formatSessionLabel({ requested_continue: true }), "Continued most-recent Grok session (--continue)");
  assert.equal(formatSessionLabel({ session_id: "leg", kind: "review" }), "Session: leg");
  // v0.9.8: any kind NOT in the whitelist suppressed.
  assert.equal(formatSessionLabel({ session_id: "leg", kind: "task" }), null);
  assert.equal(formatSessionLabel({ session_id: "leg", kind: "interactive-chat" }), null);
  assert.equal(formatSessionLabel({ session_id: "leg" }), null);
  assert.equal(formatSessionLabel({}), null);
});

test("v0.9.6 (3/3 round-6): cmdResult uses formatSessionHint (not inline hint)", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  const cmdResult = src.slice(src.indexOf("function cmdResult"), src.indexOf("// ---------- subcommand: cancel"));
  assert.match(cmdResult, /formatSessionHint\(meta\)/,
    "cmdResult must call formatSessionHint, not its own inline hint logic");
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
