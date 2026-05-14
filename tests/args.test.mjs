import { test } from "node:test";
import assert from "node:assert/strict";

import {
  splitRawArgumentString,
  parseArgs,
  parseDuration,
  COMMON_BOOL_FLAGS,
  COMMON_VALUE_FLAGS
} from "../plugins/grok/scripts/lib/args.mjs";

test("splitRawArgumentString handles simple tokens", () => {
  assert.deepEqual(splitRawArgumentString("foo bar baz"), ["foo", "bar", "baz"]);
});

test("splitRawArgumentString preserves quoted strings", () => {
  assert.deepEqual(
    splitRawArgumentString(`foo "hello world" bar`),
    ["foo", "hello world", "bar"]
  );
});

test("splitRawArgumentString handles single quotes", () => {
  assert.deepEqual(
    splitRawArgumentString(`foo 'with spaces' bar`),
    ["foo", "with spaces", "bar"]
  );
});

test("splitRawArgumentString handles escaped chars", () => {
  assert.deepEqual(
    splitRawArgumentString(`foo\\ bar baz`),
    ["foo bar", "baz"]
  );
});

test("parseArgs separates flags and positionals", () => {
  const { flags, positional } = parseArgs(
    ["--json", "--base", "main", "review", "the", "changes"],
    { boolFlags: COMMON_BOOL_FLAGS, valueFlags: COMMON_VALUE_FLAGS }
  );
  assert.equal(flags.json, true);
  assert.equal(flags.base, "main");
  assert.deepEqual(positional, ["review", "the", "changes"]);
});

test("parseArgs accepts --key=value form", () => {
  const { flags } = parseArgs(
    ["--scope=staged", "--model=grok-build"],
    { boolFlags: COMMON_BOOL_FLAGS, valueFlags: COMMON_VALUE_FLAGS }
  );
  assert.equal(flags.scope, "staged");
  assert.equal(flags.model, "grok-build");
});

test("parseArgs throws MISSING_VALUE when a value flag has no value", () => {
  assert.throws(
    () => parseArgs(
      ["--model"],
      { boolFlags: COMMON_BOOL_FLAGS, valueFlags: COMMON_VALUE_FLAGS }
    ),
    err => err.code === "MISSING_VALUE"
  );
});

test("parseArgs preserves unknown flags as positionals", () => {
  // The companion forwards unknown flags through to the underlying grok CLI
  // via the positional bucket — this keeps the wrapper from blocking new
  // upstream flags it does not yet know about.
  const { positional } = parseArgs(
    ["--some-new-flag", "value"],
    { boolFlags: COMMON_BOOL_FLAGS, valueFlags: COMMON_VALUE_FLAGS }
  );
  assert.ok(positional.includes("--some-new-flag"));
});

test("parseDuration accepts s/m/h/d/ms suffixes", () => {
  assert.equal(parseDuration("500ms"), 500);
  assert.equal(parseDuration("30s"), 30_000);
  assert.equal(parseDuration("5m"), 300_000);
  assert.equal(parseDuration("1h"), 3_600_000);
  assert.equal(parseDuration("1d"), 86_400_000);
});

test("parseDuration treats bare integer as ms", () => {
  assert.equal(parseDuration("1500"), 1500);
});

test("parseDuration handles `0` as disable-timeout sentinel", () => {
  assert.equal(parseDuration("0"), 0);
  assert.equal(parseDuration("0s"), 0);
});

test("parseDuration returns null for nonsense input", () => {
  assert.equal(parseDuration("abc"), null);
  assert.equal(parseDuration("5y"), null);
  assert.equal(parseDuration(""), null);
  assert.equal(parseDuration(null), null);
});
