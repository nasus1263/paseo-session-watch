import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Plan } from "../shared/plan";

export const DEFAULT_PLAN_FILE = join(homedir(), ".paseo", "plugin-data", "paseo-session-watch", "plan.json");

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
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(plan, null, 2), "utf8");
  await rename(tmp, file);
}
