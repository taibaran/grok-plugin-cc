import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyAuthBlob,
  compareVersions,
  checkMinVersion,
  effectiveModel,
  DEFAULT_MODEL,
  MODEL_FALLBACK_CHAIN,
  MIN_GROK_VERSION,
  cleanGrokEnv
} from "../plugins/grok/scripts/lib/grok.mjs";

test("classifyAuthBlob detects OAuth-flow output as missing auth", () => {
  // When auth is missing, Grok prints "Signing in with Grok..." plus an
  // auth.x.ai/oauth2/authorize URL.
  assert.equal(
    classifyAuthBlob("Signing in with Grok..."),
    "no auth method configured"
  );
  assert.equal(
    classifyAuthBlob("Open this URL: https://auth.x.ai/oauth2/authorize?..."),
    "no auth method configured"
  );
  assert.equal(
    classifyAuthBlob("Set GROK_CODE_XAI_API_KEY or visit console.x.ai"),
    "no auth method configured"
  );
});

test("classifyAuthBlob detects expired tokens", () => {
  assert.equal(
    classifyAuthBlob("token expired, please reauthenticate"),
    "auth expired — run `grok login`"
  );
});

test("classifyAuthBlob detects quota exhaustion", () => {
  assert.equal(classifyAuthBlob("RESOURCE_EXHAUSTED: quota"), "quota exhausted");
  assert.equal(classifyAuthBlob("HTTP 429 rate limit hit"), "quota exhausted");
});

test("classifyAuthBlob detects auth rejection", () => {
  assert.equal(classifyAuthBlob("HTTP 401 forbidden"), "auth rejected");
  assert.equal(classifyAuthBlob("permission denied"), "auth rejected");
});

test("classifyAuthBlob detects model unavailable", () => {
  assert.equal(
    classifyAuthBlob("ModelNotFoundError: grok-future"),
    "model unavailable"
  );
});

test("classifyAuthBlob returns null for unrecognized blobs", () => {
  assert.equal(classifyAuthBlob(""), null);
  assert.equal(classifyAuthBlob("just a normal log line"), null);
});

test("compareVersions handles semver-ish strings", () => {
  assert.equal(compareVersions("0.1.210", "0.1.42"), 1);
  assert.equal(compareVersions("0.1.42", "0.1.210"), -1);
  assert.equal(compareVersions("0.1.210", "0.1.210"), 0);
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
});

test("checkMinVersion accepts a version >= MIN_GROK_VERSION", () => {
  const result = checkMinVersion("0.1.210");
  assert.equal(result.ok, true);
  assert.equal(result.current, "0.1.210");
});

test("checkMinVersion rejects an older version", () => {
  const result = checkMinVersion("0.0.42");
  assert.equal(result.ok, false);
  assert.match(result.reason, /<\s*required/);
});

test("checkMinVersion parses out trailing build hashes", () => {
  const result = checkMinVersion("grok 0.1.210 (8b63e9068c)");
  assert.equal(result.ok, true);
  assert.equal(result.current, "0.1.210");
});

test("effectiveModel honours per-call override first", () => {
  assert.equal(effectiveModel("custom-model"), "custom-model");
});

test("effectiveModel respects GROK_PLUGIN_MODEL env", () => {
  const original = process.env.GROK_PLUGIN_MODEL;
  process.env.GROK_PLUGIN_MODEL = "env-model";
  try {
    assert.equal(effectiveModel(), "env-model");
  } finally {
    if (original === undefined) delete process.env.GROK_PLUGIN_MODEL;
    else process.env.GROK_PLUGIN_MODEL = original;
  }
});

test("effectiveModel falls back to DEFAULT_MODEL", () => {
  const original = process.env.GROK_PLUGIN_MODEL;
  delete process.env.GROK_PLUGIN_MODEL;
  try {
    assert.equal(effectiveModel(), DEFAULT_MODEL);
  } finally {
    if (original !== undefined) process.env.GROK_PLUGIN_MODEL = original;
  }
});

test("DEFAULT_MODEL is on the fallback chain", () => {
  assert.ok(MODEL_FALLBACK_CHAIN.includes(DEFAULT_MODEL));
});

test("MIN_GROK_VERSION is a parseable semver", () => {
  assert.match(MIN_GROK_VERSION, /^\d+\.\d+\.\d+$/);
});

test("cleanGrokEnv drops secrets that aren't on the allowlist", () => {
  const out = cleanGrokEnv({
    PATH: "/usr/bin",
    HOME: "/home/u",
    ANTHROPIC_API_KEY: "should-be-removed",
    GITHUB_TOKEN: "should-be-removed",
    AWS_SECRET_ACCESS_KEY: "should-be-removed",
    GROK_CODE_XAI_API_KEY: "should-be-kept"
  });
  assert.equal(out.PATH, "/usr/bin");
  assert.equal(out.HOME, "/home/u");
  assert.equal(out.GROK_CODE_XAI_API_KEY, "should-be-kept");
  assert.equal(out.ANTHROPIC_API_KEY, undefined);
  assert.equal(out.GITHUB_TOKEN, undefined);
  assert.equal(out.AWS_SECRET_ACCESS_KEY, undefined);
});

test("cleanGrokEnv keeps locale categories via LC_ prefix", () => {
  const out = cleanGrokEnv({ LC_NUMERIC: "en_US", LC_TIME: "en_US" });
  assert.equal(out.LC_NUMERIC, "en_US");
  assert.equal(out.LC_TIME, "en_US");
});

test("cleanGrokEnv keeps proxy variables", () => {
  const out = cleanGrokEnv({
    HTTP_PROXY: "http://proxy:8080",
    https_proxy: "http://proxy:8080",
    NO_PROXY: "localhost"
  });
  assert.equal(out.HTTP_PROXY, "http://proxy:8080");
  assert.equal(out.https_proxy, "http://proxy:8080");
  assert.equal(out.NO_PROXY, "localhost");
});

test("cleanGrokEnv drops NODE_OPTIONS (RCE risk)", () => {
  const out = cleanGrokEnv({ NODE_OPTIONS: "--require=/tmp/payload.js" });
  assert.equal(out.NODE_OPTIONS, undefined);
});
