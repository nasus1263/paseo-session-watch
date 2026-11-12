import { execFile } from "node:child_process";
import type { PaseoApi } from "@getpaseo/client";
import { exhaustedUntil } from "../shared/limit";
import type { AgentRow } from "../shared/plan";
import type { Gateway } from "./engine";

const SHUTDOWN_COMMENT = "Paseo 세션 감시: 모든 작업이 끝나 60초 후 PC를 종료합니다.";

function run(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error, _stdout, stderr) => {
      if (error) reject(new Error(`${file} ${args.join(" ")}: ${stderr || error.message}`));
      else resolve();
    });
  });
}

export function paseoGateway(paseo: PaseoApi): Gateway {
  return {
    async agent(id) {
      const result = await paseo.agents.ref(id).refresh();
      if (!result) return null;
      const a = result.agent;
      return {
        status: a.status,
        provider: a.provider,
        lastError: a.lastError ?? null,
        pendingPermissions: a.pendingPermissions?.length ?? 0,
        archived: Boolean(a.archivedAt),
      };
    },

    async lastAssistantText(id) {
      const page = await paseo.agents.ref(id).timeline.refetch({ direction: "tail", limit: 30 });
      const items = page.entries.map((entry) => entry.item);
      let lastUser = -1;
      items.forEach((item, i) => {
        if (item.type === "user_message") lastUser = i;
      });
      const text = items
        .slice(lastUser + 1)
        .flatMap((item) => (item.type === "assistant_message" ? [item.text] : []))
        .join("");
      return text.trim() || null;
    },

    async send(id, text) {
      await paseo.agents.ref(id).send(text);
    },

    async create({ cwd, provider, modeId, title, prompt }) {
      const handle = await paseo.agents.create({
        cwd,
        config: { provider, ...(modeId ? { modeId } : {}) },
        ...(title ? { title } : {}),
        prompt,
      });
      return handle.id;
    },

    async usageUntil(provider) {
      const usage = await paseo.providers.listUsage();
      const windows = usage.providers
        .filter((p) => p.providerId === provider && p.status === "available")
        .flatMap((p) => p.windows);
      return exhaustedUntil(windows);
    },

    shutdown: () => run("shutdown", ["/s", "/t", "60", "/c", SHUTDOWN_COMMENT]),
    abortShutdown: () => run("shutdown", ["/a"]),
  };
}

export async function listAgents(paseo: PaseoApi): Promise<AgentRow[]> {
  const result = await paseo.agents.list();
  return result.entries
    .map(({ agent }) => agent)
    .filter((a) => !a.archivedAt && !a.internal)
    .map((a) => ({
      id: a.id,
      title: a.title ?? a.id.slice(0, 8),
      provider: a.provider,
      model: a.model ?? null,
      modeId: a.currentModeId ?? null,
      status: a.status,
      cwd: a.cwd,
      lastActivityAt: a.updatedAt ?? null,
    }))
    .sort((x, y) => (y.lastActivityAt ?? "").localeCompare(x.lastActivityAt ?? ""));
}
