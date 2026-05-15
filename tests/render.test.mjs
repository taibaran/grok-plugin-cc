import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TerminalSanitizer,
  sanitizeForTerminal,
  renderJobTable,
  renderJobDetails,
  fmtTime
} from "../plugins/grok/scripts/lib/render.mjs";

test("sanitizeForTerminal strips CSI color sequences", () => {
  const input = "\x1b[31mred text\x1b[0m";
  assert.equal(sanitizeForTerminal(input), "red text");
});

test("sanitizeForTerminal strips OSC clipboard writes (OSC 52)", () => {
  // ESC ] 52 ; c ; <base64> BEL
  const input = "before\x1b]52;c;ZHJvcA==\x07after";
  assert.equal(sanitizeForTerminal(input), "beforeafter");
});

test("sanitizeForTerminal removes dangerous C0 controls but keeps tab/newline/cr", () => {
  // NUL must go; \t, \n, \r must stay.
  assert.equal(sanitizeForTerminal("a\x00b\tc\nd\re"), "ab\tc\nd\re");
});

test("sanitizeForTerminal removes Grok's stderr ANSI prefixes", () => {
  // Real ANSI seen in `grok` stderr: dim + reset around ERROR markers.
  const input = "\x1b[2m2026-05-14T19:53:15.610700Z\x1b[0m \x1b[31mERROR\x1b[0m something happened";
  assert.equal(sanitizeForTerminal(input), "2026-05-14T19:53:15.610700Z ERROR something happened");
});

test("TerminalSanitizer holds incomplete escapes across chunks", () => {
  const s = new TerminalSanitizer();
  // First chunk ends mid-CSI: "\x1b[3"
  const out1 = s.push("hello\x1b[3");
  // The incomplete tail should be held, only "hello" emitted.
  assert.equal(out1, "hello");
  // Next chunk completes the sequence and adds text.
  const out2 = s.push("1mred\x1b[0m");
  assert.equal(out2, "red");
  // Flush should produce empty (no orphans remaining after the close).
  assert.equal(s.flush(), "");
});

test("TerminalSanitizer flush drops an unterminated escape rather than leaking partial bytes", () => {
  const s = new TerminalSanitizer();
  s.push("safe\x1b[3");  // unfinished CSI
  // Flush should NOT emit the dangling "\x1b[3"; the security guarantee is
  // that no orphan ESC byte ever reaches the terminal.
  assert.equal(s.flush(), "");
});

test("renderJobTable emits a placeholder when there are no jobs", () => {
  assert.equal(renderJobTable([]), "No Grok jobs in this workspace.");
});

test("renderJobTable produces a Markdown table for one or more jobs", () => {
  const out = renderJobTable([
    {
      id: "x-abc-1234",
      kind: "task",
      status: "running",
      started_at: "2026-05-14T22:50:00.000Z",
      pid: 12345,
      task_text: "investigate the bug"
    }
  ]);
  assert.match(out, /\| Job \| Kind \| Status \| Started \| PID \| Task \|/);
  assert.match(out, /x-abc-1234/);
  assert.match(out, /task/);
  assert.match(out, /running/);
});

test("renderJobDetails includes the session id when present (review jobs)", () => {
  // v0.9.7 (Codex P2 round-7): the legacy session_id branch is now
  // gated on `meta.kind !== "task"` because task jobs use plain output
  // and the parsed session_id could be a model hallucination. Switch
  // this test to a review-class job where session_id from the parsed
  // JSON envelope is authoritative.
  const out = renderJobDetails({
    id: "x-abc-1234",
    kind: "review",
    status: "completed",
    pid: 12345,
    started_at: "2026-05-14T22:50:00.000Z",
    ended_at: "2026-05-14T22:55:00.000Z",
    exit_code: 0,
    session_id: "session-xyz-789",
    task_text: "investigate"
  });
  assert.match(out, /Session: session-xyz-789/);
  assert.match(out, /completed/);
  assert.match(out, /Exit: 0/);
});

test("fmtTime drops millisecond precision and the T separator", () => {
  assert.equal(fmtTime("2026-05-14T22:55:00.123Z"), "2026-05-14 22:55:00");
  assert.equal(fmtTime(""), "-");
  assert.equal(fmtTime(null), "-");
});
