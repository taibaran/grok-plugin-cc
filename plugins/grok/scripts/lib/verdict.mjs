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

// Extract the first JSON object from Grok's output and validate it has
// our expected shape. Returns null if the output is not parseable as our
// verdict format — caller treats that as fail-open "allow".
export function parseVerdict(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  // Allow Grok to wrap in ```json fences even though we asked it not to.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenced ? fenced[1] : trimmed;
  const start = candidate.indexOf("{");
  if (start < 0) return null;
  const end = findBalancedJsonEnd(candidate, start);
  if (end < 0) return null;
  let parsed;
  try { parsed = JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.decision !== "allow" && parsed.decision !== "block") return null;
  return {
    decision: parsed.decision,
    reason: typeof parsed.reason === "string" ? parsed.reason : ""
  };
}
