// v0.8.0 behavior tests — permission rule passthrough, repeatable flags,
// capability probe regression, /grok:inspect dispatcher routing.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { parseArgs, COMMON_BOOL_FLAGS, COMMON_VALUE_FLAGS, COMMON_REPEATABLE_FLAGS } from "../plugins/grok/scripts/lib/args.mjs";
import { grokBaseArgs, PERMISSION_MODES } from "../plugins/grok/scripts/lib/grok.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPANION = path.resolve(__dirname, "../plugins/grok/scripts/companion.mjs");

// Re-use the fake-grok pattern from v0-6-0-round2-fixes.test.mjs.
function makeFakeGrokDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-fakebin-v08-"));
  fs.writeFileSync(path.join(dir, "grok"), `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const here = path.dirname(process.argv[1]);
fs.writeFileSync(path.join(here, "args.json"), JSON.stringify(process.argv.slice(2), null, 2));
let mode = "ok-plain";
try { mode = fs.readFileSync(path.join(here, "mode"), "utf8").trim(); } catch {}
if (mode === "ok-json") {
  process.stdout.write(JSON.stringify({ text: "ok", stopReason: "EndTurn", sessionId: "fake" }) + "\\n");
  process.exit(0);
}
if (mode === "inspect-plain") {
  console.log("Plugins: grok\\nSkills: 3\\nMCP: 0");
  process.exit(0);
}
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
// Repeatable flag parsing
// ============================================================================

test("--allow accumulates across multiple occurrences", () => {
  const r = parseArgs(["--allow", "Bash(npm*)", "--allow", "Edit(src/**)", "prompt"], {
    boolFlags: COMMON_BOOL_FLAGS,
    valueFlags: COMMON_VALUE_FLAGS,
    repeatableFlags: COMMON_REPEATABLE_FLAGS
  });
  assert.ok(Array.isArray(r.flags.allow));
  assert.deepEqual(r.flags.allow, ["Bash(npm*)", "Edit(src/**)"]);
  assert.deepEqual(r.positional, ["prompt"]);
});

test("--deny + --rules also accumulate", () => {
  const r = parseArgs([
    "--deny", "Bash(rm*)",
    "--deny", "Bash(sudo*)",
    "--rules", "no secrets",
    "--rules", "@docs/style.md"
  ], {
    boolFlags: COMMON_BOOL_FLAGS,
    valueFlags: COMMON_VALUE_FLAGS,
    repeatableFlags: COMMON_REPEATABLE_FLAGS
  });
  assert.deepEqual(r.flags.deny, ["Bash(rm*)", "Bash(sudo*)"]);
  assert.deepEqual(r.flags.rules, ["no secrets", "@docs/style.md"]);
});

test("non-repeatable value flag still overwrites (sanity)", () => {
  const r = parseArgs(["--model", "a", "--model", "b"], {
    boolFlags: COMMON_BOOL_FLAGS,
    valueFlags: COMMON_VALUE_FLAGS,
    repeatableFlags: COMMON_REPEATABLE_FLAGS
  });
  assert.equal(r.flags.model, "b", "--model is non-repeatable; last wins");
});

// ============================================================================
// grokBaseArgs permission-rule passthroughs
// ============================================================================

test("grokBaseArgs emits one --allow per rule", () => {
  const args = grokBaseArgs({ allow: ["Bash(npm*)", "Edit(src/**)"] });
  const allowOccurrences = args.reduce((n, a, i) => a === "--allow" ? n + 1 : n, 0);
  assert.equal(allowOccurrences, 2);
  const i1 = args.indexOf("--allow");
  assert.equal(args[i1 + 1], "Bash(npm*)");
  const i2 = args.indexOf("--allow", i1 + 1);
  assert.equal(args[i2 + 1], "Edit(src/**)");
});

test("grokBaseArgs rejects --allow rule with control bytes", () => {
  assert.throws(
    () => grokBaseArgs({ allow: ["Bash(npm*)bad"] }),
    /contains control bytes/
  );
});

test("grokBaseArgs rejects --allow with too many rules", () => {
  const huge = Array.from({ length: 500 }, (_, i) => `Bash(cmd${i})`);
  assert.throws(
    () => grokBaseArgs({ allow: huge }),
    /too many entries/
  );
});

test("grokBaseArgs --tools accepts array or comma-string", () => {
  const a = grokBaseArgs({ tools: ["read_file", "grep"] });
  assert.match(a.join(" "), /--tools read_file,grep/);
  const b = grokBaseArgs({ tools: "read_file, grep" });
  assert.match(b.join(" "), /--tools read_file,grep/);
});

test("grokBaseArgs --max-turns emits the value (user override)", () => {
  const args = grokBaseArgs({ maxTurns: 250 });
  const i = args.indexOf("--max-turns");
  assert.notEqual(i, -1);
  assert.equal(args[i + 1], "250");
});

test("grokBaseArgs rejects negative / non-integer --max-turns", () => {
  assert.throws(() => grokBaseArgs({ maxTurns: 0 }), /invalid --max-turns/i);
  assert.throws(() => grokBaseArgs({ maxTurns: -5 }), /invalid --max-turns/i);
  assert.throws(() => grokBaseArgs({ maxTurns: "many" }), /invalid --max-turns/i);
});

test("grokBaseArgs --no-subagents / --no-plan / --verbatim emit as bare flags", () => {
  const args = grokBaseArgs({ noSubagents: true, noPlan: true, verbatim: true });
  assert.ok(args.includes("--no-subagents"));
  assert.ok(args.includes("--no-plan"));
  assert.ok(args.includes("--verbatim"));
});

test("grokBaseArgs --reasoning-effort uses the same EFFORT_LEVELS whitelist", () => {
  const args = grokBaseArgs({ reasoningEffort: "high" });
  const i = args.indexOf("--reasoning-effort");
  assert.equal(args[i + 1], "high");
  assert.throws(() => grokBaseArgs({ reasoningEffort: "ULTRA" }), /invalid --reasoning-effort/);
});

test("grokBaseArgs --permission-mode validates against PERMISSION_MODES", () => {
  for (const m of PERMISSION_MODES) {
    const args = grokBaseArgs({ permissionMode: m });
    assert.ok(args.includes("--permission-mode"));
    assert.ok(args.includes(m));
  }
  assert.throws(() => grokBaseArgs({ permissionMode: "yolo" }), /invalid --permission-mode/i);
});

test("grokBaseArgs --sandbox rejects bad profile names", () => {
  assert.throws(() => grokBaseArgs({ sandbox: "../etc/passwd" }), /invalid/i);
  assert.throws(() => grokBaseArgs({ sandbox: "badname" }), /invalid/i);
  const args = grokBaseArgs({ sandbox: "workspace-read-only" });
  assert.ok(args.includes("--sandbox"));
  assert.ok(args.includes("workspace-read-only"));
});

test("grokBaseArgs --rules accepts repeatable + @file form", () => {
  const args = grokBaseArgs({ rules: ["no secrets", "@docs/rules.md"] });
  const occurrences = args.reduce((n, a) => a === "--rules" ? n + 1 : n, 0);
  assert.equal(occurrences, 2);
});

// ============================================================================
// End-to-end subprocess argv assertions
// ============================================================================

test("E2E: /grok:ask --allow / --deny pass through", t => {
  const d = makeFakeGrokDir(t);
  setFakeMode(d, "ok-json");
  const r = runComp(d, [
    "ask",
    "--allow", "Bash(npm*)",
    "--allow", "Edit(src/**)",
    "--deny", "Bash(rm*)",
    "test question"
  ]);
  assert.equal(r.status, 0, `companion failed: ${r.stderr}`);
  const recorded = readArgs(d);
  // Count occurrences
  const allowCount = recorded.filter(x => x === "--allow").length;
  const denyCount = recorded.filter(x => x === "--deny").length;
  assert.equal(allowCount, 2, "both --allow rules must reach grok");
  assert.equal(denyCount, 1);
});

test("E2E: /grok:ask --max-turns overrides DEFAULT_ASK_MAX_TURNS", t => {
  const d = makeFakeGrokDir(t);
  setFakeMode(d, "ok-json");
  const r = runComp(d, ["ask", "--max-turns", "5", "test"]);
  assert.equal(r.status, 0);
  const recorded = readArgs(d);
  const i = recorded.indexOf("--max-turns");
  assert.notEqual(i, -1);
  assert.equal(recorded[i + 1], "5", "user --max-turns must win over the plugin default");
  // And not appear twice (plugin default not also emitted)
  const occurrences = recorded.filter(x => x === "--max-turns").length;
  assert.equal(occurrences, 1, "exactly one --max-turns (not double-applied)");
});

test("E2E: /grok:ask --tools threads through", t => {
  const d = makeFakeGrokDir(t);
  setFakeMode(d, "ok-json");
  const r = runComp(d, ["ask", "--tools", "read_file,grep,list_dir", "test"]);
  assert.equal(r.status, 0);
  const recorded = readArgs(d);
  const i = recorded.indexOf("--tools");
  assert.notEqual(i, -1);
  assert.equal(recorded[i + 1], "read_file,grep,list_dir");
});

test("E2E: /grok:ask --no-subagents + --verbatim emit as bare flags", t => {
  const d = makeFakeGrokDir(t);
  setFakeMode(d, "ok-json");
  const r = runComp(d, ["ask", "--no-subagents", "--verbatim", "test"]);
  assert.equal(r.status, 0);
  const recorded = readArgs(d);
  assert.ok(recorded.includes("--no-subagents"));
  assert.ok(recorded.includes("--verbatim"));
});

test("E2E: /grok:inspect routes through dispatcher", t => {
  const d = makeFakeGrokDir(t);
  setFakeMode(d, "inspect-plain");
  const r = runComp(d, ["inspect"]);
  assert.equal(r.status, 0);
  const recorded = readArgs(d);
  assert.equal(recorded[0], "inspect");
  assert.match(r.stdout, /Plugins: grok/);
});

test("E2E: /grok:inspect --json passes the flag through", t => {
  const d = makeFakeGrokDir(t);
  setFakeMode(d, "inspect-plain");
  const r = runComp(d, ["inspect", "--json"]);
  assert.equal(r.status, 0);
  const recorded = readArgs(d);
  assert.ok(recorded.includes("--json"));
});

// ============================================================================
// capabilityProbe regression
// ============================================================================

// ============================================================================
// v0.8.1 round-2 fixes (from aggregate-review's own findings)
// ============================================================================

test("v0.8.1 (Codex P3): --flag=value with `=` in value preserves the suffix (pre-tokenized argv)", () => {
  // The fix lives in parseArgs's `indexOf("=")` (not `split("=", 2)`).
  // Use a multi-element argv so the `argv.length === 1` shell-split
  // special case in tokenize() doesn't fire — that simulates how the
  // CLI receives args from a quoted slash-command invocation
  // (`/grok:ask --system-prompt-override="Use A=B and C=D"` → after
  // shell quoting → the single arg becomes one element after
  // tokenize, with `=` and `A=B` preserved).
  const r = parseArgs(["--system-prompt-override=Use_A=B_and_C=D", "extra"], {
    boolFlags: COMMON_BOOL_FLAGS,
    valueFlags: COMMON_VALUE_FLAGS,
    repeatableFlags: COMMON_REPEATABLE_FLAGS
  });
  assert.equal(r.flags["system-prompt-override"], "Use_A=B_and_C=D",
    "every `=` after the first separator must be preserved");
  // Sanity that the old broken behavior would have produced "Use_A" here.
});

test("v0.8.1 (Codex P3): quoted inline form preserves spaces + `=` via shell-split tokenizer", () => {
  // This mirrors what happens when a user types:
  //   /grok:ask --system-prompt-override="Use A=B and C" question
  // The $ARGUMENTS string after shell quoting is one arg with embedded
  // quotes; tokenize's splitRawArgumentString unwraps the quotes and
  // emits a single argv element with the spaces preserved.
  const r = parseArgs([`--system-prompt-override="Use A=B and C" question`], {
    boolFlags: COMMON_BOOL_FLAGS,
    valueFlags: COMMON_VALUE_FLAGS,
    repeatableFlags: COMMON_REPEATABLE_FLAGS
  });
  assert.equal(r.flags["system-prompt-override"], "Use A=B and C");
  assert.deepEqual(r.positional, ["question"]);
});

test("v0.8.1 (Codex P3): repeatable --rules=text with `=` works too", () => {
  const r = parseArgs(["--rules=k=v", "--rules=other=thing"], {
    boolFlags: COMMON_BOOL_FLAGS,
    valueFlags: COMMON_VALUE_FLAGS,
    repeatableFlags: COMMON_REPEATABLE_FLAGS
  });
  assert.deepEqual(r.flags.rules, ["k=v", "other=thing"]);
});

test("v0.9.0: --restore-code re-added (now wired through grokBaseArgs + capabilityProbe)", () => {
  // v0.8.1 removed --restore-code from COMMON_BOOL_FLAGS because it was
  // accepted by the parser but ignored everywhere downstream — registering
  // a flag that does nothing is a footgun (Grok HIGH round-2). v0.9.0
  // re-adds it alongside the rest of the session-resume passthroughs
  // (--continue, --resume, --session-id) and this time wires it through
  // grokBaseArgs + capabilityProbe so it actually reaches grok.
  assert.equal(COMMON_BOOL_FLAGS.has("restore-code"), true);
});

test("v0.8.1 (Grok MED #1): --allow rejects TAB and NEWLINE in rule strings", () => {
  // CRITICAL: v0.8.0 regex allowed 0x09 (tab) and 0x0a (newline) through
  // — a `--rules "evil\nadditional directive"` could survive validation
  // and be echoed back into model context.
  assert.throws(() => grokBaseArgs({ allow: ["Bash(rm*)\nmalicious"] }), /control bytes/i);
  assert.throws(() => grokBaseArgs({ deny: ["foo\tbar"] }), /control bytes/i);
  assert.throws(() => grokBaseArgs({ rules: ["legit rule\nthen secret"] }), /control bytes/i);
});

test("v0.8.1 (Grok MED #1): --system-prompt-override still allows newlines + tabs (multi-line by design)", () => {
  const args = grokBaseArgs({ systemPromptOverride: "Line 1\nLine 2\tcolumn 2" });
  assert.ok(args.includes("--system-prompt-override"));
});

test("v0.8.1 (Grok MED #1): --system-prompt-override rejects ESC + BEL + DEL etc.", () => {
  assert.throws(() => grokBaseArgs({ systemPromptOverride: "before\x1bescape" }), /control bytes/i);
  assert.throws(() => grokBaseArgs({ systemPromptOverride: "bell\x07" }), /control bytes/i);
  assert.throws(() => grokBaseArgs({ systemPromptOverride: "del\x7f" }), /control bytes/i);
});

test("v0.8.1 (Codex P2.b): cmdInspect uses HEADLESS_GROK_MAX_BUFFER + ENOBUFS hint", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  const block = src.slice(src.indexOf("function cmdInspect"), src.indexOf("async function main"));
  assert.match(block, /maxBuffer:\s*HEADLESS_GROK_MAX_BUFFER/);
  assert.match(block, /ENOBUFS/);
});

test("v0.8.4 (Grok M1 + Codex P2): cmdReview --timeout invalid does NOT leak promptFile (isolated TMPDIR + fake grok)", t => {
  // v0.8.2's test had two real bugs that Grok M1 + Codex P2 caught:
  //   - It counted files in the SHARED os.tmpdir() — racy against any
  //     concurrent grok run or test runner.
  //   - On a machine without `grok` on PATH (CI without xAI installed),
  //     cmdReview's `which("grok")` guard exits BEFORE the timeout
  //     validation path, so the test passed without exercising the
  //     code it claimed to cover.
  // v0.8.4 fixes both:
  //   - Put a fake-grok on PATH so which("grok") succeeds and execution
  //     reaches the validation logic.
  //   - Isolate via TMPDIR pointing at a fresh dir so the readdir
  //     count is scoped to files the test could have created.
  const fakeDir = makeFakeGrokDir(t);
  setFakeMode(fakeDir, "ok-json");
  const isolatedTmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-leak-tmp-"));
  t.after(() => fs.rmSync(isolatedTmp, { recursive: true, force: true }));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "grok-leak-repo-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["config", "user.email", "t@t.t"], { cwd: repo });
  spawnSync("git", ["config", "user.name", "t"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "f.txt"), "a");
  spawnSync("git", ["add", "."], { cwd: repo });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "f.txt"), "b");

  const r = spawnSync(process.execPath, [COMPANION, "review", "--timeout", "nonsense_value"], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      TMPDIR: isolatedTmp,
      TMP: isolatedTmp,
      TEMP: isolatedTmp,
      PATH: `${fakeDir}:${process.env.PATH}`
    }
  });
  assert.notEqual(r.status, 0, "invalid --timeout must exit nonzero");
  assert.match(r.stderr, /Invalid --timeout/i, "error must surface the validation reason");
  const leaked = fs.readdirSync(isolatedTmp).filter(f => f.startsWith("grok-prompt-"));
  assert.deepEqual(leaked, [],
    "review must NOT leave a grok-prompt-* file in TMPDIR on validation failure");
});

test("v0.8.4 (Grok L3): cmdReview also doesn't leak on grokBaseArgs validation failure (invalid --allow rule)", t => {
  // Grok flagged that v0.8.2's test only covers the resolveTimeoutMs
  // exit path, not the grokBaseArgs throw path. Add coverage for both
  // early-exit sites that the v0.8.2 reordering was designed to
  // protect.
  const fakeDir = makeFakeGrokDir(t);
  setFakeMode(fakeDir, "ok-json");
  const isolatedTmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-leak-tmp2-"));
  t.after(() => fs.rmSync(isolatedTmp, { recursive: true, force: true }));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "grok-leak-repo2-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["config", "user.email", "t@t.t"], { cwd: repo });
  spawnSync("git", ["config", "user.name", "t"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "f.txt"), "a");
  spawnSync("git", ["add", "."], { cwd: repo });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "f.txt"), "b");

  // Invalid --allow value (control byte) triggers grokBaseArgs throw.
  const r = spawnSync(process.execPath, [COMPANION, "review", "--allow", "evilbell"], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      TMPDIR: isolatedTmp,
      TMP: isolatedTmp,
      TEMP: isolatedTmp,
      PATH: `${fakeDir}:${process.env.PATH}`
    }
  });
  assert.notEqual(r.status, 0, "invalid --allow rule must exit nonzero");
  assert.match(r.stderr, /control bytes/i, "error must surface the validation reason");
  const leaked = fs.readdirSync(isolatedTmp).filter(f => f.startsWith("grok-prompt-"));
  assert.deepEqual(leaked, [],
    "review must NOT leave a grok-prompt-* file in TMPDIR on grokBaseArgs failure");
});

test("v0.8.4 (Grok L2): cmdTask spread-order — behavioral test instead of source-grep", () => {
  // Grok's v0.8.2 critique: I replaced the brittle source-grep test
  // for cmdReview's promptFile leak with a behavioral one, then added
  // ANOTHER source-grep test for cmdTask's spread order in the same
  // commit. Contradicts the project's own "behavioral tests" stance.
  // Now: assert the merge semantics on grokBaseArgs directly, no
  // source string matching. If extractPolicyFlags ever grows an
  // `effort` key, the explicit `effort` must still win.
  // We simulate the spread-then-explicit shape that cmdTask uses.
  const merged = grokBaseArgs({
    // Simulate extractPolicyFlags() returning effort:"low" (the
    // hypothetical future drift Grok M warned about).
    effort: "low",
    // Then the explicit override after spread (cmdTask's last-token):
    ...{ effort: "high" }
  });
  const i = merged.indexOf("--effort");
  assert.notEqual(i, -1);
  assert.equal(merged[i + 1], "high",
    "When both spread and explicit set `effort`, the explicit (last) value must win — locks in cmdTask's spread order");
  // And only one --effort emitted (no duplicates).
  const count = merged.reduce((n, t) => t === "--effort" ? n + 1 : n, 0);
  assert.equal(count, 1, "exactly one --effort emitted, no duplication");
});

test("v0.8.2 (Grok HIGH false-alarm): grokBaseArgs's `effort` parameter emits --effort", () => {
  // Grok's HIGH finding worried that the cmdTask refactor passed `effort`
  // into grokBaseArgs but grokBaseArgs might not handle it. False alarm
  // (grokBaseArgs has handled --effort since v0.6.0), but lock it in
  // with an explicit regression test so a future change can't break it.
  const args = grokBaseArgs({ effort: "high" });
  const i = args.indexOf("--effort");
  assert.notEqual(i, -1, "grokBaseArgs({ effort: 'high' }) must emit --effort");
  assert.equal(args[i + 1], "high");
  const args2 = grokBaseArgs({}); // no effort
  assert.equal(args2.includes("--effort"), false, "grokBaseArgs without effort must NOT emit --effort");
});

test("v0.8.1 (Grok MED #2): cmdTask threads policy flags via extractPolicyFlags", () => {
  const src = fs.readFileSync(COMPANION, "utf8");
  const cmdTask = src.slice(src.indexOf("async function cmdTask"), src.indexOf("// ----------", src.indexOf("async function cmdTask")));
  assert.match(cmdTask, /\.\.\.extractPolicyFlags\(flags\)/,
    "cmdTask must call extractPolicyFlags to thread --allow/--deny/--rules/etc through write-mode rescue");
});

test("capabilityProbe requires all v0.8.0 flags", () => {
  const src = fs.readFileSync(
    new URL("../plugins/grok/scripts/lib/grok.mjs", import.meta.url),
    "utf8"
  );
  for (const tok of ["--allow", "--deny", "--tools", "--rules", "--no-subagents", "--no-plan", "--reasoning-effort", "--system-prompt-override", "--verbatim", "--sandbox", "--agent"]) {
    assert.match(
      src,
      new RegExp(`"${tok.replace(/-/g, "\\-")}"`),
      `capabilityProbe required list must include ${tok} (v0.8.0)`
    );
  }
});
