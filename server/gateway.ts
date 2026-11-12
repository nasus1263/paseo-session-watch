import { execFile } from "node:child_process";
import type { PaseoApi } from "@getpaseo/client";
import { exhaustedUntil } from "../shared/limit";
import type { AgentRow } from "../shared/plan";
import { claudeOutstandingTasks } from "./claude-sessions";
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
        updatedAt: a.updatedAt ?? null,
        sessionId: a.runtimeInfo?.sessionId ?? a.persistence?.sessionId ?? null,
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

    async activity(id, info) {
      const background =
        info.provider === "claude" && info.sessionId ? await claudeOutstandingTasks(info.sessionId) : null;
      return { background, busyChildren: await busyDescendants(paseo, id) };
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

const PARENT_LABEL = "paseo.parent-agent-id";

/** Agents created by this agent (recursively) that are still working or waiting on a permission. */
async function busyDescendants(paseo: PaseoApi, rootId: string): Promise<string[]> {
  const { entries } = await paseo.agents.list();
  const children = new Map<string, typeof entries>();
  for (const entry of entries) {
    const parent = entry.agent.labels?.[PARENT_LABEL];
    if (!parent) continue;
    children.set(parent, [...(children.get(parent) ?? []), entry]);
  }
  const busy: string[] = [];
  const queue = [rootId];
  const seen = new Set(queue);
  while (queue.length > 0) {
    for (const { agent } of children.get(queue.shift()!) ?? []) {
      if (seen.has(agent.id) || agent.archivedAt) continue;
      seen.add(agent.id);
      queue.push(agent.id);
      const working = agent.status === "running" || agent.status === "initializing";
      if (working || (agent.pendingPermissions?.length ?? 0) > 0) busy.push(agent.id);
    }
  }
  return busy;
}
