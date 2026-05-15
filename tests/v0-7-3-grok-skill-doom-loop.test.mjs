// Regression tests for v0.7.3 — Grok skill-discovery doom loop.
//
// Bug: when the grok CLI is spawned in a directory that contains the
// plugin's `plugins/grok/skills/` dir, grok auto-discovers the skills
// and exposes them as callable tools. The model then calls
// `grok-cli-runtime` etc. as if they were integration tools and the
// CLI panics ("use_tool can only dispatch to integration tools"). After
// 5 repeats, doom-loop termination kicks in and grok exits with no
// useful output.
//
// Fix: add the three skill names to READ_ONLY_DISALLOWED_TOOLS so
// grok never sees them as tools.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  READ_ONLY_DISALLOWED_TOOLS,
  AUTH_PROBE_DISALLOWED_TOOLS,
  GROK_PLUGIN_SKILL_NAMES,
  grokBaseArgs
} from "../plugins/grok/scripts/lib/grok.mjs";

test("v0.7.3: GROK_PLUGIN_SKILL_NAMES exports the 3 plugin skills", () => {
  const names = GROK_PLUGIN_SKILL_NAMES.split(",");
  assert.ok(names.includes("grok-cli-runtime"));
  assert.ok(names.includes("grok-prompting"));
  assert.ok(names.includes("grok-result-handling"));
});

test("v0.7.3: READ_ONLY_DISALLOWED_TOOLS bans all 3 plugin skills", () => {
  for (const skill of ["grok-cli-runtime", "grok-prompting", "grok-result-handling"]) {
    assert.ok(
      READ_ONLY_DISALLOWED_TOOLS.includes(skill),
      `READ_ONLY_DISALLOWED_TOOLS must include ${skill} to prevent doom loop`
    );
  }
});

test("v0.7.3: AUTH_PROBE_DISALLOWED_TOOLS bans all 3 plugin skills", () => {
  for (const skill of ["grok-cli-runtime", "grok-prompting", "grok-result-handling"]) {
    assert.ok(
      AUTH_PROBE_DISALLOWED_TOOLS.includes(skill),
      `AUTH_PROBE_DISALLOWED_TOOLS must include ${skill} (auth probe runs in plugin cwd)`
    );
  }
});

test("v0.7.3: grokBaseArgs read-only mode emits the skill bans", () => {
  const args = grokBaseArgs({ readOnly: true });
  const i = args.indexOf("--disallowed-tools");
  assert.notEqual(i, -1, "read-only mode must pass --disallowed-tools");
  const disallowed = args[i + 1];
  assert.ok(disallowed.includes("grok-cli-runtime"));
  assert.ok(disallowed.includes("grok-prompting"));
  assert.ok(disallowed.includes("grok-result-handling"));
});

test("v0.7.3: DEFAULT_RESEARCH_MAX_TURNS bumped to ≥ 200", async () => {
  // Source-level guarantee. The old value 60 was tripping users with
  // "Internal error: max_turns exceeded" on legitimate deep research.
  const fs = await import("node:fs");
  const src = fs.readFileSync(
    new URL("../plugins/grok/scripts/companion.mjs", import.meta.url),
    "utf8"
  );
  const m = src.match(/DEFAULT_RESEARCH_MAX_TURNS\s*=\s*(\d+)/);
  assert.ok(m, "DEFAULT_RESEARCH_MAX_TURNS must be defined");
  assert.ok(parseInt(m[1], 10) >= 200, `DEFAULT_RESEARCH_MAX_TURNS=${m[1]} too low (need ≥200)`);
});
