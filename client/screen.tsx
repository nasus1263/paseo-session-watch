import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  agentsRpc,
  cancelRpc,
  clearRpc,
  draftGetRpc,
  draftSetRpc,
  startRpc,
  stateRpc,
  type AgentRow,
  type DraftNode,
  type EditorDraft,
  type FollowUpDraft,
  type NodeState,
  type Plan,
} from "../shared/plan";

type Styles = ReturnType<typeof makeStyles>;

function makeStyles(theme: PluginTheme, compact: boolean) {
  const c = theme.colors;
  return {
    screen: { flex: 1, backgroundColor: c.surface0 },
    body: { padding: compact ? 12 : 24, gap: 16 },
    h2: { color: c.foreground, fontSize: 16, fontWeight: "600" as const },
    text: { color: c.foreground, fontSize: 13 },
    muted: { color: c.foregroundMuted, fontSize: 12 },
    danger: { color: c.statusDanger, fontSize: 12 },
    card: { borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 12, gap: 8, backgroundColor: c.surface1 },
    row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
    agentRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10, paddingVertical: 6 },
    check: (on: boolean) => ({
      width: 18,
      height: 18,
      borderRadius: 4,
      borderWidth: 1,
      borderColor: on ? c.accent : c.border,
      backgroundColor: on ? c.accent : "transparent",
    }),
    chip: (on: boolean) => ({
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: on ? c.accent : c.border,
      backgroundColor: on ? c.accent : "transparent",
    }),
    chipText: (on: boolean) => ({ color: on ? c.accentForeground : c.foreground, fontSize: 12 }),
    input: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 6,
      color: c.foreground,
      backgroundColor: c.surface0,
      fontSize: 13,
    },
    button: (kind: "primary" | "plain" | "danger", disabled = false) => ({
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 6,
      opacity: disabled ? 0.5 : 1,
      borderWidth: kind === "plain" ? 1 : 0,
      borderColor: c.border,
      backgroundColor: kind === "primary" ? c.accent : kind === "danger" ? c.statusDanger : "transparent",
    }),
    buttonText: (kind: "primary" | "plain" | "danger") => ({
      color: kind === "primary" ? c.accentForeground : kind === "danger" ? c.surface0 : c.foreground,
      fontSize: 13,
      fontWeight: "600" as const,
    }),
    badge: (state: NodeState | string) => ({
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 10,
      backgroundColor:
        state === "done" || state === "idle"
          ? c.statusSuccess
          : state === "failed" || state === "skipped" || state === "error"
            ? c.statusDanger
            : state === "waiting_quota" || state === "settling"
              ? c.statusWarning
              : c.surface2,
    }),
    badgeText: { color: c.foreground, fontSize: 11 },
  };
}

const STATE_LABEL: Record<NodeState, string> = {
  pending: "대기",
  running: "실행 중",
  settling: "종료 확인 중",
  waiting_quota: "한도 대기",
  done: "완료",
  failed: "실패",
  skipped: "건너뜀",
};

const PLAN_LABEL: Record<Plan["status"], string> = {
  active: "감시 중",
  shutting_down: "PC 종료 예정",
  finished: "끝남",
  canceled: "취소됨",
};

function time(ms: number) {
  return new Date(ms).toLocaleTimeString();
}

function remaining(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}시간 ${m}분` : m > 0 ? `${m}분 ${s % 60}초` : `${s}초`;
}

function Button(props: { s: Styles; kind?: "primary" | "plain" | "danger"; label: string; disabled?: boolean; onPress(): void }) {
  const kind = props.kind ?? "plain";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      style={props.s.button(kind, props.disabled)}
    >
      <Text style={props.s.buttonText(kind)}>{props.label}</Text>
    </Pressable>
  );
}

function Chip(props: { s: Styles; on: boolean; label: string; onPress(): void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={props.label} onPress={props.onPress} style={props.s.chip(props.on)}>
      <Text style={props.s.chipText(props.on)}>{props.label}</Text>
    </Pressable>
  );
}

export function WatchScreen({ theme, layout }: PluginScreenProps) {
  const s = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);
  const getState = useRpc(stateRpc);
  const state = useQuery({ queryKey: ["watch", "state"], queryFn: () => getState({}), refetchInterval: 3000 });
  const plan = state.data?.plan ?? null;
  const live = plan && (plan.status === "active" || plan.status === "shutting_down");

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.body}>
      {state.error ? <Text style={s.danger}>{String(state.error)}</Text> : null}
      {plan ? <PlanView s={s} plan={plan} now={state.data!.now} /> : null}
      {!live && state.data ? <Editor s={s} /> : null}
    </ScrollView>
  );
}

function PlanView({ s, plan, now }: { s: Styles; plan: Plan; now: number }) {
  const qc = useQueryClient();
  const cancel = useRpc(cancelRpc);
  const clear = useRpc(clearRpc);
  const refresh = () => qc.invalidateQueries({ queryKey: ["watch"] });
  const cancelM = useMutation({ mutationFn: () => cancel({}), onSettled: refresh });
  const clearM = useMutation({ mutationFn: () => clear({}), onSettled: refresh });
  const live = plan.status === "active" || plan.status === "shutting_down";

  return (
    <View style={{ gap: 12 }}>
      <View style={s.row}>
        <Text style={s.h2}>현재 계획: {PLAN_LABEL[plan.status]}</Text>
        <Text style={s.muted}>
          PC 종료 {plan.shutdown ? "켬" : "끔"} · 한도 대기 {plan.waitForQuota ? "켬" : "끔"}
          {plan.waitForQuota ? ` (모든 세션 ${plan.reviveAll ? "켬" : "끔"})` : ""} · 재개 메시지 “{plan.resumeMessage}” · 권한 대기 {plan.permissionTimeoutMin}분 · 조용한 시간 {plan.quietMin}분 · 백그라운드 최대 {plan.backgroundMaxMin}분
        </Text>
      </View>
      {plan.status === "shutting_down" && plan.shutdownAt ? (
        <View style={s.card}>
          <Text style={s.h2}>{remaining(plan.shutdownAt - now)} 후 PC가 종료됩니다</Text>
          <Button s={s} kind="danger" label="PC 종료 취소" disabled={cancelM.isPending} onPress={() => cancelM.mutate()} />
        </View>
      ) : null}
      <View style={s.card}>
        {plan.nodes.map((n) => (
          <View key={n.id} style={{ gap: 2, paddingVertical: 4 }}>
            <View style={s.row}>
              <View style={s.badge(n.state)}>
                <Text style={s.badgeText}>{STATE_LABEL[n.state]}</Text>
              </View>
              <Text style={s.text}>
                [{n.id}] {n.label}
              </Text>
              {n.after.length ? <Text style={s.muted}>← {n.after.join(", ")}</Text> : null}
              {n.after.length && !n.skipOnFailure ? <Text style={s.muted}>(선행 실패해도 실행)</Text> : null}
            </View>
            {n.state === "waiting_quota" && n.quotaUntil ? (
              <Text style={s.muted}>
                {time(n.quotaUntil)}에 재개 시도 ({remaining(n.quotaUntil - now)} 남음) · 한도 {n.limitHits}회
              </Text>
            ) : null}
            {n.note ? <Text style={n.state === "failed" ? s.danger : s.muted}>{n.note}</Text> : null}
          </View>
        ))}
      </View>
      <View style={s.row}>
        {live ? (
          <Button s={s} kind="danger" label="계획 취소" disabled={cancelM.isPending} onPress={() => cancelM.mutate()} />
        ) : (
          <Button s={s} label="계획 지우기" disabled={clearM.isPending} onPress={() => clearM.mutate()} />
        )}
      </View>
      {cancelM.error ? <Text style={s.danger}>{String(cancelM.error)}</Text> : null}
      <View style={s.card}>
        <Text style={s.h2}>로그</Text>
        {[...plan.log]
          .reverse()
          .slice(0, 40)
          .map((l, i) => (
            <Text key={i} style={s.muted}>
              {time(l.at)} {l.text}
            </Text>
          ))}
      </View>
    </View>
  );
}

type FollowUp = FollowUpDraft;

// Outside the ["watch"] prefix so plan refreshes never refetch it over local edits.
const DRAFT_KEY = ["watch-draft"];
const DRAFT_SAVE_DELAY_MS = 400;

/** Loads the saved form first, so the editor always starts from what was last shown. */
function Editor({ s }: { s: Styles }) {
  const getDraft = useRpc(draftGetRpc);
  const draft = useQuery({ queryKey: DRAFT_KEY, queryFn: () => getDraft({}), staleTime: Infinity });
  if (draft.error) return <Text style={s.danger}>{String(draft.error)}</Text>;
  if (!draft.data) return <Text style={s.muted}>불러오는 중…</Text>;
  return <EditorForm s={s} initial={draft.data.draft} />;
}

/** Mirrors the form into the query cache at once and to the daemon shortly after; flushes on unmount. */
function useDraftPersistence(draft: EditorDraft) {
  const qc = useQueryClient();
  const setDraft = useRpc(draftSetRpc);
  const pending = useRef<EditorDraft | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useRef(() => {});
  flush.current = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (next) void setDraft({ draft: next }).catch((error) => console.error("초안 저장 실패", error));
  };
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    qc.setQueryData(DRAFT_KEY, { draft });
    pending.current = draft;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => flush.current(), DRAFT_SAVE_DELAY_MS);
  }, [draft, qc]);
  useEffect(() => () => flush.current(), []);
}

function EditorForm({ s, initial }: { s: Styles; initial: EditorDraft }) {
  const qc = useQueryClient();
  const listAgents = useRpc(agentsRpc);
  const start = useRpc(startRpc);
  const agents = useQuery({ queryKey: ["watch", "agents"], queryFn: () => listAgents({}), refetchInterval: 5000 });
  const [selected, setSelected] = useState<string[]>(initial.selected);
  const [followUps, setFollowUps] = useState<FollowUp[]>(initial.followUps);
  const [shutdown, setShutdown] = useState(initial.shutdown);
  const [waitForQuota, setWaitForQuota] = useState(initial.waitForQuota);
  const [reviveAll, setReviveAll] = useState(initial.reviveAll);
  const [resumeMessage, setResumeMessage] = useState(initial.resumeMessage);
  const [permissionMin, setPermissionMin] = useState(initial.permissionMin);
  const [quietMin, setQuietMin] = useState(initial.quietMin);
  const [backgroundMaxMin, setBackgroundMaxMin] = useState(initial.backgroundMaxMin);
  const [seq, setSeq] = useState(initial.seq);
  const current = useMemo(
    () => ({ selected, followUps, shutdown, waitForQuota, reviveAll, resumeMessage, permissionMin, quietMin, backgroundMaxMin, seq }),
    [selected, followUps, shutdown, waitForQuota, reviveAll, resumeMessage, permissionMin, quietMin, backgroundMaxMin, seq],
  );
  useDraftPersistence(current);

  const rows = agents.data?.agents ?? [];
  const byId = new Map(rows.map((a) => [a.id, a]));
  // Only running sessions are offered; a selected one stays visible after it stops so it can be unchecked.
  const visible = rows.filter((a) => a.status === "running" || selected.includes(a.id));
  const watchId = (agentId: string) => `w${selected.indexOf(agentId) + 1}`;
  const nodeLabel = (id: string) => {
    if (id.startsWith("w")) {
      const a = byId.get(selected[Number(id.slice(1)) - 1]);
      return `${id} ${a?.title ?? ""}`;
    }
    const f = followUps.find((x) => x.id === id);
    return f ? `${id} ${f.kind === "send" ? "메시지" : "새 세션"}` : id;
  };

  const toggleAgent = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const addFollowUp = (kind: FollowUp["kind"]) => {
    const first = byId.get(selected[0] ?? "");
    const id = `f${seq}`;
    setSeq(seq + 1);
    setFollowUps((cur) => [
      ...cur,
      {
        id,
        kind,
        after: [],
        target: selected.length ? "w1" : "",
        text: "",
        cwd: first?.cwd ?? "",
        provider: first ? `${first.provider}${first.model ? `/${first.model}` : ""}` : "claude",
        modeId: first?.modeId ?? "",
        title: "",
        skipOnFailure: true,
      },
    ]);
  };
  const update = (id: string, patch: Partial<FollowUp>) =>
    setFollowUps((cur) => cur.map((f) => (f.id === id ? { ...f, ...patch } : f)));

  const watchIds = selected.map((_, i) => `w${i + 1}`);
  const draft = (): DraftNode[] => {
    const nodes: DraftNode[] = selected.map((agentId) => ({
      kind: "watch",
      id: watchId(agentId),
      agentId,
      label: byId.get(agentId)?.title ?? agentId,
    }));
    for (const f of followUps) {
      if (f.kind === "send") {
        nodes.push({
          kind: "send",
          id: f.id,
          after: f.after,
          target: { nodeId: f.target },
          text: f.text,
          label: `메시지 → ${nodeLabel(f.target)}`,
          skipOnFailure: f.skipOnFailure,
        });
      } else {
        nodes.push({
          kind: "create",
          id: f.id,
          after: f.after,
          create: {
            cwd: f.cwd,
            provider: f.provider,
            ...(f.modeId ? { modeId: f.modeId } : {}),
            ...(f.title ? { title: f.title } : {}),
            prompt: f.text,
          },
          label: `새 세션: ${f.title || f.cwd}`,
          skipOnFailure: f.skipOnFailure,
        });
      }
    }
    return nodes;
  };

  const problems = followUps.flatMap((f) => {
    const out: string[] = [];
    if (!f.text.trim()) out.push(`${f.id}: 내용을 입력하세요`);
    if (f.kind === "send" && !f.target) out.push(`${f.id}: 대상을 고르세요`);
    if (f.kind === "create" && (!f.cwd.trim() || !f.provider.trim())) out.push(`${f.id}: 경로와 프로바이더를 입력하세요`);
    return out;
  });
  const minutes = Number(permissionMin);
  if (!(minutes >= 1)) problems.push("권한 대기 제한은 1분 이상이어야 합니다");
  const quiet = Number(quietMin);
  if (!(quiet >= 0) || quietMin.trim() === "") problems.push("조용한 시간은 0분 이상이어야 합니다");
  const backgroundMax = Number(backgroundMaxMin);
  if (!(backgroundMax >= 1)) problems.push("백그라운드 작업 최대 대기는 1분 이상이어야 합니다");
  if (!resumeMessage.trim()) problems.push("재개 메시지를 입력하세요");
  const empty = selected.length === 0 && followUps.length === 0;

  const startM = useMutation({
    mutationFn: () =>
      start({ nodes: draft(), shutdown, waitForQuota, reviveAll: waitForQuota && reviveAll, resumeMessage: resumeMessage.trim(), permissionTimeoutMin: minutes,
        quietMin: quiet,
        backgroundMaxMin: backgroundMax,
      }),
    onSuccess: () => {
      setSelected([]);
      setFollowUps([]);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["watch"] }),
  });

  return (
    <View style={{ gap: 16 }}>
      <View style={s.card}>
        <View style={s.row}>
          <Text style={s.h2}>1. 감시할 세션 (실행 중)</Text>
          <Button s={s} label="새로고침" disabled={agents.isFetching} onPress={() => void agents.refetch()} />
        </View>
        {agents.isLoading ? <Text style={s.muted}>불러오는 중…</Text> : null}
        {agents.error ? <Text style={s.danger}>{String(agents.error)}</Text> : null}
        {agents.data && visible.length === 0 ? <Text style={s.muted}>실행 중인 세션이 없습니다</Text> : null}
        {visible.map((a: AgentRow) => {
          const on = selected.includes(a.id);
          return (
            <Pressable
              key={a.id}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              accessibilityLabel={a.title}
              onPress={() => toggleAgent(a.id)}
              style={s.agentRow}
            >
              <View style={s.check(on)} />
              <View style={s.badge(a.status)}>
                <Text style={s.badgeText}>{a.status}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.text} numberOfLines={1}>
                  {on ? `[${watchId(a.id)}] ` : ""}
                  {a.title}
                </Text>
                <Text style={s.muted} numberOfLines={1}>
                  {a.provider}
                  {a.model ? `/${a.model}` : ""} · {a.cwd}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>

      <View style={s.card}>
        <Text style={s.h2}>2. 후속 작업</Text>
        <Text style={s.muted}>
          선행 작업이 모두 끝나면 실행합니다. 선행 작업이 실패했을 때 건너뛸지는 작업마다 정합니다. 토큰 한도로 멈춘 작업은
          실패가 아니라 대기이므로, 재개되어 끝날 때까지 기다립니다.
        </Text>
        {followUps.map((f, index) => {
          const earlier = [...watchIds, ...followUps.slice(0, index).map((x) => x.id)];
          const targets = [...watchIds, ...followUps.slice(0, index).filter((x) => x.kind === "create").map((x) => x.id)];
          return (
            <View key={f.id} style={[s.card, { backgroundColor: "transparent" }]}>
              <View style={s.row}>
                <Text style={s.h2}>
                  [{f.id}] {f.kind === "send" ? "기존 세션에 메시지" : "새 세션"}
                </Text>
                <Button s={s} label="삭제" onPress={() => setFollowUps((cur) => cur.filter((x) => x.id !== f.id))} />
              </View>
              <Text style={s.muted}>선행</Text>
              <View style={s.row}>
                {earlier.length === 0 ? <Text style={s.muted}>없음(즉시 실행)</Text> : null}
                {earlier.map((id) => (
                  <Chip
                    key={id}
                    s={s}
                    on={f.after.includes(id)}
                    label={nodeLabel(id)}
                    onPress={() =>
                      update(f.id, { after: f.after.includes(id) ? f.after.filter((x) => x !== id) : [...f.after, id] })
                    }
                  />
                ))}
              </View>
              {f.kind === "send" ? (
                <>
                  <Text style={s.muted}>대상 세션</Text>
                  <View style={s.row}>
                    {targets.map((id) => (
                      <Chip key={id} s={s} on={f.target === id} label={nodeLabel(id)} onPress={() => update(f.id, { target: id })} />
                    ))}
                  </View>
                </>
              ) : (
                <>
                  <TextInput style={s.input} value={f.cwd} onChangeText={(v) => update(f.id, { cwd: v })} placeholder="작업 경로 (cwd)" />
                  <TextInput
                    style={s.input}
                    value={f.provider}
                    onChangeText={(v) => update(f.id, { provider: v })}
                    placeholder="provider/model 예: claude/claude-opus-5-5"
                  />
                  <TextInput style={s.input} value={f.modeId} onChangeText={(v) => update(f.id, { modeId: v })} placeholder="모드 (선택)" />
                  <TextInput style={s.input} value={f.title} onChangeText={(v) => update(f.id, { title: v })} placeholder="제목 (선택)" />
                </>
              )}
              <TextInput
                style={[s.input, { minHeight: 60 }]}
                multiline
                value={f.text}
                onChangeText={(v) => update(f.id, { text: v })}
                placeholder={f.kind === "send" ? "보낼 메시지" : "첫 프롬프트"}
              />
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: f.skipOnFailure }}
                accessibilityLabel="선행 작업이 실패하면 건너뛰기"
                onPress={() => update(f.id, { skipOnFailure: !f.skipOnFailure })}
                style={s.agentRow}
              >
                <View style={s.check(f.skipOnFailure)} />
                <Text style={s.text}>선행 작업이 실패하면 건너뛰기</Text>
              </Pressable>
            </View>
          );
        })}
        <View style={s.row}>
          <Button s={s} label="+ 기존 세션에 메시지" onPress={() => addFollowUp("send")} />
          <Button s={s} label="+ 새 세션" onPress={() => addFollowUp("create")} />
        </View>
      </View>

      <View style={s.card}>
        <Text style={s.h2}>3. 옵션</Text>
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: shutdown }}
          accessibilityLabel="모든 작업이 끝나면 PC 종료"
          onPress={() => setShutdown(!shutdown)}
          style={s.agentRow}
        >
          <View style={s.check(shutdown)} />
          <Text style={s.text}>모든 작업이 끝나면 PC 종료 (60초 유예, 취소 가능)</Text>
        </Pressable>
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: waitForQuota }}
          accessibilityLabel="토큰 한도 도달 시 초기화까지 대기"
          onPress={() => setWaitForQuota(!waitForQuota)}
          style={s.agentRow}
        >
          <View style={s.check(waitForQuota)} />
          <Text style={s.text}>토큰 한도에 도달하면 초기화까지 기다림 (끄면 그 작업은 실패 처리)</Text>
        </Pressable>
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: waitForQuota && reviveAll, disabled: !waitForQuota }}
          accessibilityLabel="감시 대상이 아닌 세션도 한도로 멈추면 재개"
          disabled={!waitForQuota}
          onPress={() => setReviveAll(!reviveAll)}
          style={[s.agentRow, { marginLeft: 28, opacity: waitForQuota ? 1 : 0.5 }]}
        >
          <View style={s.check(waitForQuota && reviveAll)} />
          <Text style={[s.text, { flex: 1 }]}>
            감시 대상이 아닌 세션도 포함: 어떤 세션이든 한도로 멈추면 계획에 추가해 초기화 후 재개하고, 세션이 스스로 끝낼
            때까지 완료로 보지 않음
          </Text>
        </Pressable>
        <Text style={s.muted}>한도 초기화 후 보낼 재개 메시지</Text>
        <TextInput style={s.input} value={resumeMessage} onChangeText={setResumeMessage} />
        <Text style={s.muted}>권한 요청 대기 제한(분). 넘으면 그 작업은 실패로 처리</Text>
        <TextInput style={s.input} value={permissionMin} onChangeText={setPermissionMin} keyboardType="number-pad" />
        <Text style={s.muted}>
          조용한 시간(분). 턴이 끝난 뒤 이 시간 동안 새 턴, 활동, 백그라운드 작업, 실행 중인 하위 에이전트가 없어야 완료로 봅니다
        </Text>
        <TextInput style={s.input} value={quietMin} onChangeText={setQuietMin} keyboardType="number-pad" />
        <Text style={s.muted}>백그라운드 작업 최대 대기(분). 넘으면 남은 백그라운드 작업을 무시합니다</Text>
        <TextInput style={s.input} value={backgroundMaxMin} onChangeText={setBackgroundMaxMin} keyboardType="number-pad" />
      </View>

      {problems.map((p) => (
        <Text key={p} style={s.danger}>
          {p}
        </Text>
      ))}
      {startM.error ? <Text style={s.danger}>{String(startM.error)}</Text> : null}
      <Button
        s={s}
        kind="primary"
        label="감시 시작"
        disabled={empty || problems.length > 0 || startM.isPending}
        onPress={() => startM.mutate()}
      />
    </View>
  );
}
