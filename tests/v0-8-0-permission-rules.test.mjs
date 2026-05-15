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
