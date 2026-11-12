// Pure rules for recognising a provider usage-limit stop and choosing when to resume.

export type TurnEnd =
  | { kind: "completed" }
  | { kind: "failed"; message: string }
  | { kind: "canceled"; message: string };

export type EndVerdict = "done" | "limit" | "failed";

// Claude Code's own limit-message prefixes, plus Codex's wording.
const LIMIT_PREFIX = /^(you['’]ve (hit|reached) your|you['’]re out of (usage|extra usage)|claude ai usage limit reached)/i;
const LIMIT_ANYWHERE =
  /(you['’]ve (hit|reached) your[^.\n]*limit|usage[ _-]?limit|rate[ _-]?limit|limit reached|out of (usage|extra usage|credits)|quota exceeded|insufficient_quota)/i;
const MAX_LIMIT_TEXT = 500;

export function classifyTurnEnd(end: TurnEnd, lastAssistantText: string | null): EndVerdict {
  if (end.kind === "failed" && LIMIT_ANYWHERE.test(end.message)) return "limit";
  const text = (lastAssistantText ?? "").trim();
  if (text.length > 0 && text.length <= MAX_LIMIT_TEXT && LIMIT_PREFIX.test(text)) return "limit";
  return end.kind === "completed" ? "done" : "failed";
}

export interface UsageWindowLike {
  usedPct?: number | null;
  remainingPct?: number | null;
  resetsAt?: string | null;
}

/** Latest reset among exhausted windows, or null when none is known to be exhausted. */
export function exhaustedUntil(windows: readonly UsageWindowLike[]): number | null {
  let latest: number | null = null;
  for (const w of windows) {
    const exhausted = (w.remainingPct != null && w.remainingPct <= 0) || (w.usedPct != null && w.usedPct >= 100);
    if (!exhausted || !w.resetsAt) continue;
    const t = Date.parse(w.resetsAt);
    if (Number.isFinite(t) && (latest === null || t > latest)) latest = t;
  }
  return latest;
}

/** Parses "try again in 2 hours 3 minutes" style text into an absolute time. */
export function parseRetryIn(text: string, now: number): number | null {
  const m = /(?:try again|resets?|retry)\s+in\s+([^.\n]+)/i.exec(text);
  if (!m) return null;
  let ms = 0;
  for (const [, n, unit] of m[1].matchAll(/(\d+)\s*(d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)\b/gi)) {
    const u = unit.toLowerCase();
    const k = u.startsWith("d") ? 86_400_000 : u.startsWith("h") ? 3_600_000 : u.startsWith("m") ? 60_000 : 1_000;
    ms += Number(n) * k;
  }
  return ms > 0 ? now + ms : null;
}

export const RESUME_MARGIN_MS = 2 * 60_000;
export const UNKNOWN_RESET_WAIT_MS = 30 * 60_000;
export const QUICK_RELIMIT_MS = 5 * 60_000;
export const QUICK_RELIMIT_MIN_WAIT_MS = 15 * 60_000;
export const MAX_LIMIT_HITS = 50;

/** When to try resuming after a limit stop. */
export function resumeAt(input: {
  now: number;
  usageUntil: number | null;
  text: string;
  resumedAt: number | null;
}): number {
  const { now } = input;
  const known = input.usageUntil ?? parseRetryIn(input.text, now);
  let at = known !== null && known > now ? known + RESUME_MARGIN_MS : now + UNKNOWN_RESET_WAIT_MS;
  if (input.resumedAt !== null && now - input.resumedAt < QUICK_RELIMIT_MS) {
    at = Math.max(at, now + QUICK_RELIMIT_MIN_WAIT_MS);
  }
  return at;
}
