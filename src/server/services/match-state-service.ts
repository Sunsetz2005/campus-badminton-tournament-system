import { createHash } from "node:crypto";

import { Prisma, type CompetitionKind, type EntryType } from "@/generated/prisma/client";
import { runTransaction } from "@/server/services/transaction";
import {
  createMatchAggregate,
  downgradeMatchStateToEngineV1,
  normalizeMatchState,
  replayMatch,
  stableStringify,
  type MatchAggregate,
  type MatchEvent as DomainMatchEvent,
  type MatchState,
} from "@/domain/rules/match-engine";
import { COMPETITION_KIND_ENTRY_TYPE, type RegistrationCompetitionKind } from "@/domain/registration/registration-rules";
import { RUBBER_LABEL, type RubberKind } from "@/domain/registration/team-roster";
import { validateRuleConfig } from "@/domain/rules/rule-profile";
import { getMatchAccess } from "@/server/auth/authorization";
import { officiatingNameRequired } from "@/server/services/officiating-record";
import { AppError } from "@/server/services/errors";

/**
 * 引擎版本 2：MatchState 增加 thresholdObligationsIssued（R3-001）。
 * v1 的历史事件一律保持原样不改写；重放时按记录形状核对，权威快照在下一次写入时升级。
 */
export const MATCH_ENGINE_VERSION = 2;

export function hashMatchValue(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function asInputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export function asMatchState(value: Prisma.JsonValue): MatchState {
  return structuredClone(value) as unknown as MatchState;
}

type Transaction = Prisma.TransactionClient;

/**
 * 计分格式：个人项目取项目的单/双打类型；团体项目的每个小场按小场类型（男单/男双…）决定。
 */
export function matchFormatOf(competitionEntryType: EntryType, rubberKind: CompetitionKind | null): "SINGLES" | "DOUBLES" {
  if (competitionEntryType !== "TEAM") return competitionEntryType;
  if (!rubberKind || !(rubberKind in COMPETITION_KIND_ENTRY_TYPE)) {
    throw new AppError(409, "match_not_ready", "团体小场缺少小场类型，不能计分。");
  }
  return COMPETITION_KIND_ENTRY_TYPE[rubberKind as RegistrationCompetitionKind];
}

async function loadMatchFacts(transaction: Transaction, matchId: string) {
  const match = await transaction.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      code: true,
      version: true,
      controlGeneration: true,
      lifecycleStatus: true,
      verificationStatus: true,
      outcomeType: true,
      rubberKind: true,
      rubberOrder: true,
      notPlayedAt: true,
      awaitingCourtSince: true,
      coinTossDrawSide: true,
      coinTossDrawVersion: true,
      coinTossDrawnAt: true,
      fixture: { select: { lineupsRevealedAt: true } },
      players: {
        orderBy: [{ side: "asc" }, { slot: "asc" }],
        select: { side: true, participantId: true, participant: { select: { displayName: true } } },
      },
      scheduledAt: true,
      startedAt: true,
      endedAt: true,
      court: { select: { name: true } },
      stage: {
        select: {
          competition: {
            select: { name: true, entryType: true, tournamentId: true },
          },
        },
      },
      sideAEntry: {
        select: {
          displayName: true,
          members: { orderBy: { slot: "asc" }, select: { participantId: true, participant: { select: { displayName: true } } } },
        },
      },
      sideBEntry: {
        select: {
          displayName: true,
          members: { orderBy: { slot: "asc" }, select: { participantId: true, participant: { select: { displayName: true } } } },
        },
      },
      ruleSnapshot: { select: { config: true, configHash: true } },
    },
  });
  if (!match) throw new AppError(404, "match_not_found", "比赛不存在。");
  if (!match.sideAEntry || !match.sideBEntry || !match.ruleSnapshot) {
    throw new AppError(409, "match_not_ready", "比赛名单或冻结规则尚未准备完成。");
  }
  // 个人项目：上场队员就是报名单位成员。团体小场：上场队员来自双方已公开并锁定的出场名单。
  let lineup: { A: { participantId: string; displayName: string }[]; B: { participantId: string; displayName: string }[] };
  if (match.rubberKind) {
    if (match.notPlayedAt) throw new AppError(409, "rubber_not_played", "这场比赛不再进行：团体对抗胜负已定，或对手空缺已直接晋级。");
    if (!match.fixture?.lineupsRevealedAt) {
      throw new AppError(409, "match_not_ready", "双方出场名单尚未交齐，小场不能开始计分。");
    }
    const pick = (side: "A" | "B") =>
      match.players.filter((item) => item.side === side).map((item) => ({ participantId: item.participantId, displayName: item.participant.displayName }));
    lineup = { A: pick("A"), B: pick("B") };
    if (!lineup.A.length || !lineup.B.length) throw new AppError(409, "match_not_ready", "该小场缺少上场队员。");
  } else {
    const pick = (entry: NonNullable<typeof match.sideAEntry>) =>
      entry.members.map((item) => ({ participantId: item.participantId, displayName: item.participant.displayName }));
    lineup = { A: pick(match.sideAEntry), B: pick(match.sideBEntry) };
  }
  return { ...match, sideAEntry: match.sideAEntry, sideBEntry: match.sideBEntry, ruleSnapshot: match.ruleSnapshot, lineup };
}

export async function ensureMatchSnapshot(transaction: Transaction, matchId: string) {
  const existing = await transaction.matchSnapshot.findUnique({ where: { matchId } });
  if (existing) return existing;
  const match = await loadMatchFacts(transaction, matchId);
  let initial: MatchState;
  try {
    initial = createMatchAggregate({
      matchId: match.id,
      format: matchFormatOf(match.stage.competition.entryType, match.rubberKind),
      players: {
        A: match.lineup.A.map((item) => item.participantId),
        B: match.lineup.B.map((item) => item.participantId),
      },
      ruleConfig: validateRuleConfig(match.ruleSnapshot.config),
      ruleConfigHash: match.ruleSnapshot.configHash,
    }).state;
  } catch (error) {
    // 名单人数与单/双打不符、冻结规则与哈希不一致等：属于比赛未就绪，不是程序错误。
    if (error instanceof AppError) throw error;
    throw new AppError(409, "match_not_ready", "比赛名单或冻结规则不完整，暂时不能计分。请联系管理员核查。");
  }
  const stateHash = hashMatchValue(initial);
  const snapshot = await transaction.matchSnapshot.create({
    data: {
      matchId,
      version: initial.version,
      engineVersion: MATCH_ENGINE_VERSION,
      initialState: asInputJson(initial),
      initialStateHash: stateHash,
      state: asInputJson(initial),
      stateHash,
    },
  });
  if (match.version !== 0) {
    throw new AppError(409, "snapshot_missing", "比赛已有版本但缺少权威快照，已停止写入。");
  }
  return snapshot;
}

const REPLAY_EVENT_SELECT = {
  id: true,
  domainEventId: true,
  version: true,
  commandId: true,
  commandFingerprint: true,
  occurredAt: true,
  type: true,
  payload: true,
  stateBefore: true,
  stateAfter: true,
  metadata: true,
} satisfies Prisma.MatchEventSelect;

export function domainEventFromRecord(event: {
  id: string;
  domainEventId: string | null;
  version: number;
  commandId: string | null;
  commandFingerprint: string | null;
  occurredAt: Date;
  type: string;
  payload: Prisma.JsonValue;
  stateBefore: Prisma.JsonValue | null;
  stateAfter: Prisma.JsonValue | null;
  metadata: Prisma.JsonValue | null;
}): DomainMatchEvent {
  if (!event.commandId || !event.commandFingerprint || !event.stateBefore || !event.stateAfter) {
    throw new AppError(409, "event_history_incomplete", "比赛历史缺少可重放字段，已停止写入。");
  }
  return {
    eventId: event.domainEventId ?? `${event.commandId}:event`,
    version: event.version,
    commandId: event.commandId,
    commandFingerprint: event.commandFingerprint,
    occurredAt: event.occurredAt.toISOString(),
    type: event.type as DomainMatchEvent["type"],
    payload: structuredClone(event.payload) as DomainMatchEvent["payload"],
    reversible: event.type === "RALLY_WON",
    stateBefore: asMatchState(event.stateBefore),
    stateAfter: asMatchState(event.stateAfter),
    ...(event.metadata ? { metadata: structuredClone(event.metadata) as DomainMatchEvent["metadata"] } : {}),
  };
}

export async function loadVerifiedAggregate(transaction: Transaction, matchId: string): Promise<MatchAggregate> {
  const snapshot = await ensureMatchSnapshot(transaction, matchId);
  const initialState = asMatchState(snapshot.initialState);
  if (hashMatchValue(initialState) !== snapshot.initialStateHash) {
    throw new AppError(409, "initial_state_corrupted", "比赛初始状态校验失败，已停止写入。");
  }
  // 只取重放需要的列：每条事件另存的完整响应与哈希列不参与重放，读出来只是白占内存与传输。
  const records = await transaction.matchEvent.findMany({
    where: { matchId },
    orderBy: { version: "asc" },
    select: REPLAY_EVENT_SELECT,
  });
  const events = records.map(domainEventFromRecord);
  let replayed: MatchState;
  try {
    replayed = replayMatch(initialState, events);
  } catch (error) {
    // 引擎的规则异常不是 AppError；不转换的话，历史损坏在接口上只会表现为笼统的 500。
    if (error instanceof AppError) throw error;
    const code = (error as { code?: unknown }).code;
    throw new AppError(409, "event_history_unreplayable", "比赛历史无法按规则重放，已停止写入。请联系管理员核查。", {
      ...(typeof code === "string" ? { engineCode: code } : {}),
    });
  }
  const stored = asMatchState(snapshot.state);
  // 引擎 v1 写下的快照按 v1 形状核对；核对通过后聚合继续使用 v2 状态，历史事件不被改写。
  const legacySnapshot = snapshot.engineVersion < MATCH_ENGINE_VERSION;
  const comparable = legacySnapshot ? downgradeMatchStateToEngineV1(replayed) : replayed;
  if (
    snapshot.version !== replayed.version ||
    hashMatchValue(comparable) !== snapshot.stateHash ||
    stableStringify(comparable) !== stableStringify(stored)
  ) {
    throw new AppError(409, "authoritative_state_corrupted", "事件重放与权威快照不一致，已停止写入。");
  }
  return { initialState: normalizeMatchState(initialState), state: replayed, events };
}

export async function getAuthoritativeMatchState(userId: string, matchCode: string, afterVersion?: number) {
  const access = await getMatchAccess(userId, matchCode);
  /*
   * 读取路径对比赛行只加共享锁（`FOR SHARE`），不再加 `FOR UPDATE`：裁判台与裁判长每隔几秒轮询一次，
   * 排他锁让这些只读请求彼此排队。共享锁之间互不阻塞，但仍会等待正在提交的记分事务，
   * 所以读到的一定是「已提交的最新版本」——工作台与端到端用例都依赖这一点（刚写完立刻读，不能读到上一版）。
   * 唯一的例外是比赛还没有权威快照：首次读取会创建它（一次写入），这时改用排他锁重读一次，避免两个请求同时创建
   * （未开赛的团体小场换人后快照会被删掉重建，所以「有没有快照」在拿到锁之后判断）。
   */
  const read = (exclusive: boolean) => runTransaction(async (transaction) => {
    if (exclusive) {
      await transaction.$queryRaw`SELECT "id" FROM "matches" WHERE "id" = ${access.id}::uuid FOR UPDATE`;
    } else {
      await transaction.$queryRaw`SELECT "id" FROM "matches" WHERE "id" = ${access.id}::uuid FOR SHARE`;
      if (!(await transaction.matchSnapshot.findUnique({ where: { matchId: access.id }, select: { matchId: true } }))) return null;
    }
    const match = await loadMatchFacts(transaction, access.id);
    /*
     * 轮询路径的最小优化（R3 性能核验）：`matches.version` 与事件写入在同一事务里更新，
     * 在行锁内读到的版本就是权威版本。版本未变时不返回任何比赛状态，
     * 因此可以先回答 unchanged，再决定是否付出全量重放的代价。
     * 写入路径与返回快照的读取路径仍然完整重放并校验哈希，完整性校验没有被删除。
     */
    const unchanged = afterVersion !== undefined && afterVersion === match.version;
    const aggregate = unchanged ? null : await loadVerifiedAggregate(transaction, access.id);
    const active = await transaction.scoringSession.findFirst({
      where: { matchId: access.id, status: "ACTIVE", expiresAt: { gt: new Date() } },
      select: { id: true, userId: true, deviceSessionId: true, actingRole: true, expiresAt: true, takeoverGeneration: true, officiatingName: true },
    });
    const tournament = await transaction.tournament.findUniqueOrThrow({ where: { id: access.tournamentId }, select: { refereeMode: true } });
    const viewer = await transaction.user.findUniqueOrThrow({ where: { id: userId }, select: { platformReferee: true } });
    const common = {
      serverTime: new Date().toISOString(),
      version: aggregate ? aggregate.state.version : match.version,
      control: active
        ? {
            active: true,
            sessionId: active.id,
            ownedByCurrentUser: active.userId === userId,
            deviceSessionId: active.deviceSessionId,
            actingRole: active.actingRole,
            expiresAt: active.expiresAt.toISOString(),
            takeoverGeneration: active.takeoverGeneration,
            officiatingName: active.officiatingName,
          }
        : { active: false },
      access: {
        assignedReferee: access.assignedReferee,
        chiefReferee: access.chiefReferee,
        // 共用裁判账号模式，或当前登录的是平台共用裁判账号：取得控制前须填写本人姓名（O-2 / 方案 B2）。
        officiatingNameRequired: officiatingNameRequired(tournament.refereeMode, viewer.platformReferee),
      },
      // 离场待续（S-9）不改比赛版本，放在每次轮询都返回的部分。
      awaitingCourt: Boolean(match.awaitingCourtSince),
      // 转场与离场也不改版本：当前场地随每次轮询返回，工作台标题不会停在旧场地。
      currentCourtName: match.court?.name ?? null,
    };
    if (!aggregate) return { status: "unchanged" as const, ...common };
    if (afterVersion === aggregate.state.version) return { status: "unchanged" as const, ...common };
    return {
      status: "snapshot" as const,
      ...common,
      match: {
        code: match.code,
        // 团体小场在项目名后标出第几场什么小场，裁判台据此核对。
        competitionName: match.rubberKind
          ? `${match.stage.competition.name} · 第 ${match.rubberOrder} 场${RUBBER_LABEL[match.rubberKind as RubberKind]}`
          : match.stage.competition.name,
        courtName: match.court?.name ?? null,
        scheduledAt: match.scheduledAt?.toISOString() ?? null,
        sideAName: match.sideAEntry!.displayName,
        sideBName: match.sideBEntry!.displayName,
        playerNames: Object.fromEntries(
          [...match.lineup.A, ...match.lineup.B].map((item) => [item.participantId, item.displayName]),
        ),
        rubber: match.rubberKind ? { kind: match.rubberKind, order: match.rubberOrder } : null,
        lifecycleStatus: match.lifecycleStatus,
        verificationStatus: match.verificationStatus,
        // 只返回对当前版本仍有效的系统抛币结果（裁判长作废抛币后旧结果失效）。
        coinTossDraw: match.coinTossDrawSide && match.coinTossDrawVersion === aggregate.state.version
          ? { winnerSide: match.coinTossDrawSide, drawnAt: match.coinTossDrawnAt!.toISOString(), version: match.coinTossDrawVersion }
          : null,
      },
      state: aggregate.state,
      events: aggregate.events.slice(-30).map((event) => ({
        commandId: event.commandId,
        version: event.version,
        type: event.type,
        occurredAt: event.occurredAt,
        metadata: event.metadata,
      })),
    };
  });
  return (await read(false)) ?? (await read(true))!;
}
