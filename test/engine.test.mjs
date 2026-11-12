import assert from "node:assert/strict";
import { test } from "node:test";
import { Engine } from "../server/engine.ts";

function harness(agents) {
  let now = 1_000_000;
  const calls = [];
  const texts = new Map();
  let usage = null;
  let saved = null;
  const gateway = {
    async agent(id) {
      const a = agents[id];
      return a ? { provider: "claude", lastError: null, pendingPermissions: 0, archived: false, ...a } : null;
    },
    async lastAssistantText(id) {
      return texts.get(id) ?? null;
    },
    async send(id, text) {
      calls.push(["send", id, text]);
      agents[id].status = "running";
    },
    async create(spec) {
      calls.push(["create", spec.cwd, spec.prompt]);
      const id = `new-${calls.length}`;
      agents[id] = { status: "running" };
      return id;
    },
    async usageUntil() {
      return usage;
    },
    async shutdown() {
      calls.push(["shutdown"]);
    },
    async abortShutdown() {
      calls.push(["abort"]);
    },
  };
  const engine = new Engine(async (plan) => (saved = plan), () => now);
  engine.attach(gateway);
  return {
    engine,
    calls,
    texts,
    setUsage: (v) => (usage = v),
    advance: (ms) => (now += ms),
    now: () => now,
    saved: () => saved,
    finishTurn(id, end = { kind: "completed" }) {
      agents[id].status = end.kind === "failed" ? "error" : "idle";
      return engine.onTurnEnd(id, "claude", end);
    },
  };
}

const opts = { shutdown: true, resumeMessage: "continue", permissionTimeoutMin: 30 };
const watch = (id, agentId) => ({ kind: "watch", id, agentId, label: agentId });
const state = (plan) => Object.fromEntries(plan.nodes.map((n) => [n.id, n.state]));

test("shuts down once every watched session completes", async () => {
  const h = harness({ a: { status: "running" }, b: { status: "running" } });
  const plan = await h.engine.start({ ...opts, nodes: [watch("w1", "a"), watch("w2", "b")] });
  assert.deepEqual(state(plan), { w1: "running", w2: "running" });
  await h.finishTurn("a");
  assert.equal(h.saved().status, "active");
  await h.finishTurn("b");
  assert.equal(h.saved().status, "shutting_down");
  assert.deepEqual(h.calls, [["shutdown"]]);
});

test("cross-session follow-ups wait for all their dependencies", async () => {
  const h = harness({ a: { status: "running" }, b: { status: "running" } });
  await h.engine.start({
    ...opts,
    nodes: [
      watch("w1", "a"),
      watch("w2", "b"),
      { kind: "send", id: "f1", after: ["w1"], target: { nodeId: "w1" }, text: "검토해", label: "f1" },
      { kind: "create", id: "f2", after: ["w1", "w2"], create: { cwd: "C:/x", provider: "claude", prompt: "통합" }, label: "f2" },
      { kind: "send", id: "f3", after: [], target: { nodeId: "f2" }, text: "마무리", label: "f3" },
    ],
  });
  await h.finishTurn("a");
  assert.deepEqual(h.calls, [["send", "a", "검토해"]]);
  await h.finishTurn("b");
  assert.deepEqual(h.calls.at(-1), ["create", "C:/x", "통합"]);
  const created = h.saved().nodes.find((n) => n.id === "f2").agentId;
  // f3 targets the created session, so it implicitly waits for f2.
  assert.equal(h.saved().nodes.find((n) => n.id === "f3").state, "pending");
  await h.finishTurn(created);
  assert.deepEqual(h.calls.at(-1), ["send", created, "마무리"]);
  await h.finishTurn("a");
  await h.finishTurn(created);
  assert.equal(h.saved().status, "shutting_down");
});

test("a failed session counts as finished and skips its dependents", async () => {
  const h = harness({ a: { status: "running" }, b: { status: "running" } });
  await h.engine.start({
    ...opts,
    nodes: [watch("w1", "a"), watch("w2", "b"), { kind: "send", id: "f1", after: ["w1"], target: { nodeId: "w1" }, text: "x", label: "f1" }],
  });
  await h.finishTurn("a", { kind: "failed", message: "Claude run failed" });
  await h.finishTurn("b");
  assert.deepEqual(state(h.saved()), { w1: "failed", w2: "done", f1: "skipped" });
  assert.equal(h.saved().status, "shutting_down");
});

test("a limit stop waits for the usage reset, resumes with continue, and repeats", async () => {
  const h = harness({ a: { status: "running" } });
  await h.engine.start({ ...opts, nodes: [watch("w1", "a")] });
  h.setUsage(h.now() + 3_600_000);
  h.texts.set("a", "You've hit your limit · resets 3pm (Asia/Seoul)");
  await h.finishTurn("a");
  let node = h.saved().nodes[0];
  assert.equal(node.state, "waiting_quota");
  assert.equal(node.quotaUntil, h.now() + 3_600_000 + 120_000);

  h.advance(3_600_000 + 120_000);
  h.setUsage(null);
  await h.engine.tick();
  assert.deepEqual(h.calls, [["send", "a", "continue"]]);
  assert.equal(h.saved().nodes[0].state, "running");

  // Limit again right after resuming: wait at least 15 minutes.
  h.advance(60_000);
  await h.finishTurn("a");
  node = h.saved().nodes[0];
  assert.equal(node.state, "waiting_quota");
  assert.equal(node.limitHits, 2);
  assert.ok(node.quotaUntil >= h.now() + 15 * 60_000);

  h.advance(node.quotaUntil - h.now());
  await h.engine.tick();
  assert.deepEqual(h.calls.at(-1), ["send", "a", "continue"]);
  h.texts.set("a", "끝났습니다.");
  h.advance(10 * 60_000);
  await h.finishTurn("a");
  assert.equal(h.saved().nodes[0].state, "done");
  assert.equal(h.saved().status, "shutting_down");
});

test("resume is postponed while usage is still exhausted", async () => {
  const h = harness({ a: { status: "running" } });
  await h.engine.start({ ...opts, nodes: [watch("w1", "a")] });
  h.texts.set("a", "You've hit your limit");
  await h.finishTurn("a");
  h.advance(30 * 60_000);
  h.setUsage(h.now() + 60 * 60_000);
  await h.engine.tick();
  assert.deepEqual(h.calls, []);
  assert.equal(h.saved().nodes[0].quotaUntil, h.now() + 62 * 60_000);
});

test("an idle session cut off by a limit before the plan started is resumed", async () => {
  const h = harness({ a: { status: "idle" } });
  h.texts.set("a", "You've hit your limit · resets 3pm");
  const plan = await h.engine.start({ ...opts, nodes: [watch("w1", "a")] });
  assert.equal(plan.nodes[0].state, "waiting_quota");
});

test("a missed hook is reconciled from the snapshot after the start grace", async () => {
  const agents = { a: { status: "running" } };
  const h = harness(agents);
  await h.engine.start({ ...opts, nodes: [watch("w1", "a")] });
  agents.a.status = "idle"; // turn ended, hook never arrived
  h.advance(30_000);
  await h.engine.tick();
  assert.equal(h.saved().nodes[0].state, "running");
  h.advance(60_000);
  await h.engine.tick();
  assert.equal(h.saved().nodes[0].state, "done");
});

test("a permission wait beyond the limit fails the node", async () => {
  const agents = { a: { status: "running", pendingPermissions: 1 } };
  const h = harness(agents);
  await h.engine.start({ ...opts, nodes: [watch("w1", "a")] });
  await h.engine.tick();
  h.advance(31 * 60_000);
  await h.engine.tick();
  assert.equal(h.saved().nodes[0].state, "failed");
  assert.equal(h.saved().status, "shutting_down");
});

test("cancel during the countdown aborts the shutdown", async () => {
  const h = harness({ a: { status: "idle" } });
  await h.engine.start({ ...opts, nodes: [watch("w1", "a")] });
  assert.equal(h.saved().status, "shutting_down");
  await h.engine.cancel();
  assert.equal(h.saved().status, "canceled");
  assert.deepEqual(h.calls, [["shutdown"], ["abort"]]);
});

test("without shutdown the plan just finishes", async () => {
  const h = harness({ a: { status: "idle" } });
  await h.engine.start({ ...opts, shutdown: false, nodes: [watch("w1", "a")] });
  assert.equal(h.saved().status, "finished");
  assert.deepEqual(h.calls, []);
});

test("a send to a busy agent waits for its current turn", async () => {
  const agents = { a: { status: "running" }, b: { status: "running" } };
  const h = harness(agents);
  await h.engine.start({
    ...opts,
    nodes: [watch("w1", "a"), { kind: "send", id: "f1", after: ["w1"], target: { agentId: "b" }, text: "hi", label: "f1" }],
  });
  await h.finishTurn("a");
  assert.deepEqual(h.calls, []);
  agents.b.status = "idle";
  await h.engine.tick();
  assert.deepEqual(h.calls, [["send", "b", "hi"]]);
});
