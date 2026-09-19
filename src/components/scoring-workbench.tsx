"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { MatchCommand, MatchState, Side } from "@/domain/rules/match-engine";

type SessionControl = {
  sessionId: string;
  controlToken: string;
  takeoverGeneration: number;
  expiresAt: string;
};

type MatchView = {
  code: string;
  competitionName: string;
  courtName: string | null;
  scheduledAt: string | null;
  sideAName: string;
  sideBName: string;
  playerNames: Record<string, string>;
  lifecycleStatus: string;
  verificationStatus: string;
};

type SnapshotResponse = {
  status: "snapshot" | "unchanged";
  serverTime: string;
  version: number;
  access: { assignedReferee: boolean; chiefReferee: boolean };
  control: { active: boolean; sessionId?: string; ownedByCurrentUser?: boolean; actingRole?: string; expiresAt?: string };
  match?: MatchView;
  state?: MatchState;
  events?: Array<{ commandId: string; version: number; type: string; occurredAt: string }>;
};

type Envelope = {
  commandId: string;
  occurredAt: string;
  expectedVersion: number;
  scoringSessionId: string;
  takeoverGeneration: number;
  type: MatchCommand["type"];
  payload: MatchCommand["payload"];
};

function deviceId(matchCode: string) {
  const key = `badminton-device:${matchCode}`;
  let value = sessionStorage.getItem(key);
  if (!value) {
    value = crypto.randomUUID();
    sessionStorage.setItem(key, value);
  }
  return value;
}

async function responseJson(response: Response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? "服务器请求失败。");
  return body;
}

export function ScoringWorkbench({ matchCode }: { matchCode: string }) {
  const [snapshot, setSnapshot] = useState<SnapshotResponse | null>(null);
  const storageKey = `badminton-control:${matchCode}`;
  const pendingKey = `badminton-pending:${matchCode}`;
  const [control, setControl] = useState<SessionControl | null>(() => {
    if (typeof window === "undefined") return null;
    const saved = sessionStorage.getItem(storageKey);
    return saved ? JSON.parse(saved) as SessionControl : null;
  });
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const [syncState, setSyncState] = useState<"SYNCED" | "SUBMITTING" | "UNKNOWN" | "READ_ONLY">("READ_ONLY");
  const [message, setMessage] = useState("");
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [scoreA, setScoreA] = useState(0);
  const [scoreB, setScoreB] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const state = snapshot?.state;
  const match = snapshot?.match;

  const refresh = useCallback(async (force = false) => {
    const after = !force && snapshot?.version !== undefined ? `?afterVersion=${snapshot.version}` : "";
    try {
      const next = await responseJson(await fetch(`/api/matches/${encodeURIComponent(matchCode)}/state${after}`, { cache: "no-store" })) as SnapshotResponse;
      setSnapshot((current) => next.status === "unchanged" ? { ...current!, ...next } : next);
      setOnline(true);
      if (control) setSyncState("SYNCED");
    } catch (error) {
      setOnline(false);
      setSyncState("READ_ONLY");
      setMessage(error instanceof Error ? error.message : "无法同步权威状态。");
    }
  }, [control, matchCode, snapshot]);

  useEffect(() => {
    queueMicrotask(() => void refresh(true));
    const onOnline = () => { setOnline(true); void refresh(true); };
    const onOffline = () => { setOnline(false); setSyncState("READ_ONLY"); };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [matchCode]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const interval = window.setInterval(() => void refresh(), document.hidden ? 10_000 : 2_000);
    const visible = () => { if (!document.hidden) void refresh(true); };
    document.addEventListener("visibilitychange", visible);
    return () => { window.clearInterval(interval); document.removeEventListener("visibilitychange", visible); };
  }, [refresh]);

  useEffect(() => {
    if (!control) return;
    const heartbeat = window.setInterval(async () => {
      try {
        const body = await responseJson(await fetch(`/api/matches/${encodeURIComponent(matchCode)}/control/heartbeat`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${control.controlToken}` },
          body: JSON.stringify({ scoringSessionId: control.sessionId, takeoverGeneration: control.takeoverGeneration }),
        }));
        const renewed = { ...control, expiresAt: body.expiresAt };
        setControl(renewed);
        sessionStorage.setItem(storageKey, JSON.stringify(renewed));
      } catch (error) {
        setControl(null);
        sessionStorage.removeItem(storageKey);
        setSyncState("READ_ONLY");
        setMessage(error instanceof Error ? error.message : "心跳失败，已切换只读。");
      }
    }, 30_000);
    return () => window.clearInterval(heartbeat);
  }, [control, matchCode, storageKey]);

  useEffect(() => {
    const raw = localStorage.getItem(pendingKey);
    if (!raw) return;
    const envelope = JSON.parse(raw) as Envelope;
    queueMicrotask(() => setSyncState("UNKNOWN"));
    void fetch(`/api/matches/${encodeURIComponent(matchCode)}/commands/${envelope.commandId}`, { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 404) return;
        const body = await responseJson(response);
        localStorage.removeItem(pendingKey);
        setSnapshot((current) => current ? { ...current, version: body.version, state: body.state } : current);
        setSyncState("SYNCED");
      })
      .catch(() => setSyncState("UNKNOWN"));
  }, [matchCode, pendingKey]);

  async function acquire(takeover = false) {
    setMessage("");
    try {
      const path = takeover ? "control/takeover" : "control";
      const body = takeover
        ? { deviceSessionId: deviceId(matchCode), reason: window.prompt("请填写强制接管原因") ?? "" }
        : { deviceSessionId: deviceId(matchCode) };
      if (takeover && !body.reason) return;
      const result = await responseJson(await fetch(`/api/matches/${encodeURIComponent(matchCode)}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })) as SessionControl;
      setControl(result);
      sessionStorage.setItem(storageKey, JSON.stringify(result));
      setSyncState("SYNCED");
      await refresh(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法取得控制权。");
    }
  }

  function makeEnvelope(type: MatchCommand["type"], payload: MatchCommand["payload"]): Envelope {
    if (!control || !state) throw new Error("当前没有有效控制会话。");
    return {
      commandId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      expectedVersion: state.version,
      scoringSessionId: control.sessionId,
      takeoverGeneration: control.takeoverGeneration,
      type,
      payload,
    };
  }

  async function submitEnvelope(envelope: Envelope) {
    if (!control || !online || syncState === "SUBMITTING") return;
    setSyncState("SUBMITTING");
    setMessage("");
    localStorage.setItem(pendingKey, JSON.stringify(envelope));
    const abort = new AbortController();
    const timeout = window.setTimeout(() => abort.abort(), 5_000);
    try {
      const body = await responseJson(await fetch(`/api/matches/${encodeURIComponent(matchCode)}/commands`, {
        method: "POST",
        signal: abort.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${control.controlToken}` },
        body: JSON.stringify(envelope),
      }));
      localStorage.removeItem(pendingKey);
      setSnapshot((current) => current ? { ...current, version: body.version, state: body.state, events: [...(current.events ?? []), ...body.events] } : current);
      setSyncState("SYNCED");
    } catch (error) {
      setSyncState(error instanceof DOMException && error.name === "AbortError" ? "UNKNOWN" : "READ_ONLY");
      setMessage(error instanceof Error ? error.message : "命令结果未知，恢复后将用原 ID 对账。");
      await refresh(true);
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function send(type: MatchCommand["type"], payload: MatchCommand["payload"]) {
    await submitEnvelope(makeEnvelope(type, payload));
  }

  async function previewAndSend(type: MatchCommand["type"], payload: MatchCommand["payload"]) {
    if (!control) return;
    const envelope = makeEnvelope(type, payload);
    try {
      const preview = await responseJson(await fetch(`/api/matches/${encodeURIComponent(matchCode)}/commands/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${control.controlToken}` },
        body: JSON.stringify(envelope),
      }));
      const before = preview.before.score;
      const after = preview.after.score;
      if (window.confirm(`确认更正？\n比分 ${before.A}:${before.B} → ${after.A}:${after.B}\n原因：${reason}`)) {
        await submitEnvelope(envelope);
        setCorrectionOpen(false);
        setReason("");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法生成更正预览。");
    }
  }

  const canWrite = Boolean(control && online && syncState === "SYNCED");
  const sideOrder: Side[] = flipped ? ["B", "A"] : ["A", "B"];
  const sideName = (side: Side) => side === "A" ? match?.sideAName : match?.sideBName;
  const playerName = (id: string | null) => id ? match?.playerNames[id] ?? id : "待确认";
  const defaultCourts = useMemo(() => state?.format === "DOUBLES" ? {
    A: { R: state.players.A[0], L: state.players.A[1] },
    B: { R: state.players.B[0], L: state.players.B[1] },
  } : null, [state]);

  if (!snapshot || !state || !match) return <p className="empty-state">正在读取权威比赛状态…</p>;

  return (
    <section className="scoring-shell">
      <header className="scoring-statusbar">
        <div><span className="eyebrow">{match.competitionName} · {match.courtName ?? "场地待定"}</span><h1>{match.code}</h1></div>
        <div className="sync-cluster" aria-live="polite">
          <span className={`sync-dot ${online ? "online" : "offline"}`} />
          <strong>{online ? syncState : "OFFLINE_READ_ONLY"}</strong>
          <small>服务器版本 {state.version}</small>
        </div>
      </header>

      {message ? <p className="scoring-alert" role="alert">{message}</p> : null}
      <div className="control-strip">
        {!control && snapshot.access.assignedReferee ? <button className="button" onClick={() => void acquire()}>取得本机控制权</button> : null}
        {snapshot.access.chiefReferee ? <button className="button secondary" onClick={() => void acquire(true)}>裁判长接管</button> : null}
        <button className="button secondary" onClick={() => { setFlipped((value) => !value); void refresh(true); }}>翻转本机视角</button>
        <span>{canWrite ? "本机可写" : "当前只读"}</span>
      </div>

      <div className="games-ribbon">
        <strong>第 {state.currentGame} 局</strong>
        {state.completedGames.map((game) => <span key={game.number}>第{game.number}局 {game.scoreA}:{game.scoreB}</span>)}
      </div>
      {state.pendingObligations.some((item) => item.type === "INTERVAL") ? (
        <IntervalClock
          seconds={state.phase === "GAME_COMPLETE" ? state.ruleConfig.betweenGamesSeconds : state.ruleConfig.intervalSeconds}
          serverTime={snapshot.serverTime}
          startedAt={snapshot.events?.at(-1)?.occurredAt ?? snapshot.serverTime}
        />
      ) : null}

      <div className="score-stage">
        {sideOrder.map((side) => (
          <article className={`score-side side-${side.toLowerCase()}`} key={side}>
            <span className="side-label">{side} 方</span>
            <h2>{sideName(side)}</h2>
            <strong className="score-number">{state.score[side]}</strong>
            <button
              className="score-button"
              disabled={!canWrite || state.phase !== "IN_PROGRESS"}
              onClick={() => void send("RALLY_WON", { side })}
            >
              {sideName(side)} +1
            </button>
          </article>
        ))}
      </div>

      <div className="service-panel">
        <div><span>当前阶段</span><strong>{state.phase}</strong></div>
        <div><span>发球</span><strong>{playerName(state.serverPlayerId)} · {state.serverCourt ?? "—"}</strong></div>
        <div><span>接发</span><strong>{playerName(state.receiverPlayerId)} · {state.receiverCourt ?? "—"}</strong></div>
        <div><span>物理端</span><strong>{state.physicalEnds ? `A ${state.physicalEnds.A} / B ${state.physicalEnds.B}` : "待确认"}</strong></div>
      </div>
      <div className="court-map" aria-label="发接发与场地位置示意">
        {sideOrder.map((side) => <div className={`court-half side-${side.toLowerCase()}`} key={side}>
          <strong>{sideName(side)} · {state.physicalEnds?.[side] ?? "端位待定"}</strong>
          {state.logicalCourts ? <p>R {playerName(state.logicalCourts[side].R)}<br />L {playerName(state.logicalCourts[side].L)}</p> : <p>{playerName(state.players[side][0])}</p>}
        </div>)}
      </div>

      <PhaseActions
        canWrite={canWrite}
        chief={snapshot.access.chiefReferee}
        state={state}
        defaultCourts={defaultCourts}
        onSend={send}
        onCorrection={() => { setScoreA(state.score.A); setScoreB(state.score.B); setCorrectionOpen(true); }}
      />

      <section className="history-panel">
        <h2>最近操作</h2>
        <ol>{(snapshot.events ?? []).slice().reverse().map((event) => <li key={event.commandId}><strong>v{event.version}</strong> {event.type}<time>{new Date(event.occurredAt).toLocaleTimeString("zh-CN")}</time></li>)}</ol>
      </section>

      {correctionOpen ? (
        <div className="correction-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCorrectionOpen(false); }}>
          <section aria-labelledby="correction-title" aria-modal="true" className="correction-sheet" role="dialog">
            <header><div><span className="eyebrow">服务器预览</span><h2 id="correction-title">撤销与更正</h2></div><button className="sheet-close" onClick={() => setCorrectionOpen(false)} aria-label="关闭">×</button></header>
            <label>必填原因<textarea value={reason} onChange={(event) => setReason(event.target.value)} /></label>
            <div className="correction-score"><label>A 方比分<input min="0" type="number" value={scoreA} onChange={(event) => setScoreA(Number(event.target.value))} /></label><label>B 方比分<input min="0" type="number" value={scoreB} onChange={(event) => setScoreB(Number(event.target.value))} /></label></div>
            <div className="sheet-actions">
              <button className="button secondary" disabled={!reason.trim()} onClick={() => void previewAndSend("UNDO_LAST_REVERSIBLE", { reason })}>预览撤销最近得分</button>
              {state.physicalEnds && !state.pendingObligations.some((item) => item.type === "CHANGE_ENDS") ? (
                <button className="button secondary" disabled={!reason.trim()} onClick={() => void previewAndSend("CORRECT_PHYSICAL_ENDS", {
                  reason,
                  physicalEnds: { A: state.physicalEnds!.B, B: state.physicalEnds!.A },
                })}>预览物理场地端更正</button>
              ) : null}
              {state.logicalCourts ? (
                <>
                  <button className="button secondary" disabled={!reason.trim()} onClick={() => void previewAndSend("CORRECT_LOGICAL_COURTS", {
                    reason,
                    logicalCourts: { ...state.logicalCourts!, A: { R: state.logicalCourts!.A.L, L: state.logicalCourts!.A.R } },
                  })}>A 方左右调整预览</button>
                  <button className="button secondary" disabled={!reason.trim()} onClick={() => void previewAndSend("CORRECT_LOGICAL_COURTS", {
                    reason,
                    logicalCourts: { ...state.logicalCourts!, B: { R: state.logicalCourts!.B.L, L: state.logicalCourts!.B.R } },
                  })}>B 方左右调整预览</button>
                </>
              ) : null}
              {state.servingSide ? (
                <button className="button secondary" disabled={!reason.trim()} onClick={() => {
                  const servingSide = state.servingSide === "A" ? "B" : "A";
                  const receivingSide = servingSide === "A" ? "B" : "A";
                  const court = state.score[servingSide] % 2 === 0 ? "R" : "L";
                  void previewAndSend("CORRECT_SERVICE_ORDER", {
                    reason,
                    servingSide,
                    serverPlayerId: state.format === "DOUBLES" ? state.logicalCourts![servingSide][court] : state.players[servingSide][0],
                    receiverPlayerId: state.format === "DOUBLES" ? state.logicalCourts![receivingSide][court] : state.players[receivingSide][0],
                  });
                }}>切换发球方预览</button>
              ) : null}
              <button className="button" disabled={!reason.trim()} onClick={() => {
                const servingSide = state.servingSide!;
                const receivingSide = servingSide === "A" ? "B" : "A";
                const court = (servingSide === "A" ? scoreA : scoreB) % 2 === 0 ? "R" : "L";
                void previewAndSend("CORRECT_SCORE_STATE", { reason, replacement: {
                  score: { A: scoreA, B: scoreB }, gamesWon: state.gamesWon, completedGames: state.completedGames,
                  servingSide,
                  serverPlayerId: state.format === "DOUBLES" ? state.logicalCourts![servingSide][court] : state.players[servingSide][0],
                  receiverPlayerId: state.format === "DOUBLES" ? state.logicalCourts![receivingSide][court] : state.players[receivingSide][0],
                  logicalCourts: state.logicalCourts, pendingObligations: [], phase: "IN_PROGRESS",
                } });
              }}>预览完整比分更正</button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function PhaseActions({ canWrite, chief, state, defaultCourts, onSend, onCorrection }: {
  canWrite: boolean;
  chief: boolean;
  state: MatchState;
  defaultCourts: MatchState["logicalCourts"];
  onSend: (type: MatchCommand["type"], payload: MatchCommand["payload"]) => Promise<void>;
  onCorrection: () => void;
}) {
  const reason = (label: string) => window.prompt(label)?.trim() ?? "";
  const setupPayload = {
    serverPlayerId: state.players[state.servingSide ?? state.nextGameServingSide ?? "A"][0],
    receiverPlayerId: state.players[(state.servingSide ?? state.nextGameServingSide) === "B" ? "A" : "B"][0],
    logicalCourts: defaultCourts,
  };
  return (
    <section className="phase-actions" aria-label="当前阶段操作">
      {state.phase === "AWAITING_COIN_TOSS" ? <>
        {(["A", "B"] as const).flatMap((side) => [
          <button className="button" disabled={!canWrite} key={`${side}-serve`} onClick={() => void onSend("RECORD_COIN_TOSS", { valid: true, winnerSide: side, winnerChoice: { kind: "SERVICE", decision: "SERVE" }, loserChoice: { kind: "END", end: "END_2" } })}>{side} 方胜并选先发</button>,
          <button className="button secondary" disabled={!canWrite} key={`${side}-receive`} onClick={() => void onSend("RECORD_COIN_TOSS", { valid: true, winnerSide: side, winnerChoice: { kind: "SERVICE", decision: "RECEIVE" }, loserChoice: { kind: "END", end: "END_2" } })}>{side} 方胜并选先接</button>,
          <button className="button secondary" disabled={!canWrite} key={`${side}-end`} onClick={() => void onSend("RECORD_COIN_TOSS", { valid: true, winnerSide: side, winnerChoice: { kind: "END", end: "END_1" }, loserChoice: { kind: "SERVICE", decision: "SERVE" } })}>{side} 方胜并选场地端</button>,
        ])}
      </> : null}
      {state.phase === "AWAITING_OPENING_SETUP" ? <>
        <button className="button" disabled={!canWrite} onClick={() => void onSend("CONFIRM_OPENING_SETUP", setupPayload)}>确认首局发接发并开赛</button>
        {chief ? <button className="button danger" disabled={!canWrite} onClick={() => { const value = reason("作废抛币原因"); if (value) void onSend("INVALIDATE_COIN_TOSS", { reason: value }); }}>裁判长作废抛币</button> : null}
      </> : null}
      {state.pendingObligations.map((item) => item.type === "INTERVAL" ?
        <button className="button" disabled={!canWrite} key={item.id} onClick={() => void onSend("ACKNOWLEDGE_INTERVAL", { obligationId: item.id })}>确认间歇完成</button> :
        item.type === "CHANGE_ENDS" ? <span className="inline-actions" key={item.id}><button className="button" disabled={!canWrite} onClick={() => void onSend("CONFIRM_CHANGE_ENDS", { obligationId: item.id })}>确认已换边</button><button className="button secondary" disabled={!canWrite} onClick={() => { const value = reason("漏换边说明"); if (value) void onSend("RECORD_MISSED_CHANGE_ENDS", { obligationId: item.id, reason: value }); }}>记录漏换后补做</button></span> : null)}
      {state.phase === "AWAITING_NEXT_GAME_SETUP" ? <button className="button" disabled={!canWrite} onClick={() => void onSend("CONFIRM_NEXT_GAME_SETUP", setupPayload)}>确认下一局发接发</button> : null}
      {state.phase === "IN_PROGRESS" || state.phase === "OBLIGATIONS_PENDING" ? <>
        <button className="button secondary" disabled={!canWrite} onClick={onCorrection}>撤销 / 更正</button>
        <button className="button secondary" disabled={!canWrite} onClick={() => { const value = reason("LET 原因"); if (value) void onSend("LET", { reason: value }); }}>LET 重发球</button>
        <button className="button secondary" disabled={!canWrite} onClick={() => { const value = reason("暂停原因"); if (value) void onSend("PAUSE_MATCH", { reason: value }); }}>暂停比赛</button>
        <button className="button danger" disabled={!canWrite} onClick={() => {
          const type = (window.prompt("输入特殊结果：WO / RET / DSQ / ABANDONED / BYE") ?? "").trim().toUpperCase();
          if (!["WO", "RET", "DSQ", "ABANDONED", "BYE"].includes(type)) return;
          const winner = (window.prompt("胜方 A / B；无胜方留空") ?? "").trim().toUpperCase();
          const value = reason("特殊结果原因");
          if (value && window.confirm(`确认记录 ${type}？`)) void onSend("RECORD_SPECIAL_OUTCOME", { type: type as "WO" | "RET" | "DSQ" | "ABANDONED" | "BYE", ...(winner === "A" || winner === "B" ? { winnerSide: winner } : {}), reason: value });
        }}>记录特殊结果</button>
      </> : null}
      {state.phase === "PAUSED" ? <button className="button" disabled={!canWrite} onClick={() => { const value = reason("恢复比赛原因"); if (value) void onSend("RESUME_MATCH", { reason: value }); }}>恢复比赛</button> : null}
      {state.phase === "SPECIAL_OUTCOME_PENDING_SUBMISSION" ? <>
        <button className="button secondary" disabled={!canWrite} onClick={() => { const value = reason("作废原因"); if (value) void onSend("INVALIDATE_SPECIAL_OUTCOME", { reason: value }); }}>作废该特殊结果</button>
        <button className="button" disabled={!canWrite} onClick={() => void onSend("SUBMIT_RESULT", { reason: "主裁判提交特殊结果" })}>提交结果复核</button>
      </> : null}
      {state.phase === "MATCH_COMPLETE_PENDING_SUBMISSION" ? <button className="button" disabled={!canWrite} onClick={() => void onSend("SUBMIT_RESULT", { reason: "主裁判提交全场结果" })}>提交全场结果</button> : null}
      {state.phase === "SUBMITTED" && chief ? <>
        <button className="button" disabled={!canWrite} onClick={() => void onSend("CONFIRM_RESULT", { reason: "裁判长复核通过" })}>复核锁定</button>
        <button className="button danger" disabled={!canWrite} onClick={() => { const value = reason("退回补正原因"); if (value) void onSend("REOPEN_RESULT", { reason: value }); }}>退回补正</button>
      </> : null}
      {state.phase === "CONFIRMED" && chief ? <button className="button danger" disabled={!canWrite} onClick={() => { const value = reason("受控重开原因"); if (value) void onSend("REOPEN_RESULT", { reason: value }); }}>受控重开</button> : null}
    </section>
  );
}

function IntervalClock({ seconds, startedAt, serverTime }: { seconds: number; startedAt: string; serverTime: string }) {
  const [now, setNow] = useState(() => Date.now());
  const [serverOffset] = useState(() => Date.parse(serverTime) - Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const remaining = Math.max(0, seconds - Math.floor((now + serverOffset - Date.parse(startedAt)) / 1_000));
  return <p className="interval-clock" aria-live="polite">间歇提醒 <strong>{Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}</strong><span>归零只提醒，不自动处罚或改分。</span></p>;
}
