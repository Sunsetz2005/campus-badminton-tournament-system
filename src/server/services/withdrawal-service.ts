import { z } from "zod";

import type { MatchSide, Prisma } from "@/generated/prisma/client";
import { normalizeReason } from "@/domain/registration/registration-rules";
import { requireManagedTournament } from "@/server/auth/authorization";
import { AppError } from "@/server/services/errors";
import { lockTournamentRow } from "@/server/services/registration-service";
import { recordRefereeWalkover } from "@/server/services/results-service";
import { isStarted, setFixtureSide, settleTeamFixture } from "@/server/services/team-tie-service";
import { runTransaction } from "@/server/services/transaction";

/**
 * 退出与取消资格（赛务口径 W-2、W-4、W-7，2026-10-27）。只有裁判长能登记，必须写原因。
 *
 * - 选手退出（GCR 13.6.1）或被取消资格（ITTO 3.6.2.2）对整个赛事生效：其所在个人项目报名单位未开始的比赛
 *   以 WO 判给对手；对手尚未产生的后续签位记为空位（K-1，对手产生后直接晋级）；已打完的结果不改写；
 *   小组成绩随之按 GCR 16.2.5 自动删除。双打搭档在其他项目照常。
 * - 团体项目：该队员排在里面、尚未开始的小场按认输计，之后的对抗不能再选他（GCR 13.6.3）。
 * - 团体报名单位整体退出（GCR 16.3.7）：未开始的对抗全部按认输计，小组成绩删除，后续签位记为空位。
 * 进行中或待复核的比赛不自动处理，原样列出，由裁判在裁判台按现场情况记录。
 */

type Tx = Prisma.TransactionClient;

const participantSchema = z.object({
  kind: z.enum(["WITHDRAWN", "DISQUALIFIED"]),
  reason: z.string().max(400),
});

const entrySchema = z.object({ reason: z.string().max(400) });

export interface WithdrawalOutcome {
  walkovers: string[];
  vacatedFixtures: string[];
  concededFixtures: string[];
  /** 进行中、待提交或待复核的比赛：没有自动处理。 */
  untouched: string[];
}

const SIDES: MatchSide[] = ["A", "B"];

async function audit(transaction: Tx, tournamentId: string, actorUserId: string, action: string, targetType: string, targetId: string, metadata: Record<string, unknown>) {
  await transaction.auditLog.create({
    data: { tournamentId, actorUserId, action, targetType, targetId, outcome: "SUCCESS", metadata: metadata as Prisma.InputJsonValue },
  });
}

/**
 * 处理一个个人项目报名单位的未开始比赛：对手已确定 → WO；对手未定 → 本侧记为空位。
 * 按轮次从早到晚处理，前一轮的 WO 会把对手推进下一轮，保证下一轮看到的是最新签位。
 */
async function forfeitIndividualEntry(transaction: Tx, tournamentId: string, actorUserId: string, entryId: string, reason: string, outcome: WithdrawalOutcome) {
  const fixtures = await transaction.fixture.findMany({
    where: { OR: [{ sideAEntryId: entryId }, { sideBEntryId: entryId }], draw: { status: "PUBLISHED" } },
    orderBy: [{ round: "asc" }, { sequence: "asc" }],
    select: { id: true },
  });
  for (const { id } of fixtures) {
    const fixture = await transaction.fixture.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        code: true,
        sideAEntryId: true,
        sideBEntryId: true,
        winnerEntryId: true,
        decidedAt: true,
        matches: { select: { id: true, code: true, version: true, lifecycleStatus: true, verificationStatus: true, notPlayedAt: true } },
      },
    });
    const side: MatchSide | null = fixture.sideAEntryId === entryId ? "A" : fixture.sideBEntryId === entryId ? "B" : null;
    const match = fixture.matches[0];
    if (!side || !match || fixture.decidedAt || match.notPlayedAt) continue;
    if (isStarted(match) || match.verificationStatus !== "UNVERIFIED") {
      outcome.untouched.push(match.code);
      continue;
    }
    const opponent = side === "A" ? fixture.sideBEntryId : fixture.sideAEntryId;
    if (opponent) {
      await recordRefereeWalkover(transaction, tournamentId, match.id, side === "A" ? "B" : "A", reason, actorUserId);
      outcome.walkovers.push(match.code);
    } else {
      await setFixtureSide(transaction, tournamentId, actorUserId, fixture.id, side, null, "选手退出", true);
      outcome.vacatedFixtures.push(fixture.code);
    }
  }
}

/** 选手退出或被取消资格：对整个赛事生效。 */
export async function withdrawParticipant(actorUserId: string, slug: string, publicCode: string, rawInput: unknown): Promise<WithdrawalOutcome> {
  const { tournament } = await requireManagedTournament(actorUserId, slug, ["CHIEF_REFEREE"]);
  const parsed = participantSchema.safeParse(rawInput);
  if (!parsed.success) throw new AppError(400, "invalid_input", "请求格式无效。");
  const reason = normalizeReason(parsed.data.reason);
  if (!reason) throw new AppError(400, "reason_required", "请写明退出或取消资格的原因。");
  const label = parsed.data.kind === "DISQUALIFIED" ? "取消资格" : "退出";

  return runTransaction(
    async (transaction) => {
      await lockTournamentRow(transaction, tournament.id);
      const participant = await transaction.participant.findFirst({
        where: { publicCode, tournamentId: tournament.id },
        select: { id: true, publicCode: true, displayName: true, withdrawnAt: true },
      });
      if (!participant) throw new AppError(404, "participant_not_found", "人员不属于本赛事。");
      if (participant.withdrawnAt) throw new AppError(409, "already_withdrawn", "该选手已登记退出或取消资格。");
      const now = new Date();
      await transaction.participant.update({
        where: { id: participant.id },
        data: { withdrawnAt: now, withdrawalKind: parsed.data.kind, withdrawalReason: reason },
      });

      const outcome: WithdrawalOutcome = { walkovers: [], vacatedFixtures: [], concededFixtures: [], untouched: [] };
      const walkoverReason = `${participant.publicCode} ${participant.displayName} ${label}：${reason}`;
      const memberships = await transaction.entryMember.findMany({
        where: { participantId: participant.id, entry: { entryType: { not: "TEAM" } } },
        select: { entryId: true },
      });
      for (const membership of memberships) {
        await forfeitIndividualEntry(transaction, tournament.id, actorUserId, membership.entryId, walkoverReason, outcome);
      }
      // 团体小场：该队员排在里面、尚未开始的小场按认输计（由结算推导），这里只触发结算。
      const appearances = await transaction.matchPlayer.findMany({
        where: { participantId: participant.id, match: { fixtureId: { not: null } } },
        select: { match: { select: { fixtureId: true, code: true, version: true, lifecycleStatus: true, verificationStatus: true } } },
      });
      const fixtureIds = new Set<string>();
      for (const { match } of appearances) {
        if (isStarted(match) && match.verificationStatus !== "LOCKED") outcome.untouched.push(match.code);
        if (match.fixtureId) fixtureIds.add(match.fixtureId);
      }
      for (const fixtureId of fixtureIds) {
        await settleTeamFixture(transaction, fixtureId, actorUserId);
        const fixture = await transaction.fixture.findUniqueOrThrow({ where: { id: fixtureId }, select: { code: true } });
        outcome.concededFixtures.push(fixture.code);
      }

      await audit(transaction, tournament.id, actorUserId, parsed.data.kind === "DISQUALIFIED" ? "PARTICIPANT_DISQUALIFIED" : "PARTICIPANT_WITHDRAWN", "Participant", participant.id, {
        publicCode: participant.publicCode,
        reason,
        ...outcome,
      });
      return outcome;
    },
    { timeout: 60_000 },
  );
}

/** 团体报名单位整体退出。 */
export async function withdrawTeamEntry(actorUserId: string, slug: string, entryId: string, rawInput: unknown): Promise<WithdrawalOutcome> {
  const { tournament } = await requireManagedTournament(actorUserId, slug, ["CHIEF_REFEREE"]);
  const parsed = entrySchema.safeParse(rawInput);
  if (!parsed.success) throw new AppError(400, "invalid_input", "请求格式无效。");
  const reason = normalizeReason(parsed.data.reason);
  if (!reason) throw new AppError(400, "reason_required", "请写明退出原因。");

  return runTransaction(
    async (transaction) => {
      await lockTournamentRow(transaction, tournament.id);
      const entry = await transaction.entry.findFirst({
        where: { id: entryId, competition: { tournamentId: tournament.id } },
        select: { id: true, code: true, displayName: true, entryType: true, withdrawnAt: true },
      });
      if (!entry) throw new AppError(404, "entry_not_found", "报名单位不属于本赛事。");
      if (entry.entryType !== "TEAM") throw new AppError(400, "not_team_entry", "个人项目请按选手登记退出。");
      if (entry.withdrawnAt) throw new AppError(409, "already_withdrawn", "这支队伍已登记退出。");
      await transaction.entry.update({ where: { id: entry.id }, data: { withdrawnAt: new Date(), withdrawalReason: reason } });

      const outcome: WithdrawalOutcome = { walkovers: [], vacatedFixtures: [], concededFixtures: [], untouched: [] };
      const fixtures = await transaction.fixture.findMany({
        where: { OR: [{ sideAEntryId: entry.id }, { sideBEntryId: entry.id }], draw: { status: "PUBLISHED" } },
        orderBy: [{ round: "asc" }, { sequence: "asc" }],
        select: { id: true, code: true, kind: true, sideAEntryId: true, sideBEntryId: true, decidedAt: true, matches: { select: { code: true, version: true, lifecycleStatus: true, verificationStatus: true } } },
      });
      for (const fixture of fixtures) {
        for (const match of fixture.matches) if (isStarted(match) && match.verificationStatus !== "LOCKED") outcome.untouched.push(match.code);
        if (fixture.decidedAt) continue;
        const side = SIDES.find((candidate) => (candidate === "A" ? fixture.sideAEntryId : fixture.sideBEntryId) === entry.id) as MatchSide;
        const opponent = side === "A" ? fixture.sideBEntryId : fixture.sideAEntryId;
        if (!opponent && fixture.kind !== "GROUP") {
          await setFixtureSide(transaction, tournament.id, actorUserId, fixture.id, side, null, "队伍退出", true);
          outcome.vacatedFixtures.push(fixture.code);
        } else {
          await settleTeamFixture(transaction, fixture.id, actorUserId);
          outcome.concededFixtures.push(fixture.code);
        }
      }
      await audit(transaction, tournament.id, actorUserId, "TEAM_ENTRY_WITHDRAWN", "Entry", entry.id, { entryCode: entry.code, reason, ...outcome });
      return outcome;
    },
    { timeout: 60_000 },
  );
}
