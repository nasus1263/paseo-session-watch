import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyTurnEnd, exhaustedUntil, parseRetryIn, resumeAt } from "../shared/limit.ts";

const completed = { kind: "completed" };

test("Claude limit arrives as a completed turn whose last message is the limit notice", () => {
  assert.equal(classifyTurnEnd(completed, "You've hit your limit · resets 3pm (Asia/Seoul)"), "limit");
  assert.equal(classifyTurnEnd(completed, "You’ve reached your weekly limit · resets Nov 14"), "limit");
  assert.equal(classifyTurnEnd(completed, "You're out of extra usage · resets 4am"), "limit");
  assert.equal(classifyTurnEnd(completed, "Claude AI usage limit reached|1731600000"), "limit");
});

test("a normal answer that merely mentions limits is done", () => {
  assert.equal(classifyTurnEnd(completed, "작업을 마쳤습니다. rate limit 처리도 추가했습니다."), "done");
  const long = "You've hit your target. " + "x".repeat(600);
  assert.equal(classifyTurnEnd(completed, long), "done");
  assert.equal(classifyTurnEnd(completed, null), "done");
});

test("Codex limit arrives as a failed turn", () => {
  const end = { kind: "failed", message: "You've hit your usage limit. Try again in 2 hours 5 minutes." };
  assert.equal(classifyTurnEnd(end, null), "limit");
  assert.equal(classifyTurnEnd({ kind: "failed", message: "Claude run failed: code 1" }, null), "failed");
  assert.equal(classifyTurnEnd({ kind: "canceled", message: "user" }, null), "failed");
});

test("exhausted windows pick the latest reset; healthy windows are ignored", () => {
  const until = exhaustedUntil([
    { usedPct: 100, remainingPct: 0, resetsAt: "2026-11-13T05:00:00Z" },
    { usedPct: 100, remainingPct: 0, resetsAt: "2026-11-14T00:00:00Z" },
    { usedPct: 40, remainingPct: 60, resetsAt: "2026-11-20T00:00:00Z" },
  ]);
  assert.equal(until, Date.parse("2026-11-14T00:00:00Z"));
  assert.equal(exhaustedUntil([{ usedPct: 78, remainingPct: 22, resetsAt: "2026-11-13T05:00:00Z" }]), null);
});

test("retry-in text is parsed into an absolute time", () => {
  assert.equal(parseRetryIn("Try again in 2 hours 5 minutes.", 0), (2 * 60 + 5) * 60_000);
  assert.equal(parseRetryIn("try again in 1d 3h", 0), 27 * 3_600_000);
  assert.equal(parseRetryIn("no time here", 0), null);
});

test("resume time: usage reset + margin, unknown → 30 min, quick relimit → at least 15 min", () => {
  const now = 1_000_000;
  assert.equal(resumeAt({ now, usageUntil: now + 3_600_000, text: "", resumedAt: null }), now + 3_600_000 + 120_000);
  assert.equal(resumeAt({ now, usageUntil: null, text: "", resumedAt: null }), now + 30 * 60_000);
  assert.equal(resumeAt({ now, usageUntil: null, text: "try again in 10 minutes", resumedAt: null }), now + 12 * 60_000);
  assert.equal(resumeAt({ now, usageUntil: now + 60_000, text: "", resumedAt: now - 60_000 }), now + 15 * 60_000);
});

import { outstandingBackgroundTasks } from "../shared/claude-transcript.ts";

const line = (o) => JSON.stringify(o);
const notification = (taskId, summary, interim = false) =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<status>completed</status>\n<summary>${summary}</summary>\n${
    interim ? "<note>This agent stopped with background work of its own still running. the result below may be interim.</note>\n" : ""
  }</task-notification>`;

test("transcript: launched background tasks stay outstanding until a final notification", () => {
  const launches = [
    line({ type: "user", toolUseResult: { status: "async_launched", agentId: "sub1" } }),
    line({ type: "user", toolUseResult: { backgroundTaskId: "sh1", stdout: "" } }),
    line({ type: "user", toolUseResult: { status: "completed", agentId: "fg" } }),
  ];
  assert.deepEqual(outstandingBackgroundTasks(launches.join("\n")), ["sub1", "sh1"]);

  const interim = line({ type: "queue-operation", operation: "enqueue", content: notification("sub1", "waiting on its own background work", true) });
  const shellDone = line({ type: "user", message: { role: "user", content: notification("sh1", "Background command completed") } });
  assert.deepEqual(outstandingBackgroundTasks([...launches, interim, shellDone].join("\n")), ["sub1"]);

  const final = line({ type: "user", message: { role: "user", content: [{ type: "text", text: notification("sub1", "Agent completed") }] } });
  assert.deepEqual(outstandingBackgroundTasks([...launches, interim, shellDone, final, "{ partial"].join("\n")), []);
});
