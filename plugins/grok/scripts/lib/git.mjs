// Git helpers for review scope detection and diff capture.

import { spawnSync } from "node:child_process";

// Hard cap on diff bytes piped to Grok. A massive working-tree diff (e.g.
// from accidentally-tracked binaries or generated assets) would otherwise
// OOM Node before Grok even sees it. 4 MB is generous for code review;
// anything larger is truncated with a marker so the reviewer knows.
export const MAX_DIFF_BYTES = 4 * 1024 * 1024;

// Refs we accept on the command line. Forbids anything starting with `-`
// (would be parsed as a git option), null bytes, whitespace, and quote
// metacharacters. Permits the standard `[a-zA-Z0-9_./-]` plus refspec syntax.
const REF_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_./@^~-]*$/;
export function isValidGitRef(ref) {
  return typeof ref === "string" && REF_PATTERN.test(ref) && ref.length < 256;
}

export function isInsideRepo(cwd) {
  const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { encoding: "utf8", cwd });
  return r.status === 0;
}

export function guessBaseRef(cwd) {
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    const r = spawnSync("git", ["rev-parse", "--verify", ref], { encoding: "utf8", cwd });
    if (r.status === 0) return ref;
  }
  return null;
}

function truncateDiff(diff) {
  if (diff.length <= MAX_DIFF_BYTES) return diff;
  const head = diff.slice(0, MAX_DIFF_BYTES);
  return head + `\n\n[... diff truncated by grok-plugin: ${diff.length - MAX_DIFF_BYTES} bytes omitted to stay under ${MAX_DIFF_BYTES} bytes]\n`;
}

export function captureDiff({ scope, base, cwd } = {}) {
  if (!isInsideRepo(cwd)) return { kind: "no-repo", diff: "" };

  if (scope === "branch") {
    const ref = base || guessBaseRef(cwd);
    if (!ref) return { kind: "no-base", diff: "" };
    if (!isValidGitRef(ref)) return { kind: "bad-ref", diff: "", base: ref };
    // Verify the ref actually resolves before diffing. Without this, a typo
    // like `--base mian` produces an empty diff and the caller cannot tell
    // it apart from a clean branch.
    const verify = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { encoding: "utf8", cwd });
    if (verify.status !== 0) return { kind: "bad-ref", diff: "", base: ref };
    // `--` separates options from refspecs so a ref that somehow slipped past
    // our regex still can't be parsed as an option.
    const r = spawnSync("git", ["diff", "--", `${ref}...HEAD`], { encoding: "utf8", cwd });
    // Some versions of git diff don't accept `--` before a refspec. Fall back
    // to plain form if the validated ref-only form failed.
    const out = r.status === 0
      ? (r.stdout || "")
      : (spawnSync("git", ["diff", `${ref}...HEAD`], { encoding: "utf8", cwd }).stdout || "");
    return { kind: "branch", diff: truncateDiff(out), base: ref };
  }
  if (scope === "staged") {
    const r = spawnSync("git", ["diff", "--cached"], { encoding: "utf8", cwd });
    return { kind: "staged", diff: truncateDiff(r.stdout || "") };
  }
  if (scope === "unstaged") {
    const r = spawnSync("git", ["diff"], { encoding: "utf8", cwd });
    return { kind: "unstaged", diff: truncateDiff(r.stdout || "") };
  }
  // auto / working-tree
  const cached = spawnSync("git", ["diff", "--cached"], { encoding: "utf8", cwd }).stdout || "";
  const unstaged = spawnSync("git", ["diff"], { encoding: "utf8", cwd }).stdout || "";
  return { kind: "working-tree", diff: truncateDiff(cached + unstaged) };
}
