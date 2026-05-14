import { test } from "node:test";
import assert from "node:assert/strict";

import { findBalancedJsonEnd, parseVerdict } from "../plugins/grok/scripts/lib/verdict.mjs";

test("findBalancedJsonEnd finds a simple closing brace", () => {
  const s = `{"a": 1}`;
  assert.equal(findBalancedJsonEnd(s, 0), s.length - 1);
});

test("findBalancedJsonEnd is string-aware for braces inside string values", () => {
  // Without string-awareness the first `}` inside "closes}" would match early.
  const s = `{"reason": "this closes} the block"}`;
  const end = findBalancedJsonEnd(s, 0);
  assert.equal(s.slice(0, end + 1), s);
});

test("findBalancedJsonEnd returns -1 when not balanced", () => {
  assert.equal(findBalancedJsonEnd("{ not closed", 0), -1);
});

test("parseVerdict accepts a bare verdict JSON", () => {
  const out = parseVerdict(`{"decision":"allow","reason":"clean diff"}`);
  assert.deepEqual(out, { decision: "allow", reason: "clean diff" });
});

test("parseVerdict accepts ```json fenced output", () => {
  const out = parseVerdict("```json\n{\"decision\":\"block\",\"reason\":\"data loss risk\"}\n```");
  assert.deepEqual(out, { decision: "block", reason: "data loss risk" });
});

test("parseVerdict accepts ``` fenced (no language tag)", () => {
  const out = parseVerdict("```\n{\"decision\":\"allow\",\"reason\":\"none\"}\n```");
  assert.deepEqual(out, { decision: "allow", reason: "none" });
});

test("parseVerdict rejects an invalid decision", () => {
  // Defense against prompt injection: model says "yes" instead of allow/block.
  assert.equal(parseVerdict(`{"decision":"yes","reason":""}`), null);
});

test("parseVerdict treats free-form ALLOW/BLOCK text as non-verdict (returns null)", () => {
  // Prompt-injection bypass attempt — agent prints ALLOW as plain text rather
  // than the structured envelope. Should be classified as unparseable, not
  // accepted as a verdict.
  assert.equal(parseVerdict("ALLOW"), null);
  assert.equal(parseVerdict("My verdict: BLOCK because reasons"), null);
});

test("parseVerdict tolerates surrounding chatter (extracts the first JSON object)", () => {
  const out = parseVerdict("Here is my verdict:\n{\"decision\":\"allow\",\"reason\":\"safe\"}\n\nThat is all.");
  assert.deepEqual(out, { decision: "allow", reason: "safe" });
});

test("parseVerdict reason defaults to empty string when missing or non-string", () => {
  const out = parseVerdict(`{"decision":"allow"}`);
  assert.deepEqual(out, { decision: "allow", reason: "" });
  const out2 = parseVerdict(`{"decision":"block","reason":42}`);
  assert.deepEqual(out2, { decision: "block", reason: "" });
});

test("parseVerdict returns null for empty / null input", () => {
  assert.equal(parseVerdict(""), null);
  assert.equal(parseVerdict(null), null);
  assert.equal(parseVerdict(undefined), null);
});
