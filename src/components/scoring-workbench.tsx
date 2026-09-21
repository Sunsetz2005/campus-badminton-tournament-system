"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

import { ActionButton } from "@/components/ui/action-button";
import { ResourceState } from "@/components/ui/resource-state";
import type { MatchCommand, MatchState, Side } from "@/domain/rules/match-engine";
import { CourtConsole } from "@/components/court-console";

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

type ActionSheetState =
  | { kind: "UNDO"; side: Side }
  | { kind: "SWAP_POSITION"; side: Side }
  | { kind: "ENDS" }
  | { kind: "SCORE"; side?: Side }
  | { kind: "SERVICE_ORDER" }
  | { kind: "SINGLES_CHECK"; side: Side }
  | { kind: "TAKEOVER" }
  | { kind: "SPECIAL" }
  | { kind: "REASON_COMMAND"; title: string; type: MatchCommand["type"]; payload: MatchCommand["payload"] };

type PreviewState = {
  envelope: Envelope;
  before: MatchState;
  after: MatchState;
};

type EndsMode = "CONFIRM" | "FULFILL" | "KEEP_PENDING" | "RESOLVE_REVIEW" | "CORRECT";
type InitialLoadState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "forbidden"; message: string }
  | { kind: "not-found"; message: string }
  | { kind: "offline"; message: string }
  | { kind: "error"; message: string };
type ActionRequestState = "IDLE" | "ACQUIRING" | "PREVIEWING";

const phaseLabels: Record<MatchState["phase"], string> = {
  AWAITING_COIN_TOSS: "等待抛币",
  AWAITING_OPENING_SETUP: "等待首局设置",
  IN_PROGRESS: "比赛进行中",
  OBLIGATIONS_PENDING: "有规则事项待处理",
  GAME_COMPLETE: "本局结束",
  AWAITING_NEXT_GAME_SETUP: "等待下一局设置",
  MATCH_COMPLETE_PENDING_SUBMISSION: "比赛结束，待提交",
  SPECIAL_OUTCOME_PENDING_SUBMISSION: "特殊结果待提交",
  PAUSED: "比赛暂停",
  SUBMITTED: "结果已提交，待复核",
  CONFIRMED: "结果已确认",
};

const specialOutcomeLabels: Record<NonNullable<MatchState["specialOutcome"]>["type"], string> = {
  WO: "弃权（WO）",
  RET: "退赛（RET）",
  DSQ: "取消资格（DSQ）",
  ABANDONED: "比赛中止",
  BYE: "轮空（BYE）",
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

class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function responseJson(response: Response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiRequestError(
      response.status,
      body?.error?.code ?? "request_failed",
      body?.error?.message ?? "服务器请求失败。",
    );
  }
  return body;
}

export function ScoringWorkbench({ matchCode }: { matchCode: string }) {
  const [snapshot, setSnapshot] = useState<SnapshotResponse | null>(null);
  const [initialLoadState, setInitialLoadState] = useState<InitialLoadState>({ kind: "loading" });
  const [dataFreshness, setDataFreshness] = useState<"FRESH" | "STALE">("FRESH");
  const storageKey = `badminton-control:${matchCode}`;
  const pendingKey = `badminton-pending:${matchCode}`;
  const [control, setControl] = useState<SessionControl | null>(() => {
    if (typeof window === "undefined") return null;
    const saved = sessionStorage.getItem(storageKey);
    return saved ? JSON.parse(saved) as SessionControl : null;
  });
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const [syncState, setSyncState] = useState<"SYNCED" | "SUBMITTING" | "UNKNOWN" | "CONFLICT" | "READ_ONLY">("READ_ONLY");
  const [pendingResolution, setPendingResolution] = useState<"QUERYING" | "NOT_FOUND" | null>(null);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"error" | "status">("error");
  const [actionRequestState, setActionRequestState] = useState<ActionRequestState>("IDLE");
  const [actionSheet, setActionSheet] = useState<ActionSheetState | null>(null);
  const [sheetClosing, setSheetClosing] = useState(false);
  const [reason, setReason] = useState("");
  const [sheetError, setSheetError] = useState("");
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [scoreA, setScoreA] = useState(0);
  const [scoreB, setScoreB] = useState(0);
  const [correctedServingSide, setCorrectedServingSide] = useState<Side>("A");
  const [endsMode, setEndsMode] = useState<EndsMode>("CORRECT");
  const [actualEndA, setActualEndA] = useState<"END_1" | "END_2">("END_1");
  const [specialType, setSpecialType] = useState<"WO" | "RET" | "DSQ" | "ABANDONED" | "BYE">("RET");
  const [specialWinner, setSpecialWinner] = useState<"" | Side>("");
  const [setupServerId, setSetupServerId] = useState("");
  const [setupReceiverId, setSetupReceiverId] = useState("");
  const [setupSelectionScope, setSetupSelectionScope] = useState("");
  const [flipped, setFlipped] = useState(() => {
    if (typeof window === "undefined") return false;
    return sessionStorage.getItem(`badminton-view-flipped:${matchCode}`) === "true";
  });
  const sheetCloseRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const sheetCloseTimerRef = useRef<number | null>(null);
  const actionSheetEpochRef = useRef(0);
  const latestVersionRef = useRef(-1);
  const refreshSequenceRef = useRef(0);
  const state = snapshot?.state;
  const match = snapshot?.match;

  const closeActionSheet = useCallback(() => {
    actionSheetEpochRef.current += 1;
    const finish = () => {
      setActionSheet(null);
      setSheetClosing(false);
      setPreview(null);
      setReason("");
      setSheetError("");
      setActionRequestState("IDLE");
      sheetCloseTimerRef.current = null;
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      finish();
      return;
    }
    setSheetClosing(true);
    if (sheetCloseTimerRef.current !== null) window.clearTimeout(sheetCloseTimerRef.current);
    sheetCloseTimerRef.current = window.setTimeout(finish, 180);
  }, []);

  const reconcilePendingCommand = useCallback(async () => {
    const raw = localStorage.getItem(pendingKey);
    if (!raw) {
      setPendingResolution(null);
      return "none" as const;
    }
    const envelope = JSON.parse(raw) as Envelope;
    setSyncState("UNKNOWN");
    setPendingResolution("QUERYING");
    try {
      const response = await fetch(
        `/api/matches/${encodeURIComponent(matchCode)}/commands/${envelope.commandId}`,
        { cache: "no-store" },
      );
      if (response.status === 404) {
        setPendingResolution("NOT_FOUND");
        setMessageTone("error");
        setMessage("服务器暂未找到这条待确认命令。只能查询或以原 commandId 重试，不能开始新操作。");
        return "not_found" as const;
      }
      const body = await responseJson(response);
      localStorage.removeItem(pendingKey);
      latestVersionRef.current = Math.max(latestVersionRef.current, body.version);
      setSnapshot((current) => current ? {
        ...current,
        version: body.version,
        state: body.state,
        events: body.events
          ? [
              ...(current.events ?? []).filter(
                (event) => !body.events.some((recovered: { commandId: string }) => recovered.commandId === event.commandId),
              ),
              ...body.events,
            ]
          : current.events,
      } : current);
      setPendingResolution(null);
      setSyncState("SYNCED");
      setOnline(true);
      setDataFreshness("FRESH");
      setMessageTone("status");
      setMessage("已按原 commandId 找回服务器结果。");
      return "found" as const;
    } catch (error) {
      setPendingResolution(null);
      setSyncState("UNKNOWN");
      if (!(error instanceof ApiRequestError)) setOnline(false);
      setMessageTone("error");
      setMessage(error instanceof Error ? error.message : "待确认命令仍无法对账。");
      return "unavailable" as const;
    }
  }, [matchCode, pendingKey]);

  const refresh = useCallback(async (force = false) => {
    const requestSequence = ++refreshSequenceRef.current;
    const after = !force && snapshot?.version !== undefined ? `?afterVersion=${snapshot.version}` : "";
    try {
      const next = await responseJson(await fetch(`/api/matches/${encodeURIComponent(matchCode)}/state${after}`, { cache: "no-store" })) as SnapshotResponse;
      if (requestSequence !== refreshSequenceRef.current) return;
      if (next.status === "snapshot" && next.version < latestVersionRef.current) {
        setDataFreshness("STALE");
        setMessageTone("status");
        setMessage("已忽略迟到的旧版本响应，继续显示较新的服务器权威状态。");
        return;
      }
      latestVersionRef.current = Math.max(latestVersionRef.current, next.version);
      setSnapshot((current) => next.status === "unchanged" ? { ...current!, ...next } : next);
      setInitialLoadState({ kind: "ready" });
      setDataFreshness("FRESH");
      setOnline(true);
      const hasPendingCommand = localStorage.getItem(pendingKey) !== null;
      setSyncState((current) => current === "SUBMITTING"
        ? current
        : hasPendingCommand
          ? "UNKNOWN"
          : control
            ? "SYNCED"
            : "READ_ONLY");
    } catch (error) {
      if (requestSequence !== refreshSequenceRef.current) return;
      const errorMessage = error instanceof Error ? error.message : "无法同步权威状态。";
      const requestReachedServer = error instanceof ApiRequestError;
      if (!requestReachedServer) setOnline(false);
      else setOnline(navigator.onLine);
      setSyncState("READ_ONLY");
      setDataFreshness("STALE");
      setMessageTone("error");
      setMessage(errorMessage);
      if (!snapshot) {
        if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403)) {
          setInitialLoadState({ kind: "forbidden", message: errorMessage });
        } else if (error instanceof ApiRequestError && error.status === 404) {
          setInitialLoadState({ kind: "not-found", message: errorMessage });
        } else if (!requestReachedServer) {
          setInitialLoadState({ kind: "offline", message: "无法连接服务器，请检查网络后重试。" });
        } else {
          setInitialLoadState({ kind: "error", message: errorMessage });
        }
      }
    }
  }, [control, matchCode, pendingKey, snapshot]);

  useEffect(() => {
    queueMicrotask(() => void (async () => {
      await refresh(true);
      await reconcilePendingCommand();
    })());
    const onOnline = () => {
      setOnline(true);
      void (async () => {
        await refresh(true);
        await reconcilePendingCommand();
      })();
    };
    const onOffline = () => { setOnline(false); setSyncState("READ_ONLY"); };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [matchCode]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        await refresh();
        if (!stopped) schedule();
      }, document.hidden ? 10_000 : 2_000);
    };
    const reconcileVisibleState = async () => {
      await refresh(true);
      await reconcilePendingCommand();
    };
    const visible = () => {
      if (!document.hidden) void reconcileVisibleState();
      schedule();
    };
    const orientationChanged = () => void reconcileVisibleState();
    schedule();
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("orientationchange", orientationChanged);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("orientationchange", orientationChanged);
    };
  }, [reconcilePendingCommand, refresh]);

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
        setMessageTone("error");
        setMessage(error instanceof Error ? error.message : "心跳失败，已切换只读。");
      }
    }, 30_000);
    return () => window.clearInterval(heartbeat);
  }, [control, matchCode, storageKey]);

  useEffect(() => {
    if (!actionSheet) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeActionSheet();
        return;
      }
      if (event.key !== "Tab" || !sheetRef.current) return;
      const focusable = Array.from(sheetRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    queueMicrotask(() => sheetCloseRef.current?.focus());
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      queueMicrotask(() => previouslyFocused?.focus());
    };
  }, [actionSheet, closeActionSheet]);

  useEffect(() => {
    if (!actionSheet) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [actionSheet]);

  async function acquire(takeover = false, takeoverReason = "") {
    if (actionRequestState !== "IDLE") return;
    setActionRequestState("ACQUIRING");
    setMessage("");
    try {
      const path = takeover ? "control/takeover" : "control";
      const body = takeover
        ? { deviceSessionId: deviceId(matchCode), reason: takeoverReason.trim() }
        : { deviceSessionId: deviceId(matchCode) };
      if (takeover && !body.reason) return;
      const result = await responseJson(await fetch(`/api/matches/${encodeURIComponent(matchCode)}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })) as SessionControl;
      setControl(result);
      sessionStorage.setItem(storageKey, JSON.stringify(result));
      await refresh(true);
      setSyncState("SYNCED");
      setActionSheet(null);
      setReason("");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "无法取得控制权。";
      if (takeover) setSheetError(errorMessage);
      else {
        setMessageTone("error");
        setMessage(errorMessage);
      }
    } finally {
      setActionRequestState("IDLE");
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
    if (!control || !online || syncState === "SUBMITTING") return false;
    const existingPending = localStorage.getItem(pendingKey);
    if (existingPending) {
      const pendingEnvelope = JSON.parse(existingPending) as Envelope;
      if (pendingEnvelope.commandId !== envelope.commandId) {
        setSyncState("UNKNOWN");
        setMessageTone("error");
        setMessage("仍有待确认命令；新操作已阻止。请先按原 commandId 对账。");
        return false;
      }
    }
    setSyncState("SUBMITTING");
    setPendingResolution(null);
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
      latestVersionRef.current = Math.max(latestVersionRef.current, body.version);
      setSnapshot((current) => current ? {
        ...current,
        version: body.version,
        state: body.state,
        events: [
          ...(current.events ?? []).filter(
            (event) => !body.events.some((accepted: { commandId: string }) => accepted.commandId === event.commandId),
          ),
          ...body.events,
        ],
      } : current);
      setPendingResolution(null);
      setSyncState("SYNCED");
      setDataFreshness("FRESH");
      return true;
    } catch (error) {
      if (error instanceof ApiRequestError) {
        localStorage.removeItem(pendingKey);
        setPendingResolution(null);
        if (error.code === "not_controller" || error.status === 401 || error.status === 403) {
          setControl(null);
          sessionStorage.removeItem(storageKey);
          setSyncState("READ_ONLY");
        } else if (error.status === 409) {
          setSyncState("CONFLICT");
        } else {
          setSyncState(control ? "SYNCED" : "READ_ONLY");
        }
        if (actionSheet) setSheetError(error.message);
        else {
          setMessageTone("error");
          setMessage(error.message);
        }
        await refresh(true);
        if (error.code === "not_controller" || error.status === 401 || error.status === 403) setSyncState("READ_ONLY");
        else if (error.status === 409) setSyncState("CONFLICT");
        return false;
      }
      setSyncState("UNKNOWN");
      setMessageTone("error");
      setMessage("命令结果未知。正式状态保持最后一次服务器确认值，正在按原 commandId 对账。");
      if (actionSheet) closeActionSheet();
      await refresh(true);
      await reconcilePendingCommand();
      return false;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function send(type: MatchCommand["type"], payload: MatchCommand["payload"]) {
    return submitEnvelope(makeEnvelope(type, payload));
  }

  async function retryPendingCommand() {
    const raw = localStorage.getItem(pendingKey);
    if (!raw) return reconcilePendingCommand();
    if (!control || !online) {
      setMessageTone("error");
      setMessage("当前离线或控制会话已失效，不能重试待确认命令。");
      return false;
    }
    return submitEnvelope(JSON.parse(raw) as Envelope);
  }

  function openActionSheet(next: ActionSheetState) {
    if (sheetCloseTimerRef.current !== null) window.clearTimeout(sheetCloseTimerRef.current);
    actionSheetEpochRef.current += 1;
    setSheetClosing(false);
    setActionSheet(next);
    setReason("");
    setSheetError("");
    setPreview(null);
    setActionRequestState("IDLE");
    setScoreA(state?.score.A ?? 0);
    setScoreB(state?.score.B ?? 0);
    setCorrectedServingSide(state?.servingSide ?? "A");
    setActualEndA(state?.physicalEnds?.A ?? "END_1");
    if (next.kind === "ENDS") {
      const hasChangeEnds = state?.pendingObligations.some((item) => item.type === "CHANGE_ENDS");
      const hasReview = state?.pendingObligations.some((item) => item.type === "PHYSICAL_ENDS_REVIEW");
      setEndsMode(hasChangeEnds ? "CONFIRM" : hasReview ? "RESOLVE_REVIEW" : "CORRECT");
    }
  }

  async function requestPreview(envelope: Envelope) {
    if (!control || actionRequestState !== "IDLE") return null;
    const epoch = actionSheetEpochRef.current;
    setActionRequestState("PREVIEWING");
    try {
      setSheetError("");
      const result = await responseJson(await fetch(`/api/matches/${encodeURIComponent(matchCode)}/commands/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${control.controlToken}` },
        body: JSON.stringify(envelope),
      }));
      if (epoch !== actionSheetEpochRef.current) return null;
      const nextPreview = { envelope, before: result.before, after: result.after } satisfies PreviewState;
      setPreview(nextPreview);
      return nextPreview;
    } catch (error) {
      if (epoch === actionSheetEpochRef.current) {
        setSheetError(error instanceof Error ? error.message : "无法生成更正预览。");
      }
      return null;
    } finally {
      if (epoch === actionSheetEpochRef.current) setActionRequestState("IDLE");
    }
  }

  async function previewCurrentAction() {
    if (!actionSheet || !state) return;
    const trimmedReason = reason.trim();
    let envelope: Envelope;

    if (actionSheet.kind === "UNDO") {
      if (!trimmedReason) return setSheetError("撤销原因不能为空。");
      envelope = makeEnvelope("UNDO_LAST_REVERSIBLE", { reason: trimmedReason });
      const result = await requestPreview(envelope);
      if (!result) return;
      const otherSide = actionSheet.side === "A" ? "B" : "A";
      if (
        result.before.score[actionSheet.side] - result.after.score[actionSheet.side] !== 1 ||
        result.before.score[otherSide] !== result.after.score[otherSide]
      ) {
        setPreview(null);
        setSheetError(`最近可撤销得分不属于 ${actionSheet.side} 方，请使用完整更正。`);
      }
      return;
    }

    if (actionSheet.kind === "SWAP_POSITION") {
      if (!trimmedReason || !state.logicalCourts) return setSheetError("换位原因不能为空。");
      const side = actionSheet.side;
      envelope = makeEnvelope("CORRECT_LOGICAL_COURTS", {
        reason: trimmedReason,
        logicalCourts: {
          ...state.logicalCourts,
          [side]: { R: state.logicalCourts[side].L, L: state.logicalCourts[side].R },
        },
      });
      await requestPreview(envelope);
      return;
    }

    if (actionSheet.kind === "ENDS") {
      const changeEnds = state.pendingObligations.find((item) => item.type === "CHANGE_ENDS");
      const review = state.pendingObligations.find((item) => item.type === "PHYSICAL_ENDS_REVIEW");
      if (endsMode === "CONFIRM") {
        if (!changeEnds) return setSheetError("当前没有待确认的规则换边事项。");
        await requestPreview(makeEnvelope("CONFIRM_CHANGE_ENDS", { obligationId: changeEnds.id }));
        return;
      }
      if (!trimmedReason) return setSheetError("场地端更正原因不能为空。");
      const obligation = endsMode === "RESOLVE_REVIEW" ? review : changeEnds;
      const obligationRelationship = obligation
        ? { obligationId: obligation.id, action: endsMode === "KEEP_PENDING" ? "KEEP_PENDING" as const : "FULFILL" as const }
        : undefined;
      await requestPreview(makeEnvelope("CORRECT_PHYSICAL_ENDS", {
        reason: trimmedReason,
        physicalEnds: { A: actualEndA, B: actualEndA === "END_1" ? "END_2" : "END_1" },
        ...(obligationRelationship ? { obligationRelationship } : {}),
      }));
      return;
    }

    if (actionSheet.kind === "SERVICE_ORDER") {
      if (!trimmedReason || !state.logicalCourts) return setSheetError("发接发更正原因不能为空。");
      const servingSide = correctedServingSide;
      const receivingSide = servingSide === "A" ? "B" : "A";
      const court = state.score[servingSide] % 2 === 0 ? "R" : "L";
      await requestPreview(makeEnvelope("CORRECT_SERVICE_ORDER", {
        reason: trimmedReason,
        servingSide,
        serverPlayerId: state.logicalCourts[servingSide][court],
        receiverPlayerId: state.logicalCourts[receivingSide][court],
      }));
      return;
    }

    if (actionSheet.kind === "SCORE" || actionSheet.kind === "SINGLES_CHECK") {
      if (!trimmedReason || !state.servingSide) return setSheetError("更正原因不能为空。");
      const servingSide = correctedServingSide;
      const receivingSide = servingSide === "A" ? "B" : "A";
      const court = (servingSide === "A" ? scoreA : scoreB) % 2 === 0 ? "R" : "L";
      await requestPreview(makeEnvelope("CORRECT_SCORE_STATE", { reason: trimmedReason, replacement: {
        score: { A: scoreA, B: scoreB }, gamesWon: state.gamesWon, completedGames: state.completedGames,
        servingSide,
        serverPlayerId: state.format === "DOUBLES" ? state.logicalCourts![servingSide][court] : state.players[servingSide][0],
        receiverPlayerId: state.format === "DOUBLES" ? state.logicalCourts![receivingSide][court] : state.players[receivingSide][0],
        logicalCourts: state.logicalCourts,
        pendingObligations: state.pendingObligations,
        phase: state.pendingObligations.length > 0 ? "OBLIGATIONS_PENDING" : "IN_PROGRESS",
      } }));
    }
  }

  async function confirmPreview() {
    if (!preview) return;
    if (await submitEnvelope(preview.envelope)) closeActionSheet();
  }

  async function submitSheetAction() {
    if (!actionSheet) return;
    const trimmedReason = reason.trim();
    if (actionSheet.kind === "TAKEOVER") {
      if (!trimmedReason) return setSheetError("接管原因不能为空。");
      await acquire(true, trimmedReason);
      return;
    }
    if (actionSheet.kind === "SPECIAL") {
      if (!trimmedReason) return setSheetError("特殊结果原因不能为空。");
      const accepted = await send("RECORD_SPECIAL_OUTCOME", {
        type: specialType,
        ...(specialWinner ? { winnerSide: specialWinner } : {}),
        reason: trimmedReason,
      });
      if (accepted) closeActionSheet();
      return;
    }
    if (actionSheet.kind === "REASON_COMMAND") {
      if (!trimmedReason) return setSheetError("原因不能为空。");
      if (await send(actionSheet.type, { ...actionSheet.payload, reason: trimmedReason } as MatchCommand["payload"])) {
        closeActionSheet();
      }
    }
  }

  const canWrite = Boolean(
    control && online && syncState === "SYNCED" &&
    snapshot?.control.ownedByCurrentUser && snapshot.control.sessionId === control.sessionId,
  );
  const syncLabel = !online
    ? "离线"
    : ({
        SYNCED: "已同步",
        SUBMITTING: "提交中",
        UNKNOWN: "响应待确认",
        CONFLICT: "版本冲突",
        READ_ONLY: "只读",
      } as const)[syncState];
  const sideName = (side: Side) => side === "A" ? match?.sideAName : match?.sideBName;
  const playerName = (id: string | null) => id ? match?.playerNames[id] ?? id : "待确认";
  const intervalStartedAt = snapshot?.events
    ? [...snapshot.events].reverse().find(
        (event) => event.type === "RALLY_WON" || event.type === "CORRECT_SCORE_STATE",
      )?.occurredAt ?? snapshot.serverTime
    : snapshot?.serverTime;
  const setupServingSide = state?.phase === "AWAITING_NEXT_GAME_SETUP" ? state.nextGameServingSide : state?.servingSide;
  const setupReceivingSide = setupServingSide === "A" ? "B" : setupServingSide === "B" ? "A" : null;
  const setupScope = state && setupServingSide && setupReceivingSide
    ? `${state.phase}:${state.currentGame}:${setupServingSide}:${setupReceivingSide}`
    : "";
  const effectiveSetupServerId = state && setupServingSide && setupSelectionScope === setupScope && state.players[setupServingSide].includes(setupServerId)
    ? setupServerId
    : state && setupServingSide ? state.players[setupServingSide][0] ?? "" : "";
  const effectiveSetupReceiverId = state && setupReceivingSide && setupSelectionScope === setupScope && state.players[setupReceivingSide].includes(setupReceiverId)
    ? setupReceiverId
    : state && setupReceivingSide ? state.players[setupReceivingSide][0] ?? "" : "";
  const setupCourts = useMemo(() => {
    if (!state || state.format !== "DOUBLES" || !setupServingSide || !setupReceivingSide || !effectiveSetupServerId || !effectiveSetupReceiverId) return null;
    const serverPartner = state.players[setupServingSide].find((id) => id !== effectiveSetupServerId);
    const receiverPartner = state.players[setupReceivingSide].find((id) => id !== effectiveSetupReceiverId);
    if (!serverPartner || !receiverPartner) return null;
    return {
      [setupServingSide]: { R: effectiveSetupServerId, L: serverPartner },
      [setupReceivingSide]: { R: effectiveSetupReceiverId, L: receiverPartner },
    } as MatchState["logicalCourts"];
  }, [effectiveSetupReceiverId, effectiveSetupServerId, setupReceivingSide, setupServingSide, state]);
  const setupActive = Boolean(
    state && (state.phase === "AWAITING_OPENING_SETUP" || state.phase === "AWAITING_NEXT_GAME_SETUP") &&
    setupServingSide && setupReceivingSide && effectiveSetupServerId && effectiveSetupReceiverId,
  );
  // 次要抽屉平时收起；到了必须提交或复核的相位时默认展开，避免把关键一步藏起来。
  const secondaryNeedsAttention = Boolean(
    state && ["MATCH_COMPLETE_PENDING_SUBMISSION", "SPECIAL_OUTCOME_PENDING_SUBMISSION", "SUBMITTED", "CONFIRMED"].includes(state.phase),
  );
  const courtState = useMemo(() => {
    if (!state || !setupActive || !setupServingSide) return state;
    return {
      ...state,
      currentGame: state.phase === "AWAITING_NEXT_GAME_SETUP" ? state.currentGame + 1 : state.currentGame,
      score: state.phase === "AWAITING_NEXT_GAME_SETUP" ? { A: 0, B: 0 } : state.score,
      servingSide: setupServingSide,
      serverPlayerId: effectiveSetupServerId,
      receiverPlayerId: effectiveSetupReceiverId,
      serverCourt: "R" as const,
      receiverCourt: "R" as const,
      logicalCourts: state.format === "DOUBLES" ? setupCourts : null,
    };
  }, [effectiveSetupReceiverId, effectiveSetupServerId, setupActive, setupCourts, setupServingSide, state]);

  async function confirmSetup() {
    if (!state || !setupActive || !effectiveSetupServerId || !effectiveSetupReceiverId) return;
    const type = state.phase === "AWAITING_NEXT_GAME_SETUP" ? "CONFIRM_NEXT_GAME_SETUP" : "CONFIRM_OPENING_SETUP";
    await send(type, {
      serverPlayerId: effectiveSetupServerId,
      receiverPlayerId: effectiveSetupReceiverId,
      logicalCourts: state.format === "DOUBLES" ? setupCourts : null,
    });
  }

  function flipLocalView() {
    setFlipped((current) => {
      const next = !current;
      sessionStorage.setItem(`badminton-view-flipped:${matchCode}`, String(next));
      return next;
    });
  }

  async function retryInitialLoad() {
    setInitialLoadState({ kind: "loading" });
    setMessage("");
    await refresh(true);
  }

  if (!snapshot || !state || !match) {
    if (initialLoadState.kind === "loading") {
      return (
        <ResourceState
          description="正在从服务器读取比赛、控制权和最新比分。服务器确认前不会显示可写状态。"
          eyebrow="权威状态"
          title="正在读取比赛状态"
          tone="loading"
        />
      );
    }
    const canRetry = initialLoadState.kind === "offline" || initialLoadState.kind === "error";
    const loadMessage = initialLoadState.kind === "ready"
      ? "服务器响应缺少完整比赛状态，请重新读取。"
      : initialLoadState.message;
    return (
      <ResourceState
        action={canRetry ? <ActionButton onClick={() => void retryInitialLoad()}>重新读取</ActionButton> : undefined}
        description={loadMessage}
        eyebrow={initialLoadState.kind === "forbidden" ? "没有访问权限" : initialLoadState.kind === "not-found" ? "比赛不存在" : "读取失败"}
        title={initialLoadState.kind === "forbidden" ? "无法进入该场执裁" : initialLoadState.kind === "not-found" ? "找不到这场比赛" : "暂时无法读取权威状态"}
        tone={initialLoadState.kind === "not-found" ? "not-found" : "error"}
      />
    );
  }

  return (
    <>
    <section className="scoring-shell" inert={actionSheet ? true : undefined}>
      <header className="scoring-statusbar">
        <div><span className="eyebrow">{match.competitionName} · {match.courtName ?? "场地待定"}</span><h1>{match.code}</h1></div>
        <div className="status-facts" aria-live="polite">
          <span><i className={`sync-dot ${online ? "online" : "offline"}`} />网络<strong>{online ? "在线" : "离线"}</strong></span>
          <span>控制<strong>{canWrite ? "本机可写" : "只读"}</strong></span>
          <span>同步<strong>{syncLabel}</strong></span>
          <span>数据<strong>{dataFreshness === "FRESH" ? "最新" : "可能过期"}</strong></span>
          <small>服务器版本 {state.version}</small>
        </div>
      </header>

      {dataFreshness === "STALE" && !message ? <p className="scoring-stale" role="status">无法确认最新状态；继续显示最后一次服务器确认数据，写入保持只读。</p> : null}
      {message ? <p className={`scoring-alert ${messageTone === "status" ? "is-status" : ""}`} role={messageTone === "error" ? "alert" : "status"}>{message}</p> : null}
      {syncState === "UNKNOWN" ? (
        <section className="pending-recovery" aria-live="assertive">
          <div>
            <strong>有一条命令结果待确认</strong>
            <span>比分、站位和发接发保持最后一次已确认状态；在原命令解决前禁止新操作。</span>
          </div>
          <button className="button secondary" disabled={!online || pendingResolution === "QUERYING"} onClick={() => void reconcilePendingCommand()}>
            {pendingResolution === "QUERYING" ? "正在查询…" : "查询原命令结果"}
          </button>
          {pendingResolution === "NOT_FOUND" ? (
            <button className="button" disabled={!online || !control} onClick={() => void retryPendingCommand()}>
              以原命令重试
            </button>
          ) : null}
        </section>
      ) : null}
      <CourtConsole
        busy={syncState === "SUBMITTING" || syncState === "UNKNOWN"}
        canWrite={canWrite}
        draft={setupActive}
        flipped={flipped}
        onAddPoint={(side) => void send("RALLY_WON", { side })}
        onChangeEnds={() => openActionSheet({ kind: "ENDS" })}
        onCorrectPosition={(side) => openActionSheet(state.format === "DOUBLES" ? { kind: "SWAP_POSITION", side } : { kind: "SINGLES_CHECK", side })}
        onSubtractPoint={(side) => openActionSheet({ kind: "UNDO", side })}
        playerName={playerName}
        sideName={(side) => sideName(side) ?? `${side} 方`}
        state={courtState ?? state}
      />

      <div className="control-strip">
        {!control && snapshot.access.assignedReferee ? (
          <ActionButton loading={actionRequestState === "ACQUIRING"} loadingLabel="正在取得控制…" onClick={() => void acquire()}>
            取得本机控制权
          </ActionButton>
        ) : null}
        <span>{canWrite
          ? "所有操作等待服务器确认后更新"
          : syncState === "UNKNOWN"
            ? "响应未知，只读；必须用原 commandId 对账"
            : syncState === "CONFLICT"
              ? "版本冲突，只读；已拉取服务器权威状态"
              : online
                ? "当前设备没有有效写入控制"
                : "离线，只读；恢复后先对账"}</span>
      </div>

      <div className="games-ribbon">
        <strong>第 {state.currentGame} 局</strong>
        {state.completedGames.map((game) => <span key={game.number}>第{game.number}局 {game.scoreA}:{game.scoreB}</span>)}
      </div>
      {state.specialOutcome ? (
        <section className="special-outcome-summary" aria-labelledby="special-outcome-title">
          <div>
            <span className="eyebrow">特殊结果待处理</span>
            <h2 id="special-outcome-title">{specialOutcomeLabels[state.specialOutcome.type]}</h2>
          </div>
          <dl>
            <div><dt>胜方（如适用）</dt><dd>{state.specialOutcome.winnerSide ? `${state.specialOutcome.winnerSide} 方` : "无胜方"}</dd></div>
            <div><dt>记录原因</dt><dd>{state.specialOutcome.reason}</dd></div>
          </dl>
          <p>作废会由服务器恢复到录入前的完整权威状态，不会在浏览器本地拼接比分或站位。</p>
        </section>
      ) : null}
      {state.pendingObligations.some((item) => item.type === "INTERVAL") ? (
        <IntervalClock
          key={`${intervalStartedAt}:${snapshot.serverTime}`}
          seconds={state.phase === "GAME_COMPLETE" ? state.ruleConfig.betweenGamesSeconds : state.ruleConfig.intervalSeconds}
          serverTime={snapshot.serverTime}
          startedAt={intervalStartedAt ?? snapshot.serverTime}
        />
      ) : null}

      {setupActive && setupServingSide && setupReceivingSide ? (
        <section className="opening-setup-panel" aria-labelledby="opening-setup-title">
          <div><span className="eyebrow">确认后才写入比赛</span><h2 id="opening-setup-title">本局首发与首接设置</h2></div>
          <label>首发球员（{setupServingSide} 方）
            <select value={effectiveSetupServerId} onChange={(event) => { setSetupSelectionScope(setupScope); setSetupServerId(event.target.value); }}>
              {state.players[setupServingSide].map((id) => <option key={id} value={id}>{playerName(id)}</option>)}
            </select>
          </label>
          <label>首接球员（{setupReceivingSide} 方）
            <select value={effectiveSetupReceiverId} onChange={(event) => { setSetupSelectionScope(setupScope); setSetupReceiverId(event.target.value); }}>
              {state.players[setupReceivingSide].map((id) => <option key={id} value={id}>{playerName(id)}</option>)}
            </select>
          </label>
          <button className="button" disabled={!canWrite || !setupCourts && state.format === "DOUBLES"} onClick={() => void confirmSetup()}>
            {state.phase === "AWAITING_OPENING_SETUP" ? "确认首局设置并开赛" : "确认下一局设置"}
          </button>
        </section>
      ) : null}

      <PhaseActions
        canWrite={canWrite}
        chief={snapshot.access.chiefReferee}
        scope="URGENT"
        state={state}
        onSend={send}
        onCorrection={() => openActionSheet({ kind: "SCORE" })}
        onReasonCommand={(title, type, payload) => openActionSheet({ kind: "REASON_COMMAND", title, type, payload })}
        onServiceOrder={() => openActionSheet({ kind: "SERVICE_ORDER" })}
        onSpecial={() => openActionSheet({ kind: "SPECIAL" })}
      />

      {/* 次要操作收进折叠抽屉；需要提交或复核时默认展开，避免误藏关键一步。 */}
      <details className="secondary-drawer" open={secondaryNeedsAttention}>
        <summary>
          次要操作与记录
          <span>暂停 · 详细更正 · 异常结果 · 接管 · 视角 · 事件记录{secondaryNeedsAttention ? " · 待提交或复核" : ""}</span>
        </summary>
        <div className="secondary-drawer-body">
          <div className="service-panel">
            <div><span>当前阶段</span><strong>{phaseLabels[state.phase]}</strong></div>
            <div><span>发球</span><strong>{["IN_PROGRESS", "OBLIGATIONS_PENDING", "PAUSED"].includes(state.phase) ? `${playerName(state.serverPlayerId)} · ${state.serverCourt === "R" ? "右发球区" : state.serverCourt === "L" ? "左发球区" : "待确认"}` : "当前无下一球"}</strong></div>
            <div><span>接发</span><strong>{["IN_PROGRESS", "OBLIGATIONS_PENDING", "PAUSED"].includes(state.phase) ? `${playerName(state.receiverPlayerId)} · ${state.receiverCourt === "R" ? "右发球区" : state.receiverCourt === "L" ? "左发球区" : "待确认"}` : "当前无下一球"}</strong></div>
            <div><span>物理端</span><strong>{state.physicalEnds ? `A 场地端 ${state.physicalEnds.A.replace("END_", "")} / B 场地端 ${state.physicalEnds.B.replace("END_", "")}` : "待确认"}</strong></div>
          </div>

          <PhaseActions
            canWrite={canWrite}
            chief={snapshot.access.chiefReferee}
            scope="SECONDARY"
            state={state}
            onSend={send}
            onCorrection={() => openActionSheet({ kind: "SCORE" })}
            onReasonCommand={(title, type, payload) => openActionSheet({ kind: "REASON_COMMAND", title, type, payload })}
            onServiceOrder={() => openActionSheet({ kind: "SERVICE_ORDER" })}
            onSpecial={() => openActionSheet({ kind: "SPECIAL" })}
          />

          <div className="device-strip">
            {snapshot.access.chiefReferee ? <button className="button secondary" onClick={() => openActionSheet({ kind: "TAKEOVER" })}>裁判长接管</button> : null}
            <button className="button secondary" onClick={flipLocalView}>翻转本机视角</button>
            <span>翻转视角只改本机显示方向，不是正式换边，也不产生服务器事件。</span>
          </div>

          <section className="history-panel">
            <h2>最近操作</h2>
            <ol>{(snapshot.events ?? []).slice().reverse().map((event) => <li key={event.commandId}><strong>v{event.version}</strong> {event.type}<time>{new Date(event.occurredAt).toLocaleTimeString("zh-CN")}</time></li>)}</ol>
          </section>
        </div>
      </details>

    </section>
      {actionSheet ? createPortal(<WorkbenchActionSheet
        action={actionSheet}
        busy={actionRequestState !== "IDLE" || syncState === "SUBMITTING"}
        actualEndA={actualEndA}
        closeRef={sheetCloseRef}
        closing={sheetClosing}
        dialogRef={sheetRef}
        endsMode={endsMode}
        error={sheetError}
        onActualEndA={(value) => { setActualEndA(value); setPreview(null); }}
        onClose={closeActionSheet}
        onConfirmPreview={() => void confirmPreview()}
        onCorrectedServingSide={(value) => { setCorrectedServingSide(value); setPreview(null); }}
        onEndsMode={(value) => { setEndsMode(value); setPreview(null); }}
        onPreview={() => void previewCurrentAction()}
        onReason={(value) => { setReason(value); setPreview(null); }}
        onScoreA={(value) => { setScoreA(value); setPreview(null); }}
        onScoreB={(value) => { setScoreB(value); setPreview(null); }}
        onSpecialSubmit={() => void submitSheetAction()}
        onSpecialType={setSpecialType}
        onSpecialWinner={setSpecialWinner}
        onSubmit={() => void submitSheetAction()}
        preview={preview}
        reason={reason}
        scoreA={scoreA}
        scoreB={scoreB}
        specialType={specialType}
        specialWinner={specialWinner}
        state={state}
        correctedServingSide={correctedServingSide}
      />, document.body) : null}
    </>
  );
}

function actionSheetTitle(action: ActionSheetState) {
  switch (action.kind) {
    case "UNDO": return `更正 ${action.side} 方最近得分`;
    case "SWAP_POSITION": return `更正 ${action.side} 方双打换位`;
    case "ENDS": return "核对并更正物理场地端";
    case "SCORE": return "完整比分与发球权更正";
    case "SERVICE_ORDER": return "更正发接发顺序";
    case "SINGLES_CHECK": return `核对 ${action.side} 方单打站位`;
    case "TAKEOVER": return "裁判长强制接管";
    case "SPECIAL": return "记录特殊结果";
    case "REASON_COMMAND": return action.title;
  }
}

function WorkbenchActionSheet({
  action,
  actualEndA,
  busy,
  closeRef,
  closing,
  correctedServingSide,
  dialogRef,
  endsMode,
  error,
  onActualEndA,
  onClose,
  onConfirmPreview,
  onCorrectedServingSide,
  onEndsMode,
  onPreview,
  onReason,
  onScoreA,
  onScoreB,
  onSpecialSubmit,
  onSpecialType,
  onSpecialWinner,
  onSubmit,
  preview,
  reason,
  scoreA,
  scoreB,
  specialType,
  specialWinner,
  state,
}: {
  action: ActionSheetState;
  actualEndA: "END_1" | "END_2";
  busy: boolean;
  closeRef: RefObject<HTMLButtonElement | null>;
  closing: boolean;
  correctedServingSide: Side;
  dialogRef: RefObject<HTMLElement | null>;
  endsMode: EndsMode;
  error: string;
  onActualEndA: (end: "END_1" | "END_2") => void;
  onClose: () => void;
  onConfirmPreview: () => void;
  onCorrectedServingSide: (side: Side) => void;
  onEndsMode: (mode: EndsMode) => void;
  onPreview: () => void;
  onReason: (reason: string) => void;
  onScoreA: (score: number) => void;
  onScoreB: (score: number) => void;
  onSpecialSubmit: () => void;
  onSpecialType: (type: "WO" | "RET" | "DSQ" | "ABANDONED" | "BYE") => void;
  onSpecialWinner: (side: "" | Side) => void;
  onSubmit: () => void;
  preview: PreviewState | null;
  reason: string;
  scoreA: number;
  scoreB: number;
  specialType: "WO" | "RET" | "DSQ" | "ABANDONED" | "BYE";
  specialWinner: "" | Side;
  state: MatchState;
}) {
  const previewable = ["UNDO", "SWAP_POSITION", "ENDS", "SCORE", "SERVICE_ORDER", "SINGLES_CHECK"].includes(action.kind);
  const hasChangeEnds = state.pendingObligations.some((item) => item.type === "CHANGE_ENDS");
  const hasPhysicalReview = state.pendingObligations.some((item) => item.type === "PHYSICAL_ENDS_REVIEW");
  const confirmOnly = action.kind === "ENDS" && endsMode === "CONFIRM";

  return (
    <div className={`correction-scrim ${closing ? "is-closing" : ""}`} onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}>
      <section aria-busy={busy || undefined} aria-describedby="action-sheet-description" aria-labelledby="action-sheet-title" aria-modal="true" className={`correction-sheet ${closing ? "is-closing" : ""}`} ref={dialogRef} role="dialog">
        <header>
          <div><span className="eyebrow">服务器权威操作</span><h2 id="action-sheet-title">{actionSheetTitle(action)}</h2></div>
          <button aria-label="关闭" className="sheet-close" onClick={onClose} ref={closeRef}>×</button>
        </header>

        <p className="sheet-guidance" id="action-sheet-description">先由服务器生成并验证预览；确认前不会改变权威比分、站位或比赛阶段。</p>

        {action.kind === "UNDO" ? <p>“−”不会直接改分。系统只预览最近一条可逆得分，并核对它是否属于 {action.side} 方。</p> : null}
        {action.kind === "SWAP_POSITION" ? <p>只交换 {action.side} 方两名球员的规则 R/L，比分、对方站位和物理端保持不变。</p> : null}
        {action.kind === "SINGLES_CHECK" ? <p>单打左右发球区由比分奇偶和发球方唯一决定。请更正比分或发球方，不创建任意站位。</p> : null}
        {action.kind === "ENDS" ? (
          <div className="sheet-form-grid">
            <label>处理方式
              <select disabled={busy} value={endsMode} onChange={(event) => onEndsMode(event.target.value as EndsMode)}>
                {hasChangeEnds ? <option value="CONFIRM">现场已按规则完成换边</option> : null}
                {hasChangeEnds ? <option value="FULFILL">更正记录，并同时完成换边待办</option> : null}
                {hasChangeEnds ? <option value="KEEP_PENDING">只更正原记录，换边仍待执行</option> : null}
                {hasPhysicalReview ? <option value="RESOLVE_REVIEW">完成撤销后的现场端位核对</option> : null}
                {!hasChangeEnds && !hasPhysicalReview ? <option value="CORRECT">更正当前场地端记录</option> : null}
              </select>
            </label>
            {!confirmOnly ? <label>A 方现场所在端
              <select disabled={busy} value={actualEndA} onChange={(event) => onActualEndA(event.target.value as "END_1" | "END_2")}>
                <option value="END_1">场地端 1</option><option value="END_2">场地端 2</option>
              </select>
            </label> : null}
          </div>
        ) : null}

        {action.kind === "SCORE" || action.kind === "SINGLES_CHECK" ? (
          <>
            <div className="correction-score">
              <label>A 方比分<input disabled={busy} min="0" type="number" value={scoreA} onChange={(event) => onScoreA(Number(event.target.value))} /></label>
              <label>B 方比分<input disabled={busy} min="0" type="number" value={scoreB} onChange={(event) => onScoreB(Number(event.target.value))} /></label>
            </div>
            <label>更正后的发球方
              <select disabled={busy} value={correctedServingSide} onChange={(event) => onCorrectedServingSide(event.target.value as Side)}>
                <option value="A">A 方</option><option value="B">B 方</option>
              </select>
            </label>
          </>
        ) : null}

        {action.kind === "SERVICE_ORDER" ? (
          <label>更正后的发球方
            <select disabled={busy} value={correctedServingSide} onChange={(event) => onCorrectedServingSide(event.target.value as Side)}>
              <option value="A">A 方</option><option value="B">B 方</option>
            </select>
          </label>
        ) : null}

        {action.kind === "SPECIAL" ? (
          <div className="sheet-form-grid">
            <label>特殊结果
              <select disabled={busy} value={specialType} onChange={(event) => onSpecialType(event.target.value as typeof specialType)}>
                <option value="WO">WO</option><option value="RET">RET</option><option value="DSQ">DSQ</option><option value="ABANDONED">ABANDONED</option><option value="BYE">BYE</option>
              </select>
            </label>
            <label>胜方（如适用）
              <select disabled={busy} value={specialWinner} onChange={(event) => onSpecialWinner(event.target.value as "" | Side)}>
                <option value="">无胜方</option><option value="A">A 方</option><option value="B">B 方</option>
              </select>
            </label>
          </div>
        ) : null}

        {!confirmOnly ? <label>必填原因<textarea autoComplete="off" disabled={busy} value={reason} onChange={(event) => onReason(event.target.value)} /></label> : null}
        {error ? <p className="sheet-error" role="alert">{error}</p> : null}
        {preview ? (
          <div className="server-preview" aria-live="polite">
            <strong>服务器预览</strong>
            <span>比分 {preview.before.score.A}:{preview.before.score.B} → {preview.after.score.A}:{preview.after.score.B}</span>
            <span>发球方 {preview.before.servingSide ?? "—"} → {preview.after.servingSide ?? "—"}</span>
            <span>物理端 A {preview.before.physicalEnds?.A ?? "—"} → {preview.after.physicalEnds?.A ?? "—"}</span>
          </div>
        ) : null}

        <div className="sheet-actions">
          {previewable && !preview ? <ActionButton loading={busy} loadingLabel="正在生成预览…" onClick={onPreview}>生成服务器预览</ActionButton> : null}
          {previewable && preview ? <ActionButton loading={busy} loadingLabel="正在提交…" onClick={onConfirmPreview}>确认执行预览结果</ActionButton> : null}
          {action.kind === "SPECIAL" ? <ActionButton loading={busy} loadingLabel="正在记录…" onClick={onSpecialSubmit} variant="danger">确认记录特殊结果</ActionButton> : null}
          {action.kind === "TAKEOVER" || action.kind === "REASON_COMMAND" ? <ActionButton loading={busy} loadingLabel="正在提交…" onClick={onSubmit}>确认提交</ActionButton> : null}
          <ActionButton disabled={busy} onClick={onClose} variant="secondary">取消</ActionButton>
        </div>
      </section>
    </div>
  );
}

/**
 * 阶段操作按 scope 分两处渲染：
 * - URGENT：时机敏感、误藏会影响执裁的操作（抛币、间歇/换边待办、暂停后恢复），保持首屏可见。
 * - SECONDARY：更正、异常结果、提交/复核等次要操作，收进折叠抽屉。
 */
function PhaseActions({ canWrite, chief, scope, state, onSend, onCorrection, onReasonCommand, onServiceOrder, onSpecial }: {
  canWrite: boolean;
  chief: boolean;
  scope: "URGENT" | "SECONDARY";
  state: MatchState;
  onSend: (type: MatchCommand["type"], payload: MatchCommand["payload"]) => Promise<unknown>;
  onCorrection: () => void;
  onReasonCommand: (title: string, type: MatchCommand["type"], payload: MatchCommand["payload"]) => void;
  onServiceOrder: () => void;
  onSpecial: () => void;
}) {
  const urgent = scope === "URGENT";
  const secondary = scope === "SECONDARY";
  return (
    <section className={`phase-actions ${urgent ? "phase-actions-urgent" : "phase-actions-secondary"}`} aria-label={urgent ? "需要立即处理的阶段操作" : "次要阶段操作"}>
      {urgent && state.phase === "AWAITING_COIN_TOSS" ? <>
        {(["A", "B"] as const).flatMap((side) => [
          <button className="button" disabled={!canWrite} key={`${side}-serve`} onClick={() => void onSend("RECORD_COIN_TOSS", { valid: true, winnerSide: side, winnerChoice: { kind: "SERVICE", decision: "SERVE" }, loserChoice: { kind: "END", end: "END_2" } })}>{side} 方胜并选先发</button>,
          <button className="button secondary" disabled={!canWrite} key={`${side}-receive`} onClick={() => void onSend("RECORD_COIN_TOSS", { valid: true, winnerSide: side, winnerChoice: { kind: "SERVICE", decision: "RECEIVE" }, loserChoice: { kind: "END", end: "END_2" } })}>{side} 方胜并选先接</button>,
          <button className="button secondary" disabled={!canWrite} key={`${side}-end`} onClick={() => void onSend("RECORD_COIN_TOSS", { valid: true, winnerSide: side, winnerChoice: { kind: "END", end: "END_1" }, loserChoice: { kind: "SERVICE", decision: "SERVE" } })}>{side} 方胜并选场地端</button>,
        ])}
      </> : null}
      {secondary && state.phase === "AWAITING_OPENING_SETUP" && chief ? <button className="button danger" disabled={!canWrite} onClick={() => onReasonCommand("裁判长作废抛币", "INVALIDATE_COIN_TOSS", { reason: "" })}>裁判长作废抛币</button> : null}
      {urgent ? state.pendingObligations.map((item) => item.type === "INTERVAL" ?
        <button className="button" disabled={!canWrite} key={item.id} onClick={() => void onSend("ACKNOWLEDGE_INTERVAL", { obligationId: item.id })}>确认间歇完成</button> :
        item.type === "CHANGE_ENDS" ? <button className="button secondary" disabled={!canWrite} key={item.id} onClick={() => onReasonCommand("记录漏换边后补做", "RECORD_MISSED_CHANGE_ENDS", { obligationId: item.id, reason: "" })}>记录漏换后补做</button> : null) : null}
      {secondary && (state.phase === "IN_PROGRESS" || state.phase === "OBLIGATIONS_PENDING") ? <>
        <button className="button secondary" disabled={!canWrite} onClick={onCorrection}>更多比分 / 发球权更正</button>
        {state.format === "DOUBLES" ? <button className="button secondary" disabled={!canWrite} onClick={onServiceOrder}>更正发接发顺序</button> : null}
        <button className="button secondary" disabled={!canWrite} onClick={() => onReasonCommand("LET 重发球", "LET", { reason: "" })}>LET 重发球</button>
        <button className="button secondary" disabled={!canWrite} onClick={() => onReasonCommand("暂停比赛", "PAUSE_MATCH", { reason: "" })}>暂停比赛</button>
        <button className="button danger" disabled={!canWrite} onClick={onSpecial}>记录特殊结果</button>
      </> : null}
      {urgent && state.phase === "PAUSED" ? <button className="button" disabled={!canWrite} onClick={() => onReasonCommand("恢复比赛", "RESUME_MATCH", { reason: "" })}>恢复比赛</button> : null}
      {secondary && state.phase === "SPECIAL_OUTCOME_PENDING_SUBMISSION" ? <>
        <button className="button secondary" disabled={!canWrite} onClick={() => onReasonCommand("作废该特殊结果", "INVALIDATE_SPECIAL_OUTCOME", { reason: "" })}>作废该特殊结果</button>
        <button className="button" disabled={!canWrite} onClick={() => onReasonCommand("提交特殊结果复核", "SUBMIT_RESULT", { reason: "" })}>提交结果复核</button>
      </> : null}
      {secondary && state.phase === "MATCH_COMPLETE_PENDING_SUBMISSION" ? <button className="button" disabled={!canWrite} onClick={() => onReasonCommand("提交全场结果", "SUBMIT_RESULT", { reason: "" })}>提交全场结果</button> : null}
      {secondary && state.phase === "SUBMITTED" && chief ? <>
        <button className="button" disabled={!canWrite} onClick={() => onReasonCommand("裁判长复核锁定", "CONFIRM_RESULT", { reason: "" })}>复核锁定</button>
        <button className="button danger" disabled={!canWrite} onClick={() => onReasonCommand("退回补正", "REOPEN_RESULT", { reason: "" })}>退回补正</button>
      </> : null}
      {secondary && state.phase === "CONFIRMED" && chief ? <button className="button danger" disabled={!canWrite} onClick={() => onReasonCommand("受控重开", "REOPEN_RESULT", { reason: "" })}>受控重开</button> : null}
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
  const announcement = [60, 30, 10, 0].includes(remaining) ? `间歇剩余 ${remaining} 秒` : "";
  return (
    <p className="interval-clock">
      间歇提醒 <strong>{Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}</strong>
      <span>归零只提醒，不自动处罚或改分。</span>
      <span aria-atomic="true" aria-live="polite" className="visually-hidden">{announcement}</span>
    </p>
  );
}
