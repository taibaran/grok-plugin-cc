// Grok CLI wrapper — version detection, auth probing, arg construction,
// and a curated environment for the spawned `grok` process.
//
// References for every constant or flag here: ~/.grok/README.md (the
// authoritative xAI Grok CLI documentation). Anything that depends on the
// upstream CLI shape carries a "see README" comment.

import { spawnSync } from "node:child_process";
import { readConfig } from "./state.mjs";

export const AUTH_PROBE_TIMEOUT_MS = 30_000;

// Defense-in-depth: the `grok` binary inherits this Node process's full
// environment by default, which inside Claude Code includes ANTHROPIC_API_KEY,
// GITHUB_TOKEN, AWS_*, SSH_AUTH_SOCK, and anything else the user has exported.
// A compromised grok binary (supply-chain attack on the xAI installer, or a
// hostile fork on PATH) would exfiltrate every secret. cleanGrokEnv() returns
// an allowlisted subset that is sufficient for grok to function — auth, locale,
// terminal, proxy — and nothing else. Adding to the allowlist requires an
// explicit reason in the diff.
//
// The Grok-specific keys come from `## Environment Variables` in the README.
const ALLOWED_ENV_KEYS = new Set([
  // Process basics
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "PWD",
  // Locale
  "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES",
  // Terminal
  "TERM", "COLORTERM", "TERM_PROGRAM", "NO_COLOR", "FORCE_COLOR",
  // Temp dirs
  "TMPDIR", "TMP", "TEMP",
  // XDG base dirs (the user's ~/.grok/ stays at $HOME, but corporate
  // environments can re-home via these — keep them passed through).
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  // Grok / xAI authentication and endpoint overrides (all from the
  // README's "Environment Variables" section)
  "GROK_CODE_XAI_API_KEY",          // API key from console.x.ai
  "GROK_CLI_CHAT_PROXY_BASE_URL",   // proxy URL override
  "GROK_MODELS_BASE_URL",
  "GROK_MODELS_LIST_URL",
  "GROK_AUTH_PROVIDER_COMMAND",
  "GROK_AUTH_PROVIDER_LABEL",       // TUI label override for external auth
  "GROK_AUTH_TOKEN_TTL",
  "GROK_AUTH_EARLY_INVALIDATION_SECS",
  "GROK_AUTH_EXPIRED",              // set by Grok itself when re-running the auth provider
  "GROK_OIDC_ISSUER",
  "GROK_OIDC_CLIENT_ID",
  "GROK_HOME",                      // overrides ~/.grok config dir
  "GROK_SUBAGENTS",                 // 0/1
  "GROK_MEMORY",                    // 0/1
  "GROK_WEB_FETCH",                 // 0/1
  "GROK_WEB_FETCH_PROXY",
  "GROK_WEB_SEARCH_MODEL",          // overrides the model used by web_search tool
  "GROK_AGENT",                     // custom agent definition path
  "GROK_RESPECT_GITIGNORE",         // 0/1
  "GROK_FEEDBACK_ENABLED",
  "GROK_DISABLE_TELEMETRY",         // explicit telemetry kill switch
  "GROK_DEPLOYMENT_KEY",
  "GROK_LOG_FILE",
  "GROK_LOG_FILTER",
  "GROK_SANDBOX",                   // sandbox profile
  "GROK_LSP_TOOLS",
  // Logging (stderr in headless)
  "RUST_LOG",
  // Plugin-level override for the default model (similar to GEMINI_PLUGIN_MODEL)
  "GROK_PLUGIN_MODEL",
  // Plugin-level write-mode safety toggle (mirrors GEMINI_PLUGIN_ALLOW_WRITE).
  "GROK_PLUGIN_ALLOW_WRITE",
  // Strict review gate behavior (mirrors GEMINI_REVIEW_GATE_STRICT).
  "GROK_REVIEW_GATE_STRICT",
  // Proxy (corporate networks)
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  // Custom CA bundle for corporate TLS-intercepting proxies.
  // Pointedly NOT adding NODE_OPTIONS — that one accepts `--require=path.js`
  // and would let a hostile env inject arbitrary code.
  "NODE_EXTRA_CA_CERTS"
]);
// LC_* covers all locale category overrides (LC_NUMERIC, LC_TIME, etc.).
const ALLOWED_PREFIXES = ["LC_"];

export function cleanGrokEnv(parent = process.env) {
  const out = Object.create(null);
  for (const k of Object.keys(parent)) {
    const v = parent[k];
    if (typeof v !== "string") continue;
    if (ALLOWED_ENV_KEYS.has(k) || ALLOWED_PREFIXES.some(p => k.startsWith(p))) {
      out[k] = v;
    }
  }
  return out;
}

// Only one public model is currently exposed via `grok models` for the default
// hosted endpoint. Pinning the plugin to this id keeps results consistent even
// if Grok flips the default later. Override per-call with --model, or globally
// via GROK_PLUGIN_MODEL.
export const DEFAULT_MODEL = "grok-build";
// Fallback chain. Today there is only one public model, so this is a
// singleton — meaning `probeWithFallback` cannot actually fall back. Kept as
// a single-entry array (not removed entirely) so that when xAI ships
// additional public models we can add them without changing the public
// surface or the setup-report shape. The setup report's `fallbackUsed`
// field stays meaningful: null today, populated when a real fallback fires.
export const MODEL_FALLBACK_CHAIN = ["grok-build"];

// Minimum xAI Grok CLI version we have validated against. Bump only when a
// newer flag set or output-format change becomes mandatory for the plugin.
export const MIN_GROK_VERSION = "0.1.210";

// Precedence for model selection (highest wins):
//   1. callerModel argument (per-call --model flag)
//   2. GROK_PLUGIN_MODEL env var (global override)
//   3. workspace config.activeModel
//   4. DEFAULT_MODEL
export function effectiveModel(callerModel, cwd) {
  if (callerModel) return callerModel;
  if (process.env.GROK_PLUGIN_MODEL) return process.env.GROK_PLUGIN_MODEL;
  try {
    const cfg = readConfig(cwd ?? process.cwd());
    if (cfg && typeof cfg.activeModel === "string" && cfg.activeModel) {
      return cfg.activeModel;
    }
  } catch {}
  return DEFAULT_MODEL;
}

// Compare two semver-like strings ("0.39.1" vs "0.30.0"). Returns -1 / 0 / 1.
export function compareVersions(a, b) {
  const parse = s => String(s || "0.0.0").match(/(\d+)\.(\d+)\.(\d+)/) || [];
  const pa = parse(a), pb = parse(b);
  for (let i = 1; i <= 3; i++) {
    const ai = parseInt(pa[i] || "0", 10);
    const bi = parseInt(pb[i] || "0", 10);
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return 0;
}

export function checkMinVersion(currentRaw) {
  const current = (currentRaw || "").trim();
  // `grok --version` prints e.g. `grok 0.1.210 (8b63e9068c)` — the leading
  // word and trailing build hash are non-semver, so extract the numeric core.
  const m = current.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return { ok: false, reason: "could not parse version", current };
  const cleaned = m[0];
  if (compareVersions(cleaned, MIN_GROK_VERSION) < 0) {
    return { ok: false, reason: `installed ${cleaned} < required ${MIN_GROK_VERSION}`, current: cleaned };
  }
  return { ok: true, current: cleaned };
}

export function which(cmd) {
  const r = spawnSync("which", [cmd], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function grokVersion() {
  const r = spawnSync("grok", ["--version"], { encoding: "utf8", env: cleanGrokEnv() });
  return r.status === 0 ? r.stdout.trim() : null;
}

// Capability probe — verify that the flags this plugin relies on actually
// exist in the installed `grok` binary. Catches breaking changes where Grok
// renames a flag without bumping a major version. Surfaced through /grok:setup.
//
// The probe is conservative: it only checks for the flag tokens we depend on,
// not exhaustively. Missing flags are reported by name.
export function capabilityProbe() {
  const r = spawnSync("grok", ["--help"], { encoding: "utf8", env: cleanGrokEnv() });
  if (r.status !== 0) {
    return { ok: false, reason: "could not run grok --help", missing: [] };
  }
  const help = r.stdout || "";
  // Each entry is the smallest distinctive substring guaranteed to appear in
  // `grok --help` output for the flag in question.
  // The flag tokens we depend on. Note that `grok --help` lists
  // `--always-approve` while the README documents both `--yolo` and
  // `--always-approve` as equivalent aliases; we look for the help-visible
  // name and use `--yolo` in actual invocations (matches the README's
  // examples and is shorter).
  //
  // `--cwd` is intentionally NOT in the required list even though grok
  // exposes it. The plugin does not pass `--cwd` to the child — we use
  // `spawn(..., { cwd })` instead, which is the canonical way to set the
  // working directory of a Node child process. Listing `--cwd` as required
  // would let a future grok release that drops the flag falsely break
  // /grok:setup over a capability we never depended on.
  const required = [
    "-p, --single",
    "-m, --model",
    "--output-format",
    "--always-approve",
    "--permission-mode",
    "--max-turns",
    "--disallowed-tools",
    "--prompt-file"
  ];
  const missing = required.filter(token => !help.includes(token));
  return { ok: missing.length === 0, missing };
}

// Classify an arbitrary blob (combined stdout+stderr) into a known failure
// category so callers can emit actionable hints. Returns null when we cannot
// classify — caller treats that as a generic failure.
//
// Patterns are based on observed CLI output:
//   - When auth is missing or expired, Grok prints "Signing in with Grok..."
//     and an OAuth URL pointing at `auth.x.ai/oauth2/authorize`.
//   - Rate-limit / quota errors carry HTTP 429-style phrasing.
//   - Permission/auth rejection surfaces as 401/403 with "forbidden".
//   - "model not found" / "model not available" indicates a stale model id.
export function classifyAuthBlob(blob) {
  if (!blob) return null;
  // OAuth flow appearing in headless output means the binary is trying to
  // launch the browser flow, which is the canonical signal of missing auth.
  if (/auth\.x\.ai\/oauth2\/authorize|Signing in with Grok|GROK_CODE_XAI_API_KEY|console\.x\.ai/i.test(blob)) {
    return "no auth method configured";
  }
  if (/token.*expired|refresh.*token|reauthenticate/i.test(blob)) {
    return "auth expired — run `grok login`";
  }
  if (/quota|rate.?limit|RESOURCE_EXHAUSTED|429/i.test(blob)) {
    return "quota exhausted";
  }
  if (/permission.denied|forbidden|\b401\b|\b403\b/i.test(blob)) {
    return "auth rejected";
  }
  if (/ModelNotFound|model.*not.*(found|available)|invalid.*model/i.test(blob)) {
    return "model unavailable";
  }
  return null;
}

// Best-effort label for what the active auth source is. Only meaningful when
// the auth probe succeeds; called purely for the setup report.
export function detectAuthSource() {
  if (process.env.GROK_CODE_XAI_API_KEY) return "GROK_CODE_XAI_API_KEY env";
  if (process.env.GROK_AUTH_PROVIDER_COMMAND) return "external auth provider";
  if (process.env.GROK_OIDC_ISSUER) return "OIDC";
  // Default install path stores tokens in ~/.grok/auth.json after `grok login`.
  return "browser OAuth (~/.grok/auth.json)";
}

// Tools to disallow for read-only operations (ask, review,
// adversarial-review). Strips write + shell capabilities but deliberately
// leaves web_search / web_fetch / Agent intact so Grok can ground reviews
// in current docs or X discourse — that is Grok's primary differentiator
// against Claude's knowledge cutoff.
//
// These tool IDs come from the README's "Tool Filtering" section, not
// display names.
export const READ_ONLY_DISALLOWED_TOOLS = "search_replace,run_terminal_cmd,todo_write";

// Tools to disallow during the auth probe. The probe sends a trivial "say
// OK" prompt — it has no business calling ANY tool, so we ban the full
// set (including Agent / web_*) to keep the probe cheap, deterministic,
// and fast. Using a separate constant from READ_ONLY_DISALLOWED_TOOLS
// makes the difference between "real work, read-only" and "minimal liveness
// check" explicit in the code, addressing Codex's "inconsistent policy"
// finding.
export const AUTH_PROBE_DISALLOWED_TOOLS = "Agent,run_terminal_cmd,search_replace,web_search,web_fetch,todo_write";

// Build the base argument vector for a non-interactive `grok -p` invocation.
//
//   readOnly=true  → --permission-mode plan AND strip write/shell tools.
//                    The two layers are deliberate: --permission-mode is a
//                    policy gate, --disallowed-tools removes the tools from
//                    the agent's vocabulary entirely, so a clever model can't
//                    silently bypass plan mode via internal tool calls.
//   readOnly=false → --yolo (auto-approve all tool executions).
//
// jsonOutput=true selects --output-format json (single JSON object after
// completion). The plain default is left for interactive-feeling text.
//
// sessionId chains the call into a named session for multi-turn use; without
// it the headless run is one-shot.
//
// cwd is threaded into effectiveModel so workspace-scoped activeModel (set
// by /grok:setup's fallback chain) resolves against the user's actual
// workspace and not whatever cwd the hook process happens to inherit from
// Claude Code. Optional — defaults to process.cwd() inside effectiveModel.
export function grokBaseArgs({ readOnly = true, model, jsonOutput = false, sessionId, cwd } = {}) {
  const args = [
    "--output-format", jsonOutput ? "json" : "plain",
    "-m", effectiveModel(model, cwd)
  ];
  if (readOnly) {
    args.push("--permission-mode", "plan");
    args.push("--disallowed-tools", READ_ONLY_DISALLOWED_TOOLS);
  } else {
    args.push("--yolo");
  }
  if (sessionId) args.push("-s", sessionId);
  return args;
}

// One-shot auth probe. Asks the model for a trivial, deterministic response and
// checks both the exit code and the response body. `--max-turns 5` is generous
// enough to absorb Grok's internal thinking turns (the live CLI uses ~4 internal
// messages even for "say OK") while still catching a hung session.
//
// Tool list uses the broader AUTH_PROBE_DISALLOWED_TOOLS (vs the per-call
// READ_ONLY_DISALLOWED_TOOLS used by ask/review). The probe doesn't need web
// search / subagents / etc., so banning the full set keeps it deterministic.
export function authProbe(model) {
  const r = spawnSync(
    "grok",
    [
      "-p", "Reply with exactly the word: OK",
      "--output-format", "json",
      "-m", model || effectiveModel(),
      "--max-turns", "5",
      "--permission-mode", "plan",
      "--disallowed-tools", AUTH_PROBE_DISALLOWED_TOOLS
    ],
    { encoding: "utf8", timeout: AUTH_PROBE_TIMEOUT_MS, env: cleanGrokEnv() }
  );
  const blob = (r.stdout || "") + "\n" + (r.stderr || "");

  // Try to parse the JSON envelope. Grok's --output-format json shape is:
  //   { "text": "...", "stopReason": "EndTurn", "sessionId": "...", "requestId": "..." }
  // or on error:
  //   { "type": "error", "message": "..." }
  let parsed = null;
  if (r.stdout) {
    try { parsed = JSON.parse(r.stdout.trim()); } catch {}
  }

  if (r.error?.code === "ETIMEDOUT") {
    return { ok: false, detail: "auth probe timed out", model: model || effectiveModel() };
  }
  if (parsed && parsed.type === "error") {
    const why = classifyAuthBlob(parsed.message || blob);
    return { ok: false, detail: why || "error response", raw: (parsed.message || "").slice(0, 400), model: model || effectiveModel() };
  }
  if (r.status === 0 && parsed && /\bOK\b/i.test(parsed.text || "")) {
    return { ok: true, detail: "responsive", model: model || effectiveModel() };
  }
  const why = classifyAuthBlob(blob);
  return { ok: false, detail: why || "probe failed", raw: blob.slice(0, 400), model: model || effectiveModel() };
}

// Walk the fallback chain only if the user has not pinned a model AND the
// failure looks like one that another model might fix:
//   - "model unavailable"  — this specific model is not enabled for the
//                            account; another model in the chain might be.
//   - "quota exhausted"    — per-model quotas exist; another model may have
//                            headroom even if this one is throttled.
// For other failure classes (no auth method, auth rejected) walking the
// chain just produces N copies of the same error — skip it.
//
// Today the chain is a single entry (only `grok-build` is publicly exposed),
// so this function effectively returns the first probe result. When xAI
// ships more public models, the fallback semantics kick in automatically.
const FALLBACK_TRIGGER_DETAILS = new Set([
  "model unavailable",
  "quota exhausted"
]);

export function probeWithFallback() {
  const userPinned = !!process.env.GROK_PLUGIN_MODEL;
  const first = authProbe();
  if (first.ok) return { ...first, fallbackUsed: null };
  if (userPinned) return { ...first, fallbackUsed: null };
  if (!FALLBACK_TRIGGER_DETAILS.has(first.detail)) return { ...first, fallbackUsed: null };
  for (const candidate of MODEL_FALLBACK_CHAIN) {
    if (candidate === first.model) continue;
    const r = authProbe(candidate);
    if (r.ok) return { ...r, fallbackUsed: candidate };
  }
  return { ...first, fallbackUsed: null };
}
