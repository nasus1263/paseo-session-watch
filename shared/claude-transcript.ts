// Reads a Claude Code session transcript (JSONL) to find background work that is still running.
// Paseo reports a Claude session idle as soon as its main turn ends, even while background
// subagents or background shell commands keep working; the transcript records both ends.

/**
 * Task ids launched in the background (subagents and shell commands) that have not yet
 * received a final completion notification. Interim notifications ("waiting on its own
 * background work", "may be interim") do not count as final.
 */
export function outstandingBackgroundTasks(jsonl: string): string[] {
  const launched: string[] = [];
  const finalized = new Map<string, boolean>();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // A partially written last line.
    }
    const result = entry.toolUseResult;
    if (result && typeof result === "object") {
      const r = result as Record<string, unknown>;
      const id =
        typeof r.backgroundTaskId === "string"
          ? r.backgroundTaskId
          : r.status === "async_launched" && typeof r.agentId === "string"
            ? r.agentId
            : null;
      if (id && !launched.includes(id)) launched.push(id);
    }
    for (const text of notificationTexts(entry)) {
      const taskId = tag(text, "task-id");
      if (!taskId) continue;
      finalized.set(taskId, !INTERIM.test(text));
    }
  }
  return launched.filter((id) => finalized.get(id) !== true);
}

const INTERIM = /may be interim|waiting on its own background work/i;

function tag(text: string, name: string): string | null {
  const open = `<${name}>`;
  const start = text.indexOf(open);
  if (start < 0) return null;
  const end = text.indexOf(`</${name}>`, start);
  return end < 0 ? null : text.slice(start + open.length, end).trim();
}

/** Notification bodies appear as queued operations and as user messages; the latest one wins. */
function notificationTexts(entry: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value.includes("<task-notification>")) out.push(value);
  };
  if (entry.type === "queue-operation") push(entry.content);
  if (entry.type === "user") {
    const message = entry.message as { content?: unknown } | undefined;
    const content = message?.content;
    if (typeof content === "string") push(content);
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === "object") push((part as { text?: unknown }).text);
      }
    }
  }
  return out;
}
