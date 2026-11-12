import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { EditorDraft, EMPTY_DRAFT, Plan } from "../shared/plan";

const DATA_DIR = join(homedir(), ".paseo", "plugin-data", "paseo-session-watch");
export const DEFAULT_PLAN_FILE = join(DATA_DIR, "plan.json");
export const DRAFT_FILE = join(DATA_DIR, "draft.json");

export async function loadDraft(file: string): Promise<EditorDraft> {
  try {
    const parsed = EditorDraft.safeParse(JSON.parse(await readFile(file, "utf8")));
    return parsed.success ? parsed.data : EMPTY_DRAFT;
  } catch {
    return EMPTY_DRAFT;
  }
}

export async function saveDraft(file: string, draft: EditorDraft): Promise<void> {
  await writeAtomic(file, JSON.stringify(draft, null, 2));
}

export async function loadPlan(file: string): Promise<Plan | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }
  const parsed = Plan.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    console.error("저장된 계획을 읽지 못했습니다", parsed.error.message);
    return null;
  }
  return parsed.data;
}

/** Writes atomically so a crash never leaves a half-written plan. */
export async function savePlan(file: string, plan: Plan | null): Promise<void> {
  await writeAtomic(file, JSON.stringify(plan, null, 2));
}

async function writeAtomic(file: string, data: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, file);
}
