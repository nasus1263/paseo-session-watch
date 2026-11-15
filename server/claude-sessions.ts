import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { outstandingBackgroundTasks } from "../shared/claude-transcript";

const pathBySession = new Map<string, string>();
const parsed = new Map<string, { size: number; mtimeMs: number; outstanding: string[] }>();

function projectsDir() {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
}

async function locate(sessionId: string): Promise<string | null> {
  const cached = pathBySession.get(sessionId);
  if (cached) return cached;
  const root = projectsDir();
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const file = join(root, dir, `${sessionId}.jsonl`);
    try {
      if ((await stat(file)).isFile()) {
        pathBySession.set(sessionId, file);
        return file;
      }
    } catch {
      // Not in this project directory.
    }
  }
  return null;
}

/**
 * Background tasks still running in a Claude session, or null when the transcript is not
 * readable (then the caller relies on the quiet period alone).
 */
export async function claudeOutstandingTasks(sessionId: string): Promise<string[] | null> {
  const file = await locate(sessionId);
  if (!file) return null;
  let info: { size: number; mtimeMs: number };
  try {
    info = await stat(file);
  } catch {
    pathBySession.delete(sessionId);
    return null;
  }
  const hit = parsed.get(file);
  if (hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs) return hit.outstanding;
  const outstanding = outstandingBackgroundTasks(await readFile(file, "utf8"));
  parsed.set(file, { size: info.size, mtimeMs: info.mtimeMs, outstanding });
  return outstanding;
}

/** Milliseconds since the Claude transcript was last written, or null when it is not readable. */
export async function claudeTranscriptAgeMs(sessionId: string): Promise<number | null> {
  const file = await locate(sessionId);
  if (!file) return null;
  try {
    return Date.now() - (await stat(file)).mtimeMs;
  } catch {
    pathBySession.delete(sessionId);
    return null;
  }
}
