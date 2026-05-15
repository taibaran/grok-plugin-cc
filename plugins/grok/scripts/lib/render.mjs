// Output rendering helpers for status and result.

// ============================================================================
// v0.9.7 (3/3 round-7 + Grok MED #1): single source of truth for session
// provenance + hint rendering. Lives in render.mjs (the rendering helpers
// module) so cmdTask footer, cmdResult, AND renderJobDetails ALL call from
// the same place. v0.9.6 had this only in companion.mjs and render.mjs
// duplicated the priority chain — every reviewer flagged it.
// ============================================================================

// Returns a tagged-union describing where session provenance came from,
// or null if the job has none. Priority (highest first):
//   --session-id flag (sticky id, create-or-resume)
//   --resume=<id>     (resume named session)
//   --resume          (bare; resume most-recent)
//   --continue        (continue most-recent for cwd)
//   meta.session_id   (legacy: parsed JSON envelope; only trusted for
//                      jobs that ran with json output — see kind gate)
//
// v0.9.7 (Codex P2 round-7) → v0.9.8 (Gemini Nit round-8): the legacy
// `session_id` branch is trusted only for job kinds known to use
// jsonOutput: true, where parseGrokJson reliably extracts a real
// sessionId. The v0.9.7 implementation used a blacklist (`!== "task"`)
// which would silently trust any future plain-output job kind by
// default. The whitelist below is fail-closed: a new job kind must
// be explicitly added before its session_id is trusted.
//
// `review` + `adversarial-review` are the two kinds today that use
// jsonOutput: true (see cmdReview in companion.mjs). cmdTask uses
// plain output → meta.session_id from a coincidental JSON-shaped
// model response would be hallucination.
const TRUSTED_SESSION_ID_KINDS = new Set(["review", "adversarial-review"]);
export function getSessionProvenance(meta) {
  if (!meta) return null;
  if (meta.requested_session_id) return { kind: "session-id", id: meta.requested_session_id };
  if (typeof meta.requested_resume === "string") return { kind: "resume-id", id: meta.requested_resume };
  if (meta.requested_resume === true) return { kind: "resume-recent" };
  if (meta.requested_continue) return { kind: "continue-recent" };
  if (meta.session_id && TRUSTED_SESSION_ID_KINDS.has(meta.kind)) {
    return { kind: "legacy-session-id", id: meta.session_id };
  }
  return null;
}

// Full hint with label + continuation command suggestion. Used by
// cmdTask footer and cmdResult.
export function formatSessionHint(meta) {
  const p = getSessionProvenance(meta);
  if (!p) return null;
  switch (p.kind) {
    case "session-id":
    case "legacy-session-id":
      // v0.9.7 (Codex P2 #1 round-7): use `grok -r` for the raw-CLI half
      // of the hint (resume the existing session). `grok -s` is the
      // create-or-resume short form; both work, but `-r` is the
      // documented standalone continuation command. Slash-command half
      // stays `--session-id=` for create-or-resume semantics.
      return `Session: ${p.id}  (resume: /grok:rescue --session-id=${p.id}  or  grok -r ${p.id})`;
    case "resume-id":
      return `Resumed session: ${p.id}  (continue: /grok:rescue --resume=${p.id}  or  grok -r ${p.id})`;
    case "resume-recent":
      return `Resumed most-recent Grok session  (continue: /grok:rescue --resume  or  grok -r)`;
    case "continue-recent":
      return `Continued most-recent Grok session (--continue)  (next: /grok:rescue --continue  or  grok -c)`;
  }
  return null;
}

// Short label (no command suggestion). Used by renderJobDetails which
// already prints a Follow-up: section with the relevant slash commands.
export function formatSessionLabel(meta) {
  const p = getSessionProvenance(meta);
  if (!p) return null;
  switch (p.kind) {
    case "session-id":
    case "legacy-session-id":
      return `Session: ${p.id}`;
    case "resume-id":
      return `Resumed session: ${p.id}`;
    case "resume-recent":
      return `Resumed most-recent Grok session`;
    case "continue-recent":
      return `Continued most-recent Grok session (--continue)`;
  }
  return null;
}

export function fmtTime(s) {
  return s ? s.replace("T", " ").replace(/\..*/, "") : "-";
}

// --- Terminal-output sanitization -------------------------------------------
//
// Grok's stdout/stderr is forwarded to the user's terminal. Grok itself emits
// ANSI-colored tracing lines on stderr (e.g. `\x1b[2m...\x1b[0m ERROR`), so the
// sanitizer is mandatory, not optional. We strip:
//   - CSI sequences:  ESC [ ... <final byte 0x40-0x7e>
//   - OSC sequences:  ESC ] ... (BEL or ST=ESC \)
//   - Single-shift / private 2-byte intros: ESC <0x40-0x5F>
//   - Device control / privacy / app program: ESC P/X/^/_ ... ST=ESC \
//   - Dangerous C0 bytes (NUL, BS, VT, FF, SO/SI, DLE-SUB, FS-US, DEL).
//     We keep \t, \n, \r — CRLF round-trips matter for Windows logs.

const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\|[@-Z\\-_])/g;
// Dangerous C0 controls. Includes ESC (0x1b) so any orphan ESC byte left over
// after the ANSI pass — e.g. an incomplete escape sequence at end-of-input — is stripped.
const DANGEROUS_C0_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function sanitize(s) {
  return s.replace(ANSI_PATTERN, "").replace(DANGEROUS_C0_PATTERN, "");
}

// Stream-friendly sanitizer. ANSI sequences can straddle chunk boundaries —
// if we sanitized each chunk independently, an incomplete sequence at the
// chunk tail would slip through unfiltered. Hold any unfinished tail until
// the next chunk arrives.
export class TerminalSanitizer {
  constructor() { this.pending = ""; }

  push(chunk) {
    const text = this.pending + (typeof chunk === "string" ? chunk : chunk.toString());
    this.pending = "";
    const lastEsc = text.lastIndexOf("\x1b");
    if (lastEsc < 0) return sanitize(text);
    const tail = text.slice(lastEsc);
    const completedCsi = /\x1b\[[0-?]*[ -/]*[@-~]/.test(tail);
    const completedOsc = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.test(tail);
    const completedDcs = /\x1b[PX^_][^\x1b]*\x1b\\/.test(tail);
    const completedSimple = tail.length >= 2 && /[@-Z\\-_]/.test(tail[1]) &&
      tail[1] !== "[" && tail[1] !== "]" && tail[1] !== "P" && tail[1] !== "X" &&
      tail[1] !== "^" && tail[1] !== "_";
    if (completedCsi || completedOsc || completedDcs || completedSimple) {
      return sanitize(text);
    }
    // Cap the pending buffer. v0.5.0 review (Gemini) flagged that an
    // attacker streaming an unterminated ANSI sequence (e.g. `ESC [`
    // followed by infinite chars without a final letter) would grow
    // `this.pending` without bound and OOM the Node process. Drop the
    // accumulated tail once it exceeds MAX_PENDING_ESCAPE_BYTES — there
    // is no legitimate ANSI sequence longer than a few dozen bytes, so
    // anything past this cap is either a parser-state attack or a
    // malformed stream. We dropped the tail entirely rather than
    // attempt to sanitize it because partial-sequence bytes between an
    // ESC and an unknown terminator are still potentially dangerous to
    // a downstream terminal.
    if (tail.length > MAX_PENDING_ESCAPE_BYTES) {
      // Force-sanitize the entire text — the over-long tail will be
      // stripped by the sanitize() ANSI regex even if incomplete,
      // because the regex matches CSI/OSC/DCS prefixes up to their
      // terminators (which the partial tail does not have) and the
      // C0-control fallback catches the ESC byte itself.
      this.pending = "";
      return sanitize(text);
    }
    this.pending = tail;
    return sanitize(text.slice(0, lastEsc));
  }

  flush() {
    this.pending = "";
    return "";
  }
}

// Hard cap on the pending-escape buffer in TerminalSanitizer. Anything
// beyond this length without a terminator is either a parser-state
// attack or a malformed stream — force-drop and resync. 4 KiB is far
// more than any legitimate ANSI / OSC / DCS sequence (real-world max is
// ~80 bytes for OSC titlebar updates).
export const MAX_PENDING_ESCAPE_BYTES = 4 * 1024;

export function sanitizeForTerminal(s) { return sanitize(typeof s === "string" ? s : String(s)); }

export function renderJobTable(jobs) {
  if (jobs.length === 0) return "No Grok jobs in this workspace.";
  const lines = [
    "| Job | Kind | Status | Started | PID | Task |",
    "|-----|------|--------|---------|-----|------|"
  ];
  for (const j of jobs) {
    const task = (j.task_text || "").slice(0, 50).replace(/\|/g, "\\|");
    lines.push(
      `| ${j.id} | ${j.kind}${j.write ? " (w)" : ""} | ${j.status} | ${fmtTime(j.started_at)} | ${j.pid ?? "-"} | ${task} |`
    );
  }
  return lines.join("\n");
}

export function renderJobDetails(meta) {
  const lines = [];
  lines.push(`Job: ${meta.id}`);
  lines.push(`Kind: ${meta.kind}${meta.write ? " (write)" : ""}`);
  lines.push(`Status: ${meta.status}`);
  lines.push(`PID: ${meta.pid ?? "-"}`);
  lines.push(`Started: ${fmtTime(meta.started_at)}`);
  if (meta.ended_at) lines.push(`Ended: ${fmtTime(meta.ended_at)}`);
  if (meta.exit_code !== undefined) lines.push(`Exit: ${meta.exit_code}`);
  // v0.9.7 (3/3 round-7): use formatSessionLabel — same single source of
  // truth as cmdTask footer and cmdResult. Removed the duplicated
  // priority-chain ladder that round-7 reviewers all flagged.
  const sessionLine = formatSessionLabel(meta);
  if (sessionLine) lines.push(sessionLine);
  lines.push(`Task: ${meta.task_text || "-"}`);
  lines.push("");
  lines.push("Follow-up:");
  lines.push(`- /grok:result ${meta.id}`);
  lines.push(`- /grok:cancel ${meta.id}`);
  return lines.join("\n");
}
