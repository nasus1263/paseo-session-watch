import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const NodeState = z.enum(["pending", "running", "waiting_quota", "done", "failed", "skipped"]);
export type NodeState = z.infer<typeof NodeState>;

const CreateSpec = z.object({
  cwd: z.string().min(1),
  provider: z.string().min(1), // "provider/model"
  modeId: z.string().optional(),
  title: z.string().optional(),
  prompt: z.string().min(1),
});

const NodeBase = z.object({
  id: z.string(),
  after: z.array(z.string()),
  label: z.string(),
  agentId: z.string().nullable(),
  state: NodeState,
  startedAt: z.number().nullable(),
  resumedAt: z.number().nullable(),
  quotaUntil: z.number().nullable(),
  limitHits: z.number(),
  pendingPermissionSince: z.number().nullable(),
  note: z.string().nullable(),
});

export const PlanNode = z.discriminatedUnion("kind", [
  NodeBase.extend({ kind: z.literal("watch") }),
  NodeBase.extend({
    kind: z.literal("send"),
    target: z.union([z.object({ agentId: z.string() }), z.object({ nodeId: z.string() })]),
    text: z.string().min(1),
  }),
  NodeBase.extend({ kind: z.literal("create"), create: CreateSpec }),
]);
export type PlanNode = z.infer<typeof PlanNode>;

export const LogEntry = z.object({ at: z.number(), text: z.string() });

export const Plan = z.object({
  id: z.string(),
  createdAt: z.number(),
  status: z.enum(["active", "shutting_down", "finished", "canceled"]),
  shutdown: z.boolean(),
  resumeMessage: z.string(),
  permissionTimeoutMin: z.number(),
  shutdownAt: z.number().nullable(),
  nodes: z.array(PlanNode),
  log: z.array(LogEntry),
});
export type Plan = z.infer<typeof Plan>;

// What the editor sends. Node ids are chosen by the client ("n1", "n2", ...).
export const DraftNode = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("watch"), id: z.string(), agentId: z.string(), label: z.string() }),
  z.object({
    kind: z.literal("send"),
    id: z.string(),
    after: z.array(z.string()),
    target: z.union([z.object({ agentId: z.string() }), z.object({ nodeId: z.string() })]),
    text: z.string().min(1),
    label: z.string(),
  }),
  z.object({ kind: z.literal("create"), id: z.string(), after: z.array(z.string()), create: CreateSpec, label: z.string() }),
]);
export type DraftNode = z.infer<typeof DraftNode>;

export const AgentRow = z.object({
  id: z.string(),
  title: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  modeId: z.string().nullable(),
  status: z.string(),
  cwd: z.string(),
  lastActivityAt: z.string().nullable(),
});
export type AgentRow = z.infer<typeof AgentRow>;

export const stateRpc = defineRpc({
  name: "watch.state",
  input: z.object({}),
  output: z.object({ plan: Plan.nullable(), now: z.number() }),
});

export const agentsRpc = defineRpc({
  name: "watch.agents",
  input: z.object({}),
  output: z.object({ agents: z.array(AgentRow) }),
});

export const startRpc = defineRpc({
  name: "watch.start",
  input: z.object({
    nodes: z.array(DraftNode).min(1),
    shutdown: z.boolean(),
    resumeMessage: z.string().min(1),
    permissionTimeoutMin: z.number().min(1),
  }),
  output: z.object({ plan: Plan }),
});

export const cancelRpc = defineRpc({
  name: "watch.cancel",
  input: z.object({}),
  output: z.object({ plan: Plan.nullable() }),
});

export const clearRpc = defineRpc({
  name: "watch.clear",
  input: z.object({}),
  output: z.object({}),
});

export const TERMINAL: readonly NodeState[] = ["done", "failed", "skipped"];
export const isTerminal = (s: NodeState) => TERMINAL.includes(s);

/** Target agent id of a node, resolving node references through already-created agents. */
export function nodeAgentId(plan: Plan, node: PlanNode): string | null {
  if (node.kind === "watch" || node.kind === "create") return node.agentId;
  if ("agentId" in node.target) return node.target.agentId;
  const ref = node.target.nodeId;
  const other = plan.nodes.find((n) => n.id === ref);
  return other ? nodeAgentId(plan, other) : null;
}

/** Turns a draft into plan nodes: validates references and serialises turns on the same agent. */
export function buildNodes(drafts: readonly DraftNode[]): PlanNode[] {
  const ids = new Set<string>();
  for (const d of drafts) {
    if (ids.has(d.id)) throw new Error(`중복된 노드 id: ${d.id}`);
    ids.add(d.id);
  }
  const base = { agentId: null, state: "pending" as const, startedAt: null, resumedAt: null, quotaUntil: null, limitHits: 0, pendingPermissionSince: null, note: null };
  const nodes: PlanNode[] = [];
  // Agent key per node: a fixed agent id, or the creating node's id for agents made by the plan.
  const keyOf = new Map<string, string>();
  for (const d of drafts) {
    const after = d.kind === "watch" ? [] : [...d.after];
    for (const a of after) if (!ids.has(a) || a === d.id) throw new Error(`${d.id}: 알 수 없는 선행 노드 ${a}`);
    let key: string;
    if (d.kind === "watch") key = `agent:${d.agentId}`;
    else if (d.kind === "create") key = `node:${d.id}`;
    else if ("agentId" in d.target) key = `agent:${d.target.agentId}`;
    else {
      const k = keyOf.get(d.target.nodeId);
      if (!k) throw new Error(`${d.id}: 대상 노드 ${d.target.nodeId}는 이 노드보다 앞에 있어야 합니다`);
      key = k;
    }
    // Earlier nodes on the same agent run first.
    for (const [nid, k] of keyOf) if (k === key && !after.includes(nid)) after.push(nid);
    keyOf.set(d.id, key);
    if (d.kind === "watch") nodes.push({ ...base, kind: "watch", id: d.id, label: d.label, after, agentId: d.agentId });
    else if (d.kind === "send") nodes.push({ ...base, kind: "send", id: d.id, label: d.label, after, target: d.target, text: d.text });
    else nodes.push({ ...base, kind: "create", id: d.id, label: d.label, after, create: d.create });
  }
  // Drafts are in order and each node may only depend on known ids; reject cycles.
  const visiting = new Set<string>();
  const done = new Set<string>();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const visit = (id: string) => {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new Error(`순환 의존: ${id}`);
    visiting.add(id);
    for (const a of byId.get(id)!.after) visit(a);
    visiting.delete(id);
    done.add(id);
  };
  for (const n of nodes) visit(n.id);
  return nodes;
}

/** Pending nodes whose dependencies settled: ready to start, or to skip after a failed dependency. */
export function settlePending(plan: Plan): { start: PlanNode[]; skip: PlanNode[] } {
  const state = new Map(plan.nodes.map((n) => [n.id, n.state]));
  const start: PlanNode[] = [];
  const skip: PlanNode[] = [];
  for (const n of plan.nodes) {
    if (n.state !== "pending") continue;
    const deps = n.after.map((a) => state.get(a)!);
    if (deps.some((s) => s === "failed" || s === "skipped")) skip.push(n);
    else if (deps.every((s) => s === "done")) start.push(n);
  }
  return { start, skip };
}
