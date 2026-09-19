import { Prisma, type TournamentRole } from "@/generated/prisma/client";
import { prisma } from "@/db/client";
import {
  applyCommand,
  fingerprintMatchCommand,
  stableStringify,
  type MatchCommand,
  type MatchState,
} from "@/domain/rules/match-engine";
import { getMatchAccess } from "@/server/auth/authorization";
import { AppError } from "@/server/services/errors";
import {
  asInputJson,
  hashMatchValue,
  loadVerifiedAggregate,
  MATCH_ENGINE_VERSION,
} from "@/server/services/match-state-service";
import { verifyControlToken } from "@/server/services/scoring-session-service";

export interface ScoringCommandEnvelope {
  commandId: string;
  occurredAt: string;
  expectedVersion: number;
  scoringSessionId: string;
  takeoverGeneration: number;
  type: MatchCommand["type"];
  payload: MatchCommand["payload"];
}

const CHIEF_ONLY = new Set<MatchCommand["type"]>([
  "INVALIDATE_COIN_TOSS",
  "CONFIRM_RESULT",
  "REOPEN_RESULT",
]);

function commandFromEnvelope(envelope: ScoringCommandEnvelope): MatchCommand {
  return {
    commandId: envelope.commandId,
    occurredAt: new Date(envelope.occurredAt).toISOString(),
    type: envelope.type,
    payload: envelope.payload,
  } as MatchCommand;
}

function envelopeFingerprint(matchId: string, envelope: ScoringCommandEnvelope) {
  return hashMatchValue({
    matchId,
    expectedVersion: envelope.expectedVersion,
    occurredAt: envelope.occurredAt,
    type: envelope.type,
    payload: envelope.payload,
  });
}

function assertRoleForCommand(role: TournamentRole, type: MatchCommand["type"]) {
  if (CHIEF_ONLY.has(type) && role !== "CHIEF_REFEREE") {
    throw new AppError(403, "chief_referee_required", "该命令必须由裁判长执行。");
  }
  if (type === "SUBMIT_RESULT" && role !== "REFEREE") {
    throw new AppError(403, "main_referee_required", "结果必须由获指派的主裁判提交。");
  }
}

async function requireController(
  transaction: Prisma.TransactionClient,
  matchId: string,
  actorUserId: string,
  envelope: ScoringCommandEnvelope,
  controlToken: string,
) {
  const session = await transaction.scoringSession.findUnique({ where: { id: envelope.scoringSessionId } });
  const match = await transaction.match.findUniqueOrThrow({
    where: { id: matchId },
    select: {
      controlGeneration: true,
      version: true,
      stage: { select: { competition: { select: { tournamentId: true } } } },
    },
  });
  if (
    !session || session.matchId !== matchId || session.userId !== actorUserId || session.status !== "ACTIVE" ||
    session.expiresAt <= new Date() || session.takeoverGeneration !== envelope.takeoverGeneration ||
    match.controlGeneration !== envelope.takeoverGeneration || !verifyControlToken(controlToken, session.tokenHash)
  ) {
    throw new AppError(409, "not_controller", "控制会话已过期、无效或已被接管。");
  }
  const tournamentId = match.stage.competition.tournamentId;
  const activeRole = await transaction.roleAssignment.findFirst({
    where: { userId: actorUserId, tournamentId, role: session.actingRole },
    select: { id: true },
  });
  if (!activeRole) throw new AppError(403, "role_revoked", "当前会话的赛事角色已被撤销。");
  if (session.actingRole === "REFEREE") {
    const assignment = await transaction.officialAssignment.findFirst({
      where: { matchId, userId: actorUserId, role: "MAIN_REFEREE", active: true },
      select: { id: true },
    });
    if (!assignment) throw new AppError(403, "assignment_revoked", "你的该场主裁判指派已失效。");
  }
  assertRoleForCommand(session.actingRole, envelope.type);
  return { session, match };
}

function lifecycleProjection(state: MatchState) {
  if (state.phase === "PAUSED") return "SUSPENDED" as const;
  if (state.phase === "MATCH_COMPLETE_PENDING_SUBMISSION" || state.phase === "SPECIAL_OUTCOME_PENDING_SUBMISSION") {
    return "ENDED_PENDING_SUBMISSION" as const;
  }
  if (state.phase === "SUBMITTED" || state.phase === "CONFIRMED") return "SUBMITTED" as const;
  if (state.phase === "AWAITING_COIN_TOSS" || state.phase === "AWAITING_OPENING_SETUP") return "READY" as const;
  return "IN_PROGRESS" as const;
}

async function updateProjections(
  transaction: Prisma.TransactionClient,
  matchId: string,
  before: MatchState,
  after: MatchState,
  now: Date,
) {
  const lifecycleStatus = lifecycleProjection(after);
  const outcomeType = after.specialOutcome?.type ??
    (["MATCH_COMPLETE_PENDING_SUBMISSION", "SUBMITTED", "CONFIRMED"].includes(after.phase) ? "NORMAL" : null);
  await transaction.match.update({
    where: { id: matchId },
    data: {
      version: after.version,
      lifecycleStatus,
      outcomeType,
      verificationStatus: after.phase === "CONFIRMED" ? "LOCKED" : after.phase === "SUBMITTED" ? "PENDING_REVIEW" : "UNVERIFIED",
      startedAt: before.phase === "AWAITING_OPENING_SETUP" && after.phase === "IN_PROGRESS" ? now : undefined,
      endedAt: lifecycleStatus === "ENDED_PENDING_SUBMISSION" || lifecycleStatus === "SUBMITTED" ? now : null,
    },
  });
  const completed = new Map(after.completedGames.map((game) => [game.number, game]));
  const gameNumbers = new Set([...completed.keys(), after.currentGame]);
  for (const number of gameNumbers) {
    const game = completed.get(number);
    const scoreA = game?.scoreA ?? (number === after.currentGame ? after.score.A : 0);
    const scoreB = game?.scoreB ?? (number === after.currentGame ? after.score.B : 0);
    await transaction.game.upsert({
      where: { matchId_number: { matchId, number } },
      create: { matchId, number, scoreA, scoreB, completed: Boolean(game) },
      update: { scoreA, scoreB, completed: Boolean(game) },
    });
  }
}

async function updateResultRevision(
  transaction: Prisma.TransactionClient,
  matchId: string,
  actorUserId: string,
  actorRole: TournamentRole,
  command: MatchCommand,
  state: MatchState,
  now: Date,
) {
  if (command.type === "SUBMIT_RESULT") {
    const revision = (await transaction.resultRevision.count({ where: { matchId } })) + 1;
    await transaction.resultRevision.create({
      data: {
        matchId,
        revision,
        status: "PENDING",
        result: asInputJson(state),
        reason: command.payload.reason.trim(),
        actorUserId,
        submittedRole: actorRole,
      },
    });
  }
  if (command.type === "CONFIRM_RESULT") {
    const pending = await transaction.resultRevision.findFirst({
      where: { matchId, status: "PENDING" }, orderBy: { revision: "desc" },
    });
    if (!pending) throw new AppError(409, "result_revision_missing", "找不到待复核的结果修订。");
    if (pending.actorUserId === actorUserId) {
      throw new AppError(409, "independent_review_required", "结果提交人不能同时作为独立复核人。");
    }
    await transaction.resultRevision.update({
      where: { id: pending.id },
      data: { status: "LOCKED", reviewedByUserId: actorUserId, reviewedRole: actorRole, reviewedAt: now, reason: command.payload.reason.trim() },
    });
  }
  if (command.type === "REOPEN_RESULT") {
    const latest = await transaction.resultRevision.findFirst({ where: { matchId }, orderBy: { revision: "desc" } });
    if (latest) {
      await transaction.resultRevision.update({
        where: { id: latest.id },
        data: {
          status: latest.status === "PENDING" ? "RETURNED" : "SUPERSEDED",
          reviewedByUserId: actorUserId,
          reviewedRole: actorRole,
          reviewedAt: now,
          returnedAt: now,
          reason: command.payload.reason.trim(),
        },
      });
    }
  }
}

async function transactWithRetry<T>(work: () => Promise<T>) {
  let attempt = 0;
  while (true) {
    try {
      return await work();
    } catch (error) {
      attempt += 1;
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2034" || attempt >= 3) throw error;
    }
  }
}

export async function previewScoringCommand(
  actorUserId: string,
  matchCode: string,
  envelope: ScoringCommandEnvelope,
  controlToken: string,
) {
  const access = await getMatchAccess(actorUserId, matchCode);
  return prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw`SELECT "id" FROM "matches" WHERE "id" = ${access.id}::uuid FOR UPDATE`;
    const { match } = await requireController(transaction, access.id, actorUserId, envelope, controlToken);
    if (match.version !== envelope.expectedVersion) {
      throw new AppError(409, "conflict", "比赛版本已更新，请先同步权威状态。");
    }
    const aggregate = await loadVerifiedAggregate(transaction, access.id);
    const result = applyCommand(aggregate, commandFromEnvelope(envelope));
    if (result.status === "rejected") throw new AppError(422, result.error.code, result.error.message);
    return {
      status: "preview" as const,
      version: result.aggregate.state.version,
      before: aggregate.state,
      after: result.aggregate.state,
      events: result.events,
      serverTime: new Date().toISOString(),
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function submitScoringCommand(
  actorUserId: string,
  matchCode: string,
  envelope: ScoringCommandEnvelope,
  controlToken: string,
) {
  const access = await getMatchAccess(actorUserId, matchCode);
  return transactWithRetry(() => prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw`SELECT "id" FROM "matches" WHERE "id" = ${access.id}::uuid FOR UPDATE`;
    const { session, match } = await requireController(transaction, access.id, actorUserId, envelope, controlToken);
    const fingerprint = envelopeFingerprint(access.id, envelope);
    const existing = await transaction.matchEvent.findUnique({ where: { commandId: envelope.commandId } });
    if (existing) {
      const existingFingerprint = hashMatchValue({
        matchId: existing.matchId,
        expectedVersion: existing.expectedVersion,
        occurredAt: existing.occurredAt.toISOString(),
        type: existing.type,
        payload: existing.payload,
      });
      if (existing.matchId !== access.id || existingFingerprint !== fingerprint) {
        throw new AppError(409, "command_id_reused", "同一 commandId 不能用于不同命令。");
      }
      if (!existing.response) throw new AppError(409, "command_result_missing", "幂等命令缺少已保存响应。");
      return { ...(structuredClone(existing.response) as object), status: "duplicate" as const };
    }
    if (match.version !== envelope.expectedVersion) {
      throw new AppError(409, "conflict", `比赛版本已从 ${envelope.expectedVersion} 更新为 ${match.version}。`);
    }
    const aggregate = await loadVerifiedAggregate(transaction, access.id);
    if (aggregate.state.version !== match.version) {
      throw new AppError(409, "version_snapshot_mismatch", "比赛版本与权威快照不一致。");
    }
    const command = commandFromEnvelope(envelope);
    const result = applyCommand(aggregate, command);
    if (result.status === "rejected") throw new AppError(422, result.error.code, result.error.message);
    if (result.status === "duplicate") throw new AppError(409, "event_history_duplicate", "内存历史与数据库幂等记录不一致。");
    const event = result.events[0];
    const stateHash = hashMatchValue(result.aggregate.state);
    const now = new Date();
    const response = {
      status: "accepted" as const,
      commandId: command.commandId,
      version: result.aggregate.state.version,
      state: result.aggregate.state,
      events: result.events,
      serverTime: now.toISOString(),
    };
    await transaction.matchEvent.create({
      data: {
        matchId: access.id,
        version: event.version,
        commandId: event.commandId,
        domainEventId: event.eventId,
        expectedVersion: envelope.expectedVersion,
        commandFingerprint: event.commandFingerprint,
        type: event.type,
        payload: asInputJson(event.payload),
        stateBefore: asInputJson(event.stateBefore),
        stateAfter: asInputJson(event.stateAfter),
        stateBeforeHash: hashMatchValue(event.stateBefore),
        stateAfterHash: hashMatchValue(event.stateAfter),
        metadata: event.metadata ? asInputJson(event.metadata) : undefined,
        response: asInputJson(response),
        engineVersion: MATCH_ENGINE_VERSION,
        actorUserId,
        actorRole: session.actingRole,
        scoringSessionId: session.id,
        occurredAt: new Date(command.occurredAt),
      },
    });
    await transaction.matchSnapshot.update({
      where: { matchId: access.id },
      data: { version: result.aggregate.state.version, state: asInputJson(result.aggregate.state), stateHash },
    });
    await updateProjections(transaction, access.id, aggregate.state, result.aggregate.state, now);
    await updateResultRevision(transaction, access.id, actorUserId, session.actingRole, command, result.aggregate.state, now);
    await transaction.auditLog.create({
      data: {
        tournamentId: access.tournamentId,
        actorUserId,
        action: `MATCH_COMMAND_${command.type}`,
        targetType: "Match",
        targetId: access.id,
        outcome: "SUCCESS",
        metadata: { commandId: command.commandId, version: event.version, actingRole: session.actingRole },
      },
    });
    return response;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

export async function getScoringCommandResult(actorUserId: string, matchCode: string, commandId: string) {
  const access = await getMatchAccess(actorUserId, matchCode);
  const event = await prisma.matchEvent.findFirst({ where: { matchId: access.id, commandId }, select: { response: true } });
  if (!event) throw new AppError(404, "command_not_found", "未找到该待确认命令。");
  if (!event.response) throw new AppError(409, "command_result_missing", "命令结果不完整。");
  return { ...(structuredClone(event.response) as object), status: "accepted" as const };
}

export function parseControlToken(header: string | null) {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new AppError(401, "control_token_required", "缺少计分控制令牌。");
  return match[1];
}

export function canonicalCommandForTests(matchId: string, envelope: ScoringCommandEnvelope) {
  return { fingerprint: envelopeFingerprint(matchId, envelope), commandFingerprint: fingerprintMatchCommand(commandFromEnvelope(envelope)), serialized: stableStringify(envelope) };
}
