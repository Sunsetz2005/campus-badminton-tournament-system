import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/db/client";
import { requireAssignedReferee, requireChiefReferee } from "@/server/auth/authorization";
import { logServerEvent } from "@/server/logging";
import { AppError } from "@/server/services/errors";

export const SESSION_LIFETIME_MS = 2 * 60 * 1000;
const DENIED_AUDIT_WINDOW_MS = 60 * 1000;

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function verifyControlToken(token: string, tokenHash: string) {
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(tokenHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function createControlToken() {
  const controlToken = randomBytes(32).toString("base64url");
  return { controlToken, tokenHash: hashToken(controlToken) };
}

function deniedAuditId(userId: string, matchId: string, errorCode: string, occurredAt: Date) {
  const window = Math.floor(occurredAt.getTime() / DENIED_AUDIT_WINDOW_MS);
  const hex = createHash("sha256").update(`${userId}:${matchId}:${errorCode}:${window}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

async function recordDeniedAcquire(userId: string, matchCode: string, error: AppError) {
  try {
    const match = await prisma.match.findUnique({
      where: { code: matchCode },
      select: { id: true, stage: { select: { competition: { select: { tournamentId: true } } } } },
    });
    if (!match) return;
    const occurredAt = new Date();
    await prisma.auditLog.createMany({
      data: [{
        id: deniedAuditId(userId, match.id, error.code, occurredAt),
        tournamentId: match.stage.competition.tournamentId,
        actorUserId: userId,
        action: "SCORING_SESSION_ACQUIRE",
        targetType: "Match",
        targetId: match.id,
        outcome: "DENIED",
        metadata: { matchCode, errorCode: error.code, dedupeWindowSeconds: 60 },
        occurredAt,
      }],
      skipDuplicates: true,
    });
  } catch {
    logServerEvent("audit_log_write_failed", { action: "SCORING_SESSION_ACQUIRE", actorUserId: userId, matchCode });
  }
}

function sessionResponse(session: { id: string; takeoverGeneration: number; expiresAt: Date }, controlToken: string) {
  return {
    sessionId: session.id,
    controlToken,
    takeoverGeneration: session.takeoverGeneration,
    expiresAt: session.expiresAt.toISOString(),
  };
}

export async function acquireScoringSession(userId: string, matchCode: string, deviceSessionId: string) {
  let match: Awaited<ReturnType<typeof requireAssignedReferee>>;
  try {
    match = await requireAssignedReferee(userId, matchCode);
  } catch (error) {
    if (error instanceof AppError && error.status === 403) await recordDeniedAcquire(userId, matchCode, error);
    throw error;
  }
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);
  const { controlToken, tokenHash } = createControlToken();
  try {
    return await prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT "id" FROM "matches" WHERE "id" = ${match.id}::uuid FOR UPDATE`;
      await transaction.scoringSession.updateMany({
        where: { matchId: match.id, status: "ACTIVE", expiresAt: { lte: now } },
        data: { status: "EXPIRED", revokedAt: now, revokedReason: "LEASE_EXPIRED" },
      });
      const active = await transaction.scoringSession.findFirst({ where: { matchId: match.id, status: "ACTIVE" } });
      if (active) {
        if (active.userId !== userId || active.deviceSessionId !== deviceSessionId) {
          throw new AppError(409, "controller_exists", "该比赛当前由另一台设备控制。");
        }
        const resumed = await transaction.scoringSession.update({
          where: { id: active.id },
          data: { tokenHash, expiresAt, lastHeartbeatAt: now },
          select: { id: true, takeoverGeneration: true, expiresAt: true },
        });
        return { status: "resumed" as const, ...sessionResponse(resumed, controlToken), matchVersion: match.version };
      }
      const hadPrior = await transaction.scoringSession.count({ where: { matchId: match.id } });
      const generation = hadPrior
        ? (await transaction.match.update({ where: { id: match.id }, data: { controlGeneration: { increment: 1 } }, select: { controlGeneration: true } })).controlGeneration
        : match.controlGeneration;
      const created = await transaction.scoringSession.create({
        data: { matchId: match.id, userId, deviceSessionId, tokenHash, expiresAt, takeoverGeneration: generation, actingRole: "REFEREE" },
        select: { id: true, takeoverGeneration: true, expiresAt: true },
      });
      await transaction.auditLog.create({
        data: {
          tournamentId: match.tournamentId,
          actorUserId: userId,
          action: "SCORING_SESSION_ACQUIRED",
          targetType: "Match",
          targetId: match.id,
          outcome: "SUCCESS",
          metadata: { matchCode, deviceSessionId, actingRole: "REFEREE", takeoverGeneration: generation },
        },
      });
      return { status: "acquired" as const, ...sessionResponse(created, controlToken), matchVersion: match.version };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError(409, "controller_exists", "该比赛当前已有有效控制会话。");
    }
    throw error;
  }
}

async function requireOwnedSession(userId: string, matchCode: string, sessionId: string, generation: number, token: string) {
  const session = await prisma.scoringSession.findUnique({
    where: { id: sessionId },
    include: { match: { select: { code: true, controlGeneration: true } } },
  });
  if (
    !session || session.match.code !== matchCode || session.userId !== userId || session.status !== "ACTIVE" ||
    session.takeoverGeneration !== generation || session.match.controlGeneration !== generation ||
    session.expiresAt <= new Date() || !verifyControlToken(token, session.tokenHash)
  ) {
    throw new AppError(409, "not_controller", "控制会话已过期、无效或已被接管。");
  }
  return session;
}

export async function heartbeatScoringSession(userId: string, matchCode: string, sessionId: string, generation: number, token: string) {
  const session = await requireOwnedSession(userId, matchCode, sessionId, generation, token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);
  const updated = await prisma.scoringSession.updateMany({
    where: { id: session.id, status: "ACTIVE", takeoverGeneration: generation, expiresAt: { gt: now } },
    data: { lastHeartbeatAt: now, expiresAt },
  });
  if (updated.count !== 1) throw new AppError(409, "not_controller", "控制会话已失效。");
  return { status: "renewed" as const, expiresAt: expiresAt.toISOString(), serverTime: now.toISOString() };
}

export async function releaseScoringSession(userId: string, matchCode: string, sessionId: string, generation: number, token: string) {
  const session = await requireOwnedSession(userId, matchCode, sessionId, generation, token);
  const now = new Date();
  await prisma.scoringSession.update({
    where: { id: session.id },
    data: { status: "REVOKED", revokedAt: now, revokedReason: "RELEASED_BY_CONTROLLER" },
  });
  return { status: "released" as const, serverTime: now.toISOString() };
}

export async function takeoverScoringSession(userId: string, matchCode: string, deviceSessionId: string, reason: string) {
  if (!reason.trim()) throw new AppError(400, "reason_required", "接管必须填写原因。");
  const match = await requireChiefReferee(userId, matchCode);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);
  const { controlToken, tokenHash } = createControlToken();
  return prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw`SELECT "id" FROM "matches" WHERE "id" = ${match.id}::uuid FOR UPDATE`;
    const previous = await transaction.scoringSession.findFirst({ where: { matchId: match.id, status: "ACTIVE" } });
    await transaction.scoringSession.updateMany({
      where: { matchId: match.id, status: "ACTIVE" },
      data: { status: "REVOKED", revokedAt: now, revokedReason: reason.trim() },
    });
    const generation = (await transaction.match.update({
      where: { id: match.id }, data: { controlGeneration: { increment: 1 } }, select: { controlGeneration: true },
    })).controlGeneration;
    const created = await transaction.scoringSession.create({
      data: { matchId: match.id, userId, deviceSessionId, tokenHash, expiresAt, takeoverGeneration: generation, actingRole: "CHIEF_REFEREE" },
      select: { id: true, takeoverGeneration: true, expiresAt: true },
    });
    await transaction.auditLog.create({
      data: {
        tournamentId: match.tournamentId,
        actorUserId: userId,
        action: "SCORING_SESSION_TAKEOVER",
        targetType: "Match",
        targetId: match.id,
        outcome: "SUCCESS",
        metadata: {
          matchCode,
          reason: reason.trim(),
          actingRole: "CHIEF_REFEREE",
          previousSessionId: previous?.id ?? null,
          takeoverGeneration: generation,
        },
      },
    });
    return { status: "taken_over" as const, ...sessionResponse(created, controlToken), matchVersion: match.version };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
