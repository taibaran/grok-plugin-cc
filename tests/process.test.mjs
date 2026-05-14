import { test } from "node:test";
import assert from "node:assert/strict";

import { isValidPid, isAlive } from "../plugins/grok/scripts/lib/process.mjs";

test("isValidPid rejects the danger PIDs (0 and 1)", () => {
  // PID 0 = signal-to-process-group-of-caller (POSIX).
  // PID 1 = init/launchd — `kill -1 ...` here would broadcast to all
  // user-owned processes, taking down the session.
  assert.equal(isValidPid(0), false);
  assert.equal(isValidPid(1), false);
});

test("isValidPid rejects non-numeric / negative / non-integer PIDs", () => {
  assert.equal(isValidPid("12345"), false);
  assert.equal(isValidPid(-5), false);
  assert.equal(isValidPid(2.5), false);
  assert.equal(isValidPid(NaN), false);
  assert.equal(isValidPid(undefined), false);
  assert.equal(isValidPid(null), false);
});

test("isValidPid accepts a normal PID", () => {
  assert.equal(isValidPid(12345), true);
});

test("isAlive returns false for invalid PIDs without throwing", () => {
  assert.equal(isAlive(0), false);
  assert.equal(isAlive(1), false);
  assert.equal(isAlive(-1), false);
  assert.equal(isAlive("nope"), false);
});

test("isAlive returns true for our own PID", () => {
  assert.equal(isAlive(process.pid), true);
});

test("isAlive returns false for a definitely-dead PID", () => {
  // PID 2_147_483_647 is effectively guaranteed not to exist on any
  // sensible system; using it instead of a random high PID keeps the test
  // deterministic.
  assert.equal(isAlive(2_147_483_640), false);
});
