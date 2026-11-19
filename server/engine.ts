import { classifyTurnEnd, MAX_LIMIT_HITS, resumeAt, type TurnEnd } from "../shared/limit";
import {
  adoptedNode,
  buildNodes,
  isTerminal,
  nodeAgentId,
  settlePending,
  type DraftNode,
  type Plan,
  type AgentRow,
  type PlanNode,
} from "../shared/plan";

export interface AgentInfo {
  status: string; // initializing | idle | running | error | closed
  provider: string;
  lastError: string | null;
  pendingPermissions: number;
  archived: boolean;
  /** Changes whenever the daemon records activity, even while the status stays idle. */
  updatedAt: string | null;
  /** Provider session id (Claude transcript name), when known. */
  sessionId: string | null;
  title?: string | null;
  /** Paseo's own helper agents; never adopted by reviveAll. */
  internal?: boolean;
}

/** Work that can outlive a turn: provider background tasks and Paseo child agents. */
export interface Activity {
  /** Background task ids still running, or null when they cannot be read. */
  background: string[] | null;
  /** Descendant Paseo agents that are running or waiting on a permission. */
  busyChildren: string[];
}

/** Everything the engine needs from Paseo and the OS. */
export interface Gateway {
  agent(id: string): Promise<AgentInfo | null>;
  /** Visible (not archived, not internal) agents with their effective status. */
  list(): Promise<AgentRow[]>;
  lastAssistantText(id: string): Promise<string | null>;
  send(id: string, text: string): Promise<void>;
  create(spec: { cwd: string; provider: string; modeId?: string; title?: string; prompt: string }): Promise<string>;
  /** Latest reset among this provider's exhausted usage windows, or null when unknown. */
  usageUntil(provider: string): Promise<number | null>;
  activity(id: string, info: AgentInfo): Promise<Activity>;
  shutdown(): Promise<void>;
  abortShutdown(): Promise<void>;
}

export interface StartInput {
  nodes: DraftNode[];
  shutdown: boolean;
  waitForQuota?: boolean;
  reviveAll?: boolean;
  resumeMessage: string;
  permissionTimeoutMin: number;
  quietMin: number;
  backgroundMaxMin: number;
}

export const SHUTDOWN_DELAY_MS = 60_000;
/** A turn we just started may still read idle for a moment; trust snapshots only after this. */
const START_GRACE_MS = 60_000;
const MAX_LOG = 300;
/** reviveAll also adopts sessions limited shortly before the plan started: one usage window back. */
export const REVIVE_LOOKBACK_MS = 5 * 3_600_000;

const isBusy = (status: string) => status === "running" || status === "initializing";

export class Engine {
  private plan: Plan | null = null;
  private gateway: Gateway | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly persist: (plan: Plan | null) => Promise<void>;
  private readonly now: () => number;

  constructor(persist: (plan: Plan | null) => Promise<void>, now: () => number = Date.now) {
    this.persist = persist;
    this.now = now;
  }

  load(plan: Plan | null) {
    this.plan = plan;
  }

  /** Paseo hands the API only to handlers; the first one to run unlocks the engine. */
  attach(gateway: Gateway) {
    if (this.gateway) return;
    this.gateway = gateway;
    void this.tick();
  }

  get attached() {
    return this.gateway !== null;
  }

  snapshot(): Plan | null {
    return this.plan;
  }

  /** Every state change goes through this queue, so hooks and timers never interleave. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn);
    this.chain = next.catch((error) => console.error("세션 감시 작업 실패", error));
    return next;
  }

  start(input: StartInput): Promise<Plan> {
    return this.run(async () => {
      if (this.plan && (this.plan.status === "active" || this.plan.status === "shutting_down")) {
        throw new Error("이미 진행 중인 계획이 있습니다. 먼저 취소하세요.");
      }
      const reviveAll = (input.reviveAll ?? false) && (input.waitForQuota ?? true);
      const untilCanceled = input.nodes.length === 0;
      if (untilCanceled && !reviveAll) throw new Error("감시할 세션이나 후속 작업을 하나 이상 추가하세요.");
      const now = this.now();
      this.plan = {
        id: `plan-${now}`,
        createdAt: now,
        status: "active",
        shutdown: input.shutdown && !untilCanceled,
        waitForQuota: input.waitForQuota ?? true,
        // Reviving means waiting for the quota, so it needs waitForQuota.
        reviveAll,
        reviveSeen: {},
        untilCanceled,
        resumeMessage: input.resumeMessage,
        permissionTimeoutMin: input.permissionTimeoutMin,
        quietMin: input.quietMin,
        backgroundMaxMin: input.backgroundMaxMin,
        shutdownAt: null,
        nodes: buildNodes(input.nodes),
        log: [],
      };
      this.log(
        untilCanceled
          ? "계획 시작: 감시 세션 없이 한도로 멈춘 세션 재개만 합니다(취소할 때까지 계속, PC 종료 안 함)"
          : `계획 시작: 노드 ${this.plan.nodes.length}개, PC 종료 ${input.shutdown ? "켬" : "끔"}, 모든 세션 한도 재개 ${reviveAll ? "켬" : "끔"}`,
      );
      await this.advance();
      await this.save();
      return this.plan;
    });
  }

  cancel(): Promise<Plan | null> {
    return this.run(async () => {
      const plan = this.plan;
      if (!plan) return null;
      if (plan.status === "shutting_down") {
        await this.gateway?.abortShutdown();
        this.log("PC 종료를 취소했습니다");
      }
      if (plan.status === "active" || plan.status === "shutting_down") {
        plan.status = "canceled";
        this.log("계획을 취소했습니다. 에이전트는 그대로 둡니다");
        await this.save();
      }
      return plan;
    });
  }

  clear(): Promise<void> {
    return this.run(async () => {
      if (this.plan && (this.plan.status === "active" || this.plan.status === "shutting_down")) {
        throw new Error("진행 중인 계획은 지울 수 없습니다. 먼저 취소하세요.");
      }
      this.plan = null;
      await this.save();
    });
  }

  onTurnEnd(agentId: string, provider: string, end: TurnEnd): Promise<void> {
    return this.run(async () => {
      const node = this.runningNodeFor(agentId);
      if (node) await this.finishNode(node, provider, end);
      else if (!(await this.adoptIfLimited(agentId, end))) return;
      await this.advance();
      await this.save();
    });
  }

  /** A new turn on a settling agent (autonomous wake-up, queued message) means it was not done. */
  onTurnStart(agentId: string): Promise<void> {
    return this.run(async () => {
      const node = this.runningNodeFor(agentId);
      if (!node || node.state !== "settling") return;
      this.reopen(node, "새 턴 시작");
      await this.save();
    });
  }

  /** Periodic reconciliation: catches missed hooks, permission waits, and quota timers. */
  tick(): Promise<void> {
    return this.run(async () => {
      const plan = this.plan;
      const gw = this.gateway;
      if (!plan || !gw) return;
      const now = this.now();
      if (plan.status === "shutting_down") {
        // Still alive well after the scheduled shutdown: it was aborted outside the plugin.
        if (plan.shutdownAt !== null && now > plan.shutdownAt + 5 * 60_000) {
          plan.status = "finished";
          this.log("예정된 PC 종료가 일어나지 않았습니다(외부에서 취소된 것으로 봄)");
          await this.save();
        }
        return;
      }
      if (plan.status !== "active") return;

      for (const node of plan.nodes) {
        if (node.state === "running") await this.checkRunning(node, now);
        else if (node.state === "settling") await this.checkSettling(node, now);
        else if (node.state === "waiting_quota" && node.quotaUntil !== null && now >= node.quotaUntil) {
          await this.tryResume(node, now);
        }
      }
      if (plan.reviveAll) {
        await this.scanLimited().catch((error) => this.log(`한도 세션 점검 실패: ${describe(error)}`));
      }
      await this.advance();
      await this.save();
    });
  }

  private async checkRunning(node: PlanNode, now: number) {
    const gw = this.gateway!;
    const plan = this.plan!;
    const agentId = nodeAgentId(plan, node);
    if (!agentId) return;
    const info = await gw.agent(agentId);
    if (!info || info.archived) {
      this.fail(node, info ? "에이전트가 보관되었습니다" : "에이전트를 찾을 수 없습니다");
      return;
    }
    if (info.pendingPermissions > 0) {
      node.pendingPermissionSince ??= now;
      if (now - node.pendingPermissionSince > plan.permissionTimeoutMin * 60_000) {
        this.fail(node, `권한 요청이 ${plan.permissionTimeoutMin}분 넘게 대기 중`);
      }
      return;
    }
    node.pendingPermissionSince = null;
    if (isBusy(info.status)) return;
    if (node.startedAt !== null && now - node.startedAt < START_GRACE_MS) return;
    this.log(`${node.label}: 종료 훅을 놓쳐 스냅샷으로 판정합니다 (상태 ${info.status})`);
    await this.finishNode(node, info.provider, endFromSnapshot(info));
  }

  /**
   * Done only after the agent has stayed quiet for the whole quiet period: idle, no new turn,
   * no snapshot change, no running background task, and no busy descendant agent.
   */
  private async checkSettling(node: PlanNode, now: number) {
    const gw = this.gateway!;
    const plan = this.plan!;
    const agentId = nodeAgentId(plan, node)!;
    const info = await gw.agent(agentId);
    if (!info || info.archived) {
      this.fail(node, info ? "에이전트가 보관되었습니다" : "에이전트를 찾을 수 없습니다");
      return;
    }
    if (isBusy(info.status) || info.pendingPermissions > 0) {
      this.reopen(node, isBusy(info.status) ? "다시 실행 중" : "권한 요청 대기");
      return;
    }
    if (info.status === "error") {
      await this.finishNode(node, info.provider, endFromSnapshot(info));
      return;
    }
    let quietSince = node.settleSince ?? now;
    const reasons: string[] = [];
    if (node.lastUpdatedAt !== null && info.updatedAt !== node.lastUpdatedAt) {
      quietSince = now;
      reasons.push("활동 감지");
    }
    node.lastUpdatedAt = info.updatedAt;

    const activity = await gw.activity(agentId, info).catch(() => ({ background: null, busyChildren: [] }));
    if (activity.busyChildren.length > 0) {
      quietSince = now;
      reasons.push(`하위 에이전트 ${activity.busyChildren.length}개 실행 중`);
    }
    const background = activity.background ?? [];
    if (background.length > 0) {
      node.backgroundSince ??= now;
      if (now - node.backgroundSince <= plan.backgroundMaxMin * 60_000) {
        quietSince = now;
        reasons.push(`백그라운드 작업 ${background.length}개 실행 중`);
      } else {
        // From the cap on the leftover tasks are ignored; the quiet period counts from the cap.
        quietSince = Math.max(quietSince, node.backgroundSince + plan.backgroundMaxMin * 60_000);
        reasons.push(`백그라운드 작업 대기 ${plan.backgroundMaxMin}분 초과, 무시`);
      }
    } else {
      node.backgroundSince = null;
    }
    node.settleSince = quietSince;

    const quietMs = plan.quietMin * 60_000;
    if (now - quietSince >= quietMs) {
      node.state = "done";
      node.note = null;
      node.settleSince = null;
      node.backgroundSince = null;
      this.log(`${node.label}: 완료 (${plan.quietMin}분간 활동 없음)`);
      return;
    }
    const left = Math.ceil((quietMs - (now - quietSince)) / 60_000);
    const note = reasons.length > 0 ? `종료 확인 중: ${reasons.join(", ")}` : `종료 확인 중: ${left}분 더 조용하면 완료`;
    if (reasons.length > 0 && note !== node.note) this.log(`${node.label}: ${note}`);
    node.note = note;
  }

  /**
   * reviveAll: a session outside the plan that stopped on a usage limit becomes a plan node,
   * so it is resumed after the reset and the plan only finishes once it ends on its own.
   */
  private async adoptIfLimited(agentId: string, end: TurnEnd | null): Promise<boolean> {
    const plan = this.plan;
    const gw = this.gateway!;
    if (!plan || plan.status !== "active" || !plan.reviveAll || this.activeNodeFor(agentId)) return false;
    const info = await gw.agent(agentId);
    if (!info || info.archived || info.internal) return false;
    // Right after a hook the snapshot may still read busy; without a hook a busy agent is not stopped.
    if (!end && (isBusy(info.status) || info.pendingPermissions > 0)) return false;
    const turnEnd = end ?? endFromSnapshot(info);
    const text = await gw.lastAssistantText(agentId).catch(() => null);
    if (classifyTurnEnd(turnEnd, text) !== "limit") return false;
    const node = adoptedNode(plan, agentId, info.title ?? agentId);
    plan.nodes.push(node);
    this.log(`${node.label}: 계획 밖 세션이 한도로 멈춰 [${node.id}]로 추가`);
    await this.finishNode(node, info.provider, turnEnd);
    return true;
  }

  /** Catches limit stops the turn hook missed: checks each agent once per new activity. */
  private async scanLimited() {
    const plan = this.plan!;
    const from = plan.createdAt - REVIVE_LOOKBACK_MS;
    for (const row of await this.gateway!.list()) {
      const at = row.lastActivityAt;
      if (isBusy(row.status) || row.status === "closed") continue;
      if (!at || Date.parse(at) < from || plan.reviveSeen[row.id] === at || this.activeNodeFor(row.id)) continue;
      await this.adoptIfLimited(row.id, null);
      plan.reviveSeen[row.id] = at;
    }
  }

  /** Back to running from settling; the next turn end is judged from scratch. */
  private reopen(node: PlanNode, reason: string) {
    node.state = "running";
    node.startedAt = this.now();
    node.settleSince = null;
    node.lastUpdatedAt = null;
    node.note = null;
    this.log(`${node.label}: ${reason}, 감시 계속`);
  }

  private async finishNode(node: PlanNode, provider: string, end: TurnEnd) {
    const gw = this.gateway!;
    const agentId = nodeAgentId(this.plan!, node)!;
    const text = await gw.lastAssistantText(agentId).catch(() => null);
    const verdict = classifyTurnEnd(end, text);
    node.pendingPermissionSince = null;
    if (verdict === "done") {
      // A finished turn is only a candidate: background work or a wake-up may follow.
      node.state = "settling";
      node.settleSince = this.now();
      node.lastUpdatedAt = null;
      node.backgroundSince = null;
      node.note = "종료 확인 중";
      this.log(`${node.label}: 턴 종료, 종료 확인 시작`);
      return;
    }
    if (verdict === "failed") {
      this.fail(node, end.kind === "completed" ? "실패" : end.message);
      return;
    }
    if (!this.plan!.waitForQuota) {
      this.fail(node, "토큰 한도 도달(한도 대기 꺼짐)");
      return;
    }
    node.limitHits += 1;
    if (node.limitHits > MAX_LIMIT_HITS) {
      this.fail(node, `한도 재시도 ${MAX_LIMIT_HITS}회 초과`);
      return;
    }
    const now = this.now();
    const usageUntil = await gw.usageUntil(provider).catch(() => null);
    const message = [end.kind === "completed" ? "" : end.message, text ?? ""].join("\n");
    node.quotaUntil = resumeAt({ now, usageUntil, text: message, resumedAt: node.resumedAt });
    node.state = "waiting_quota";
    node.note = (text ?? message).trim().slice(0, 200) || null;
    this.log(`${node.label}: 한도 도달(${node.limitHits}회). ${new Date(node.quotaUntil).toISOString()}에 재개 시도`);
  }

  private async tryResume(node: PlanNode, now: number) {
    const gw = this.gateway!;
    const plan = this.plan!;
    const agentId = nodeAgentId(plan, node)!;
    const info = await gw.agent(agentId);
    if (!info || info.archived) {
      this.fail(node, "재개할 에이전트가 없습니다");
      return;
    }
    const until = await gw.usageUntil(info.provider).catch(() => null);
    if (until !== null && until > now) {
      node.quotaUntil = resumeAt({ now, usageUntil: until, text: "", resumedAt: null });
      this.log(`${node.label}: 아직 한도 소진 상태. ${new Date(node.quotaUntil).toISOString()}까지 다시 대기`);
      return;
    }
    if (isBusy(info.status)) {
      // Someone resumed it by hand; follow that turn instead of sending another prompt.
      node.state = "running";
      node.startedAt = now;
      this.log(`${node.label}: 이미 다시 실행 중이라 재개 메시지를 생략합니다`);
      return;
    }
    await gw.send(agentId, plan.resumeMessage);
    node.state = "running";
    node.startedAt = now;
    node.resumedAt = now;
    node.quotaUntil = null;
    this.log(`${node.label}: "${plan.resumeMessage}" 전송으로 재개`);
  }

  /** Starts or skips pending nodes until nothing changes, then checks for completion. */
  private async advance() {
    const plan = this.plan;
    const gw = this.gateway;
    if (!plan || plan.status !== "active" || !gw) return;
    for (let changed = true; changed; ) {
      changed = false;
      const { start, skip } = settlePending(plan);
      for (const node of skip) {
        node.state = "skipped";
        node.note = "선행 작업이 실패해 건너뜀";
        this.log(`${node.label}: 건너뜀`);
        changed = true;
      }
      for (const node of start) {
        const before = node.state;
        try {
          await this.startNode(node);
        } catch (error) {
          this.fail(node, `시작 실패: ${describe(error)}`);
        }
        if (node.state !== before) changed = true;
      }
    }
    if (!plan.untilCanceled && plan.nodes.every((n) => isTerminal(n.state))) await this.complete();
  }

  private async startNode(node: PlanNode) {
    const gw = this.gateway!;
    const plan = this.plan!;
    const now = this.now();
    if (node.kind === "create") {
      const { cwd, provider, modeId, title, prompt } = node.create;
      node.agentId = await gw.create({ cwd, provider, modeId, title, prompt });
      node.state = "running";
      node.startedAt = now;
      this.log(`${node.label}: 새 세션 ${node.agentId} 생성`);
      return;
    }
    const agentId = nodeAgentId(plan, node);
    if (!agentId) {
      this.fail(node, "대상 에이전트를 정할 수 없습니다");
      return;
    }
    const info = await gw.agent(agentId);
    if (!info || info.archived) {
      this.fail(node, info ? "에이전트가 보관되었습니다" : "에이전트를 찾을 수 없습니다");
      return;
    }
    if (node.kind === "watch") {
      if (isBusy(info.status)) {
        node.state = "running";
        node.startedAt = now;
        this.log(`${node.label}: 감시 시작`);
      } else {
        // Already stopped: judge its last turn now, which also catches a session cut off by a limit.
        node.startedAt = null;
        node.state = "running";
        await this.finishNode(node, info.provider, endFromSnapshot(info));
      }
      return;
    }
    if (isBusy(info.status)) return; // Wait for the agent's own turn to end first.
    node.agentId = agentId;
    await gw.send(agentId, node.text);
    node.state = "running";
    node.startedAt = now;
    this.log(`${node.label}: 메시지 전송`);
  }

  private async complete() {
    const plan = this.plan!;
    const failed = plan.nodes.filter((n) => n.state !== "done").length;
    this.log(`모든 작업 종결 (완료 ${plan.nodes.length - failed}, 실패/건너뜀 ${failed})`);
    if (!plan.shutdown) {
      plan.status = "finished";
      return;
    }
    try {
      await this.gateway!.shutdown();
      plan.status = "shutting_down";
      plan.shutdownAt = this.now() + SHUTDOWN_DELAY_MS;
      this.log("60초 후 PC를 종료합니다");
    } catch (error) {
      plan.status = "finished";
      this.log(`PC 종료 명령 실패: ${describe(error)}`);
    }
  }

  private runningNodeFor(agentId: string): PlanNode | undefined {
    const plan = this.plan;
    if (!plan || plan.status !== "active") return undefined;
    return plan.nodes.find(
      (n) => (n.state === "running" || n.state === "settling") && nodeAgentId(plan, n) === agentId,
    );
  }

  /** A node still responsible for this agent: one that is running, settling, or waiting on quota. */
  private activeNodeFor(agentId: string): PlanNode | undefined {
    const plan = this.plan!;
    return plan.nodes.find(
      (n) =>
        (n.state === "running" || n.state === "settling" || n.state === "waiting_quota") &&
        nodeAgentId(plan, n) === agentId,
    );
  }

  private fail(node: PlanNode, reason: string) {
    node.state = "failed";
    node.note = reason;
    node.pendingPermissionSince = null;
    this.log(`${node.label}: 실패 - ${reason}`);
  }

  private log(text: string) {
    const plan = this.plan;
    console.log(`[session-watch] ${text}`);
    if (!plan) return;
    plan.log.push({ at: this.now(), text });
    if (plan.log.length > MAX_LOG) plan.log.splice(0, plan.log.length - MAX_LOG);
  }

  private async save() {
    await this.persist(this.plan);
  }
}

export function endFromSnapshot(info: AgentInfo): TurnEnd {
  if (info.status === "error") return { kind: "failed", message: info.lastError ?? "에이전트 오류" };
  if (info.status === "closed") return { kind: "canceled", message: "에이전트가 닫혔습니다" };
  return { kind: "completed" };
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
