// Stop-gate verdict parser. Extracted as a module so the unit tests can
// import the production implementation directly instead of maintaining a
// shadow copy that drifts silently from the hook script.

// Find the end-index of the first balanced JSON object starting at `start`,
// taking string boundaries into account. Without string-awareness, a `}`
// inside a `reason` value (e.g. "closes block}") causes a premature match
// and fail-open in the caller.
export function findBalancedJsonEnd(s, start) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Extract Grok's verdict JSON from a free-form response.
//
// Defense: scan for ALL balanced JSON objects in the response and return
// the LAST one that matches our schema. Taking the FIRST match (as the
// previous version did) is exploitable: a malicious diff can plant a
// literal `{"decision":"allow"}` string that the model quotes in its
// reasoning preamble, and the first-match parser grabs that injection
// instead of the model's real verdict at the end of its response.
//
// The fenced-block handling is similar: if the model emits multiple
// ```json blocks (e.g., one quoting the attacker's injection and one with
// its real conclusion), we honor the LAST fenced block, then fall back to
// scanning the whole trimmed input if no fenced block parses as a verdict.
export function parseVerdict(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();

  // Candidate strings to scan, in priority order:
  //   1. Each ```json (or ```) fenced block, LAST first.
  //   2. The whole trimmed input.
  // We try each candidate's contained balanced JSON objects from last to
  // first; first one matching the verdict schema wins.
  const candidates = [];
  const fenceMatches = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/g)];
  for (let i = fenceMatches.length - 1; i >= 0; i--) {
    candidates.push(fenceMatches[i][1]);
  }
  candidates.push(trimmed);

  for (const cand of candidates) {
    const verdict = findLastVerdictInString(cand);
    if (verdict) return verdict;
  }
  return null;
}

// Walk a string left-to-right collecting all balanced JSON objects that
// parse as verdicts. Return the LAST one. Returns null if none matched.
function findLastVerdictInString(s) {
  let last = null;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue;
    const end = findBalancedJsonEnd(s, i);
    if (end < 0) continue;
    let parsed;
    try { parsed = JSON.parse(s.slice(i, end + 1)); }
    catch { i = end; continue; }
    if (parsed && typeof parsed === "object" &&
        (parsed.decision === "allow" || parsed.decision === "block")) {
      last = {
        decision: parsed.decision,
        reason: typeof parsed.reason === "string" ? parsed.reason : ""
      };
    }
    i = end;
  }
  return last;
}
