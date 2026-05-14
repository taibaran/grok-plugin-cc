import { test } from "node:test";
import assert from "node:assert/strict";

import { isValidGitRef, MAX_DIFF_BYTES } from "../plugins/grok/scripts/lib/git.mjs";

test("isValidGitRef accepts standard refs", () => {
  assert.equal(isValidGitRef("main"), true);
  assert.equal(isValidGitRef("origin/main"), true);
  assert.equal(isValidGitRef("feature/auth"), true);
  assert.equal(isValidGitRef("v1.2.3"), true);
  assert.equal(isValidGitRef("release-2026.05"), true);
});

test("isValidGitRef rejects refs starting with `-` (option injection)", () => {
  // A ref starting with `-` would be parsed as a flag by git.
  assert.equal(isValidGitRef("-rf"), false);
  assert.equal(isValidGitRef("--something"), false);
});

test("isValidGitRef rejects refs with whitespace or quotes", () => {
  assert.equal(isValidGitRef("main\nrm -rf /"), false);
  assert.equal(isValidGitRef("main 'malicious'"), false);
  assert.equal(isValidGitRef('main"'), false);
});

test("isValidGitRef rejects empty / non-string / overlong refs", () => {
  assert.equal(isValidGitRef(""), false);
  assert.equal(isValidGitRef(null), false);
  assert.equal(isValidGitRef("a".repeat(300)), false);
});

test("MAX_DIFF_BYTES is a reasonable cap (4 MB)", () => {
  assert.equal(MAX_DIFF_BYTES, 4 * 1024 * 1024);
});
