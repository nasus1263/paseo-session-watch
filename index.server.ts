import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { Engine } from "./server/engine";
import { listAgents, paseoGateway } from "./server/gateway";
import { DEFAULT_PLAN_FILE, DRAFT_FILE, loadDraft, loadPlan, saveDraft, savePlan } from "./server/store";
import { agentsRpc, cancelRpc, clearRpc, draftGetRpc, draftSetRpc, startRpc, stateRpc } from "./shared/plan";

const TICK_MS = 30_000;

export default function contribute(server: PluginServerContext) {
  const engine = new Engine((plan) => savePlan(DEFAULT_PLAN_FILE, plan));
  // The plan must be loaded before the first handler attaches the API and ticks.
  const loaded = loadPlan(DEFAULT_PLAN_FILE).then((plan) => engine.load(plan));
  const attach = (paseo: PaseoApi) => {
    if (engine.attached) return;
    void loaded.then(() => engine.attach(paseoGateway(paseo)));
  };

  server.handle(stateRpc, async (_input, { paseo }) => {
    attach(paseo);
    await loaded;
    return { plan: engine.snapshot(), now: Date.now() };
  });
  // Draft writes share one temp file, so they run one at a time.
  let draftWrites: Promise<unknown> = Promise.resolve();
  server.handle(draftGetRpc, async () => {
    await draftWrites;
    return { draft: await loadDraft(DRAFT_FILE) };
  });
  server.handle(draftSetRpc, async ({ draft }) => {
    const write = draftWrites.then(() => saveDraft(DRAFT_FILE, draft));
    draftWrites = write.catch(() => undefined);
    await write;
    return {};
  });
  server.handle(agentsRpc, async (_input, { paseo }) => {
    attach(paseo);
    return { agents: await listAgents(paseo) };
  });
  server.handle(startRpc, async (input, { paseo }) => {
    attach(paseo);
    await loaded;
    return { plan: await engine.start(input) };
  });
  server.handle(cancelRpc, async (_input, { paseo }) => {
    attach(paseo);
    await loaded;
    return { plan: await engine.cancel() };
  });
  server.handle(clearRpc, async (_input, { paseo }) => {
    attach(paseo);
    await loaded;
    await engine.clear();
    return {};
  });

  const removeTurnAfter = server.addHook("agent.turn.after", async ({ agent, outcome }, { paseo }) => {
    attach(paseo);
    await loaded;
    const end =
      outcome.kind === "completed"
        ? ({ kind: "completed" } as const)
        : outcome.kind === "failed"
          ? ({ kind: "failed", message: outcome.error.message } as const)
          : ({ kind: "canceled", message: outcome.reason } as const);
    void engine.onTurnEnd(agent.id, agent.provider, end);
  });
  const removeTurnBefore = server.addHook("agent.turn.before", async ({ agent }, { paseo }) => {
    attach(paseo);
    await loaded;
    void engine.onTurnStart(agent.id);
  });
  // Any hook hands over the API; this one fires often and costs nothing.
  const removePermission = server.addHook("agent.permission.before", async (_e, { paseo }) => attach(paseo));

  const timer = setInterval(() => void engine.tick(), TICK_MS);
  return () => {
    clearInterval(timer);
    removeTurnAfter();
    removeTurnBefore();
    removePermission();
  };
}
