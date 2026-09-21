import { createHash } from "node:crypto";

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/db/client";
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
import { validateRuleConfig } from "@/domain/rules/rule-profile";
import { getMatchAccess } from "@/server/auth/authorization";
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
  return { ...match, sideAEntry: match.sideAEntry, sideBEntry: match.sideBEntry, ruleSnapshot: match.ruleSnapshot };
}

export async function ensureMatchSnapshot(transaction: Transaction, matchId: string) {
  const existing = await transaction.matchSnapshot.findUnique({ where: { matchId } });
  if (existing) return existing;
  const match = await loadMatchFacts(transaction, matchId);
  const initial = createMatchAggregate({
    matchId: match.id,
    format: match.stage.competition.entryType,
    players: {
      A: match.sideAEntry.members.map((item) => item.participantId),
      B: match.sideBEntry.members.map((item) => item.participantId),
    },
    ruleConfig: validateRuleConfig(match.ruleSnapshot.config),
    ruleConfigHash: match.ruleSnapshot.configHash,
  }).state;
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
  const records = await transaction.matchEvent.findMany({ where: { matchId }, orderBy: { version: "asc" } });
  const events = records.map(domainEventFromRecord);
  const replayed = replayMatch(initialState, events);
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
  return prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw`SELECT "id" FROM "matches" WHERE "id" = ${access.id}::uuid FOR UPDATE`;
    const match = await loadMatchFacts(transaction, access.id);
    /*
     * 轮询路径的最小优化（R3 性能核验）：`matches.version` 与事件写入在同一事务里更新，
     * 在行锁内读到的版本就是权威版本。版本未变时不返回任何比赛状态，
     * 因此可以先回答 unchanged，再决定是否付出全量重放的代价。
     * 写入路径与返回快照的读取路径仍然完整重放并校验哈希，行锁和完整性校验都没有被删除。
     */
    const unchanged = afterVersion !== undefined && afterVersion === match.version;
    const aggregate = unchanged ? null : await loadVerifiedAggregate(transaction, access.id);
    const active = await transaction.scoringSession.findFirst({
      where: { matchId: access.id, status: "ACTIVE", expiresAt: { gt: new Date() } },
      select: { id: true, userId: true, deviceSessionId: true, actingRole: true, expiresAt: true, takeoverGeneration: true },
    });
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
          }
        : { active: false },
      access: { assignedReferee: access.assignedReferee, chiefReferee: access.chiefReferee },
    };
    if (!aggregate) return { status: "unchanged" as const, ...common };
    if (afterVersion === aggregate.state.version) return { status: "unchanged" as const, ...common };
    return {
      status: "snapshot" as const,
      ...common,
      match: {
        code: match.code,
        competitionName: match.stage.competition.name,
        courtName: match.court?.name ?? null,
        scheduledAt: match.scheduledAt?.toISOString() ?? null,
        sideAName: match.sideAEntry!.displayName,
        sideBName: match.sideBEntry!.displayName,
        playerNames: Object.fromEntries(
          [...match.sideAEntry!.members, ...match.sideBEntry!.members].map((item) => [item.participantId, item.participant.displayName]),
        ),
        lifecycleStatus: match.lifecycleStatus,
        verificationStatus: match.verificationStatus,
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
}
