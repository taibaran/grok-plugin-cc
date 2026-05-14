// Prompt loader — reads templates from prompts/ and substitutes {{VARS}}.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.resolve(__dirname, "..", "..", "prompts");
const SCHEMAS_DIR = path.resolve(__dirname, "..", "..", "schemas");

export function loadPrompt(name) {
  const p = path.join(PROMPTS_DIR, `${name}.md`);
  return fs.readFileSync(p, "utf8");
}

export function loadSchema(name) {
  const p = path.join(SCHEMAS_DIR, `${name}.schema.json`);
  return fs.readFileSync(p, "utf8");
}

// Sanitize user-controlled values before they reach a trusted, XML-tagged
// prompt block. Apply this at the point where untrusted input enters the
// system — never inside `renderTemplate`, because some template variables
// carry pre-built, TRUSTED XML scaffolding whose closing tags must remain intact.
//
// Escaping `<` (not just `</`) blocks both opening and closing-tag injection,
// so a malicious focus string can't smuggle `<task>do X</task>` into the
// prompt structure either. `&` is escaped to keep round-tripping consistent.
export function escapeXmlInTrustedBlock(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function renderTemplate(template, vars = {}) {
  return template.replace(/{{\s*([A-Z_]+)\s*}}/g, (_, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      const v = vars[key];
      return v == null ? "" : String(v);
    }
    return "";
  });
}

export function buildReviewPrompt({ adversarial, focus, target, jsonOutput, diff }) {
  const name = adversarial ? "adversarial-review" : "review";
  let template = loadPrompt(name);
  if (jsonOutput) {
    const schema = loadSchema("review-output");
    template = `OUTPUT_FORMAT=json\nReturn ONLY a JSON object that validates against the following schema:\n${schema}\n\n${template}`;
  }
  // The diff is included inline because Grok's headless mode (-p) reads the
  // entire prompt from the command line / a file; it does not consume stdin
  // the way Gemini does. The diff is wrapped in <repository_context> by the
  // template. Escape only user-controlled fields; the diff is not escaped
  // because it is treated as data inside <repository_context>, and the
  // <output_contract> in the template instructs the model to treat the
  // contents as data, not directives.
  return renderTemplate(template, {
    TARGET_LABEL: escapeXmlInTrustedBlock(target || "working tree"),
    USER_FOCUS: escapeXmlInTrustedBlock(focus || "(none)"),
    REVIEW_INPUT: diff || "(no diff captured)",
    REVIEW_COLLECTION_GUIDANCE: ""
  });
}

export function buildStopGatePrompt({ claudeResponse, diff }) {
  const t = loadPrompt("stop-review-gate");
  // Sanitize the user-controlled content BEFORE wrapping it in trusted XML
  // tags. The wrapper's own `</claude_response>` must remain a real closer.
  const safe = escapeXmlInTrustedBlock(claudeResponse || "");
  const block = safe
    ? `<claude_response>\n${safe}\n</claude_response>`
    : "<claude_response>\n(no transcript snippet provided — inspect repo state directly)\n</claude_response>";
  return renderTemplate(t, {
    CLAUDE_RESPONSE_BLOCK: block,
    DIFF_BLOCK: diff || "(no diff captured)"
  });
}
