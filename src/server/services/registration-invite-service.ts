import { createHash, createHmac, randomBytes } from "node:crypto";

import { z } from "zod";

import { prisma } from "@/db/client";
import { normalizeText } from "@/domain/registration/registration-rules";
import { zonedLocalToUtc } from "@/domain/time/zoned-time";
import { requireManagedTournament } from "@/server/auth/authorization";
import { requireEnvironment } from "@/server/config/runtime";
import { AppError } from "@/server/services/errors";
import {
  insertRegistration,
  lockedCompetitionIds,
  lockTournamentRow,
  mapRegistrationWriteError,
  parseNote,
  validateMembersOrThrow,
} from "@/server/services/registration-service";

/**
 * 匿名邀请链接。
 *
 * - 不开放公众注册：提交者不登录、不建账号（`disableSignUp` 保持 true），只生成「待审核」报名。
 * - 令牌 256 位随机数，库内只存 SHA-256 摘要；明文只在创建时返回一次。
 * - 频率限制分两层：按「邀请 + 来源指纹」限流（尽力而为，来源地址在无反向代理时可被伪造），
 *   以及按邀请的总量和短时窗口限流（不可伪造，是真正的上限）。
 */

export const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const INVITE_MAX_DAYS = 90;
export const INVITE_LIMITS = {
  perSourceWindowMs: 10 * 60 * 1000,
  perSourceMax: 5,
  perInviteWindowMs: 60 * 1000,
  perInviteMax: 30,
} as const;

export function hashInviteToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/** 来源指纹：对来源地址做带密钥的 HMAC，不保存原始 IP。 */
export function sourceFingerprint(source: string) {
  return createHmac("sha256", requireEnvironment("BETTER_AUTH_SECRET"))
    .update(`registration-source:${source}`)
    .digest("hex")
    .slice(0, 32);
}

const createInviteSchema = z.object({
  label: z.string(),
  expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "截止时间格式应为 YYYY-MM-DDTHH:mm"),
  maxSubmissions: z.number().int().min(1).max(2000),
});

export async function createRegistrationInvite(actorUserId: string, slug: string, rawInput: unknown, now = new Date()) {
  const { tournament } = await requireManagedTournament(actorUserId, slug);
  const parsed = createInviteSchema.safeParse(rawInput);
  if (!parsed.success) throw new AppError(400, "invalid_input", parsed.error.issues[0]?.message ?? "邀请链接设置无效。");
  const label = normalizeText(parsed.data.label);
  if (!label || [...label].length > 40) throw new AppError(400, "invalid_input", "链接名称应为 1—40 个字符。");
  const expiresAt = zonedLocalToUtc(parsed.data.expiresAt, tournament.timezone);
  if (!expiresAt) throw new AppError(400, "invalid_input", "失效时间在赛事时区不存在。");
  if (expiresAt <= now) throw new AppError(400, "invalid_input", "失效时间必须晚于现在。");
  if (expiresAt.getTime() - now.getTime() > INVITE_MAX_DAYS * 86_400_000) {
    throw new AppError(400, "invalid_input", `邀请链接有效期最长 ${INVITE_MAX_DAYS} 天。`);
  }
  if (tournament.phase === "RUNNING" || tournament.phase === "FINISHED") {
    throw new AppError(409, "tournament_locked", "赛事已开赛或结束，不能再创建报名链接。");
  }

  const token = randomBytes(32).toString("base64url");
  const invite = await prisma.$transaction(async (transaction) => {
    const created = await transaction.registrationInvite.create({
      data: {
        tournamentId: tournament.id,
        label,
        tokenHash: hashInviteToken(token),
        tokenHint: token.slice(0, 4),
        expiresAt,
        maxSubmissions: parsed.data.maxSubmissions,
        createdByUserId: actorUserId,
      },
      select: { id: true, label: true, expiresAt: true, maxSubmissions: true },
    });
    await transaction.auditLog.create({
      data: {
        tournamentId: tournament.id,
        actorUserId,
        action: "REGISTRATION_INVITE_CREATED",
        targetType: "RegistrationInvite",
        targetId: created.id,
        outcome: "SUCCESS",
        metadata: { label, expiresAt: expiresAt.toISOString(), maxSubmissions: parsed.data.maxSubmissions },
      },
    });
    return created;
  });
  return { invite, token };
}

export async function revokeRegistrationInvite(actorUserId: string, slug: string, inviteId: string) {
  const { tournament } = await requireManagedTournament(actorUserId, slug);
  await prisma.$transaction(async (transaction) => {
    const updated = await transaction.registrationInvite.updateMany({
      where: { id: inviteId, tournamentId: tournament.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (updated.count !== 1) throw new AppError(404, "invite_not_found", "邀请链接不存在或已停用。");
    await transaction.auditLog.create({
      data: {
        tournamentId: tournament.id,
        actorUserId,
        action: "REGISTRATION_INVITE_REVOKED",
        targetType: "RegistrationInvite",
        targetId: inviteId,
        outcome: "SUCCESS",
      },
    });
  });
}

export type InviteAvailability =
  | { state: "INVALID" }
  | {
      state: "OPEN" | "NOT_YET_OPEN" | "CLOSED";
      invite: { id: string; label: string; expiresAt: Date };
      tournament: {
        id: string;
        name: string;
        subtitle: string | null;
        venue: string | null;
        timezone: string;
        regulations: string | null;
        registrationOpensAt: Date | null;
        registrationClosesAt: Date | null;
      };
      competitions: { id: string; code: string; name: string; entryType: "SINGLES" | "DOUBLES" }[];
    };

/**
 * 解析邀请令牌。令牌格式错误、不存在、已停用、已过期或名额用尽，一律返回同一个 INVALID，
 * 不区分原因，避免成为猜测令牌的旁路。令牌有效时才说明报名开放状态。
 */
export async function resolveInvite(token: string, now = new Date()): Promise<InviteAvailability> {
  if (!INVITE_TOKEN_PATTERN.test(token)) return { state: "INVALID" };
  const invite = await prisma.registrationInvite.findUnique({
    where: { tokenHash: hashInviteToken(token) },
    select: {
      id: true,
      label: true,
      expiresAt: true,
      revokedAt: true,
      maxSubmissions: true,
      submissionCount: true,
      tournament: {
        select: {
          id: true,
          name: true,
          subtitle: true,
          venue: true,
          timezone: true,
          regulations: true,
          phase: true,
          registrationOpensAt: true,
          registrationClosesAt: true,
          competitions: {
            select: { id: true, code: true, name: true, entryType: true },
            orderBy: { code: "asc" },
          },
        },
      },
    },
  });
  if (!invite || invite.revokedAt || invite.expiresAt <= now || invite.submissionCount >= invite.maxSubmissions) {
    return { state: "INVALID" };
  }
  const { tournament } = invite;
  let state: "OPEN" | "NOT_YET_OPEN" | "CLOSED" = "OPEN";
  if (tournament.phase === "PREPARING") state = "NOT_YET_OPEN";
  else if (tournament.phase !== "REGISTRATION_OPEN") state = "CLOSED";
  else if (tournament.registrationOpensAt && now < tournament.registrationOpensAt) state = "NOT_YET_OPEN";
  else if (tournament.registrationClosesAt && now >= tournament.registrationClosesAt) state = "CLOSED";

  return {
    state,
    invite: { id: invite.id, label: invite.label, expiresAt: invite.expiresAt },
    tournament: {
      id: tournament.id,
      name: tournament.name,
      subtitle: tournament.subtitle,
      venue: tournament.venue,
      timezone: tournament.timezone,
      regulations: tournament.regulations,
      registrationOpensAt: tournament.registrationOpensAt,
      registrationClosesAt: tournament.registrationClosesAt,
    },
    competitions: tournament.competitions,
  };
}

const submissionSchema = z.object({
  competitionId: z.string().uuid(),
  members: z.array(z.record(z.string(), z.unknown())).min(1).max(2),
  note: z.string().nullish(),
  consent: z.literal(true),
  // 蜜罐字段：真人看不到，填了就是脚本。
  website: z.string().max(0).optional(),
});

/** 公开提交。返回回执编号；报名状态只能由组织方在后台查看，公开端不提供查询。 */
export async function submitInviteRegistration(token: string, rawInput: unknown, source: string, now = new Date()) {
  const availability = await resolveInvite(token, now);
  if (availability.state === "INVALID") {
    throw new AppError(404, "invite_invalid", "报名链接无效或已失效，请联系赛事组织方。");
  }
  if (availability.state !== "OPEN") {
    throw new AppError(409, "registration_closed", "当前不在报名时间内。");
  }
  const parsed = submissionSchema.safeParse(rawInput);
  if (!parsed.success) {
    const consentMissing = parsed.error.issues.some((issue) => issue.path[0] === "consent");
    throw new AppError(
      400,
      consentMissing ? "consent_required" : "invalid_input",
      consentMissing ? "请阅读并同意个人信息使用说明。" : "报名信息格式无效。",
    );
  }
  const competition = availability.competitions.find((item) => item.id === parsed.data.competitionId);
  if (!competition) throw new AppError(400, "invalid_input", "请选择本赛事的比赛项目。");
  const members = validateMembersOrThrow(competition.entryType, parsed.data.members);
  const note = parseNote(parsed.data.note);
  const fingerprint = sourceFingerprint(source);
  const { invite, tournament } = availability;

  try {
    return await prisma.$transaction(async (transaction) => {
      await lockTournamentRow(transaction, tournament.id);
      const phase = await transaction.tournament.findUniqueOrThrow({ where: { id: tournament.id }, select: { phase: true } });
      if (phase.phase !== "REGISTRATION_OPEN") throw new AppError(409, "registration_closed", "当前不在报名时间内。");
      const locked = await lockedCompetitionIds(transaction, phase.phase, [competition.id]);
      if (locked.has(competition.id)) throw new AppError(409, "registration_closed", "该项目已停止接受报名。");

      const [fromSource, burst] = await Promise.all([
        transaction.registration.count({
          where: {
            inviteId: invite.id,
            submitterFingerprint: fingerprint,
            createdAt: { gte: new Date(now.getTime() - INVITE_LIMITS.perSourceWindowMs) },
          },
        }),
        transaction.registration.count({
          where: { inviteId: invite.id, createdAt: { gte: new Date(now.getTime() - INVITE_LIMITS.perInviteWindowMs) } },
        }),
      ]);
      if (fromSource >= INVITE_LIMITS.perSourceMax || burst >= INVITE_LIMITS.perInviteMax) {
        throw new AppError(429, "rate_limited", "提交过于频繁，请稍后再试。");
      }
      // 名额与有效期在同一条条件更新里原子校验，并发提交不会超出上限。
      const consumed = await transaction.$executeRaw`
        UPDATE "registration_invites"
        SET "submissionCount" = "submissionCount" + 1, "updatedAt" = now()
        WHERE "id" = ${invite.id}::uuid
          AND "revokedAt" IS NULL
          AND "expiresAt" > ${now}
          AND "submissionCount" < "maxSubmissions"`;
      if (consumed !== 1) throw new AppError(404, "invite_invalid", "报名链接无效或已失效，请联系赛事组织方。");

      const registration = await insertRegistration(transaction, {
        tournamentId: tournament.id,
        competition,
        members,
        source: "INVITE",
        note,
        inviteId: invite.id,
        submitterFingerprint: fingerprint,
      });
      await transaction.auditLog.create({
        data: {
          tournamentId: tournament.id,
          action: "REGISTRATION_SUBMITTED_VIA_INVITE",
          targetType: "Registration",
          targetId: registration.id,
          outcome: "SUCCESS",
          metadata: { inviteId: invite.id, referenceCode: registration.referenceCode },
        },
      });
      return { referenceCode: registration.referenceCode, competitionName: competition.name };
    });
  } catch (error) {
    return mapRegistrationWriteError(error);
  }
}

/**
 * 取来源地址。只在没有可信反向代理时使用：`x-forwarded-for` 可被客户端伪造，
 * 所以它只用于「尽力而为」的按来源限流，真正的上限是按邀请的总量与短时窗口。
 */
export function requestSource(headers: Headers) {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers.get("x-real-ip")?.trim() || "unknown";
}
