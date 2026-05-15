// Argument parsing for the Grok companion.
// Mirrors gemini-plugin-cc's args.mjs in shape, plus shell-style splitting for
// $ARGUMENTS forwarded as a single quoted string.

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;
  let inToken = false;
  for (const ch of raw) {
    if (escaping) { current += ch; escaping = false; inToken = true; continue; }
    if (ch === "\\") { escaping = true; continue; }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      inToken = true;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; inToken = true; continue; }
    if (/\s/.test(ch)) {
      if (inToken) { tokens.push(current); current = ""; inToken = false; }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (escaping) current += "\\";
  if (inToken) tokens.push(current);
  return tokens;
}

export function tokenize(argv) {
  // Claude Code typically forwards $ARGUMENTS as a single string. If we got
  // exactly one positional that contains spaces or quote chars, split it shell-style.
  if (argv.length === 1 && /[\s"']/.test(argv[0])) {
    return splitRawArgumentString(argv[0]);
  }
  return argv;
}

export function parseArgs(argv, {
  boolFlags = new Set(),
  valueFlags = new Set(),
  // v0.8.0: repeatable value flags accumulate into an array instead of
  // overwriting. Required for `--allow`/`--deny`/`--rules` which Grok
  // accepts multiple times.
  repeatableFlags = new Set()
} = {}) {
  const tokens = tokenize(argv);
  const flags = {};
  const positional = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith("--")) { positional.push(t); continue; }
    // v0.8.1 (Codex P3): split on FIRST `=` only. The old code used
    // `t.slice(2).split("=", 2)` which silently DROPS any tokens
    // beyond the second array slot — so `--system-prompt-override=Use A=B`
    // became `{ rawKey: "system-prompt-override", inline: "Use A" }`,
    // losing the trailing "=B". Find the first equals, slice both sides.
    const stripped = t.slice(2);
    const eqIdx = stripped.indexOf("=");
    const rawKey = eqIdx < 0 ? stripped : stripped.slice(0, eqIdx);
    const inline = eqIdx < 0 ? undefined : stripped.slice(eqIdx + 1);
    if (boolFlags.has(rawKey)) {
      flags[rawKey] = inline === undefined ? true : inline !== "false";
      continue;
    }
    if (valueFlags.has(rawKey) || repeatableFlags.has(rawKey)) {
      const v = inline ?? tokens[i + 1];
      if (v === undefined) {
        const err = new Error(`Missing value for --${rawKey}`);
        err.code = "MISSING_VALUE";
        throw err;
      }
      if (repeatableFlags.has(rawKey)) {
        // Accumulate. Single-occurrence still produces a 1-element array.
        if (!Array.isArray(flags[rawKey])) flags[rawKey] = [];
        flags[rawKey].push(v);
      } else {
        flags[rawKey] = v;
      }
      if (inline === undefined) i++;
      continue;
    }
    // Unknown flag — keep as positional for downstream handling.
    positional.push(t);
  }
  return { flags, positional };
}

export const COMMON_BOOL_FLAGS = new Set([
  "json", "wait", "background", "all", "write", "read-only",
  "resume", "fresh", "resume-last", "continue",
  "enable-review-gate", "disable-review-gate",
  // v0.6.0 Grok-specific differentiator flags
  "check",                // --check: self-verification loop (headless)
  "no-check",             // --no-check: explicit opt-out (matters for commands where --check defaults to on, e.g. /grok:research)
  "no-web-search",        // --no-web-search: turn OFF default web search
  "set-default",          // /grok:models --set-default: persist activeModel
  "adversarial",          // /grok:aggregate-review --adversarial: switch all reviewers to adversarial template
  // v0.8.0 Grok CLI bool kill-switches
  "no-subagents",         // --no-subagents: forbid grok from spawning its own subagents
  "no-plan",              // --no-plan: skip the planning turn
  "verbatim"              // --verbatim: send the prompt exactly as given (no plugin rewriting)
  // v0.8.1: --restore-code was here but not wired through grokBaseArgs /
  // extractPolicyFlags / capabilityProbe. Removed (Grok aggregate-review
  // round-2 HIGH). Will be re-added in v0.9.0 alongside --continue /
  // --resume / --session-id when the resume path is built.
]);

export const COMMON_VALUE_FLAGS = new Set([
  "base", "scope", "model", "older-than", "timeout", "effort", "session-id",
  // v0.6.0 Grok-specific differentiator value flags
  "best-of-n",            // --best-of-n N: parallel branches (cap BEST_OF_N_MAX)
  // v0.8.0 Grok CLI permission/policy flags (non-repeatable subset)
  "tools",                // --tools <list>: allowlist of tool names
  "max-turns",            // --max-turns N: user-facing turn budget
  "reasoning-effort",     // --reasoning-effort <effort>: distinct from --effort
  "system-prompt-override", // --system-prompt-override <prompt>
  "permission-mode",      // --permission-mode <mode>: user-selectable (plan|auto|acceptEdits|dontAsk|bypassPermissions|default)
  "agent",                // --agent <name>: pick a bundled Grok agent persona
  "sandbox"               // --sandbox <profile>: GROK_SANDBOX equivalent
]);

// v0.8.0: repeatable value flags. Each occurrence appends to an array.
// Driven by Grok's --allow / --deny / --rules which are explicitly
// repeatable per `grok --help`. The parser handles accumulation; callers
// receive `flags["allow"]` as Array<string> (or undefined if never passed).
export const COMMON_REPEATABLE_FLAGS = new Set([
  "allow",                // --allow <rule>: ToolPrefix(glob) permission rule
  "deny",                 // --deny  <rule>: same syntax
  "rules"                 // --rules <text>: extra system-prompt rules (also accepts @file)
]);

// Parse a duration string. Accepts "30d", "12h", "45m", "60s", "500ms", or a
// plain integer treated as ms for backward compatibility. Returns ms, or null
// on parse failure. `0` (with or without unit) yields 0, which callers
// interpret as "disable timeout".
export function parseDuration(s) {
  if (typeof s !== "string") return null;
  const m = s.trim().match(/^(\d+)\s*(ms|s|m|h|d)?$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || "ms").toLowerCase();
  const mult = unit === "ms" ? 1
    : unit === "s" ? 1000
    : unit === "m" ? 60_000
    : unit === "h" ? 3_600_000
    : unit === "d" ? 86_400_000
    : 1;
  return n * mult;
}
