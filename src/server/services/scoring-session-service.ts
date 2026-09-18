import { createHash, randomBytes } from "node:crypto";

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/db/client";
import { requireAssignedReferee } from "@/server/auth/authorization";
import { AppError } from "@/server/services/errors";

const SESSION_LIFETIME_MS = 2 * 60 * 1000;

export async function acquireScoringSession(userId: string, matchCode: string, deviceSessionId: string) {
  const match = await requireAssignedReferee(userId, matchCode);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);
  const controlToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(controlToken).digest("hex");

  try {
    const session = await prisma.$transaction(async (transaction) => {
      await transaction.scoringSession.updateMany({
        where: { matchId: match.id, status: "ACTIVE", expiresAt: { lte: now } },
        data: { status: "EXPIRED" },
      });
      const active = await transaction.scoringSession.findFirst({
        where: { matchId: match.id, status: "ACTIVE" },
        select: { userId: true, deviceSessionId: true, expiresAt: true },
      });
      if (active) {
        const sameController = active.userId === userId && active.deviceSessionId === deviceSessionId;
        throw new AppError(
          409,
          "controller_exists",
          sameController ? "该设备已有有效控制会话，请继续使用原会话。" : "该比赛当前由另一台设备控制。",
        );
      }

      const created = await transaction.scoringSession.create({
        data: {
          matchId: match.id,
          userId,
          deviceSessionId,
          tokenHash,
          expiresAt,
        },
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
          metadata: { matchCode, deviceSessionId },
        },
      });
      return created;
    });

    return {
      status: "acquired" as const,
      sessionId: session.id,
      controlToken,
      takeoverGeneration: session.takeoverGeneration,
      expiresAt: session.expiresAt.toISOString(),
      matchVersion: match.version,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError(409, "controller_exists", "该比赛当前已有有效控制会话。");
    }
    throw error;
  }
}
