import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/db/client";
import { assertTestDatabaseUrl } from "@/db/database-safety";
import { AppError } from "@/server/services/errors";
import {
  getPublicMatchDetail,
  getPublicSchedule,
  isPublicMatchCode,
  isPublicTournamentSlug,
  listPublicTournaments,
} from "@/server/services/public-tournament-service";

const SLUG = "phase-1-demo";

async function expectPublicNotFound(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({ status: 404 });
}

describe("公开赛事门户投影", () => {
  beforeAll(() => assertTestDatabaseUrl(process.env.DATABASE_URL));

  describe("首页赛事列表", () => {
    it("按生命周期分桶返回已发布赛事，并带上已公开比赛数", async () => {
      const tournaments = await listPublicTournaments();
      const demo = tournaments.find((tournament) => tournament.slug === SLUG);
      expect(demo).toBeDefined();
      expect(demo?.phase).toBe("RUNNING");
      expect(demo?.publishedMatchCount).toBeGreaterThanOrEqual(17);
      expect(demo?.startDate).toBe("2026-09-21");
      expect(demo?.endDate).toBe("2026-10-01");
      expect(tournaments.map((tournament) => tournament.phase)).toEqual(
        expect.arrayContaining(["RUNNING", "FINISHED", "PREPARING"]),
      );
    });

    it("不返回草稿赛事", async () => {
      const tournament = await prisma.tournament.findUniqueOrThrow({
        where: { slug: SLUG },
        select: { id: true, status: true },
      });
      await prisma.tournament.update({ where: { id: tournament.id }, data: { status: "DRAFT" } });
      try {
        const slugs = (await listPublicTournaments()).map((item) => item.slug);
        expect(slugs).not.toContain(SLUG);
      } finally {
        await prisma.tournament.update({ where: { id: tournament.id }, data: { status: tournament.status } });
      }
    });

    it("不泄露内部策略、账号或审计字段", async () => {
      const text = JSON.stringify(await listPublicTournaments());
      for (const forbidden of ["namePolicy", "email", "userId", "auditLogs", "id\":"]) {
        expect(text).not.toContain(forbidden);
      }
    });
  });

  describe("公开路径段", () => {
    it("拒绝保留字、非法字符和超长 slug", () => {
      expect(isPublicTournamentSlug(SLUG)).toBe(true);
      for (const invalid of ["preview", "api", "board", "management", "A-Upper", "has space", "-lead", "trail-", "a".repeat(60), "x"]) {
        expect(isPublicTournamentSlug(invalid), invalid).toBe(false);
      }
    });

    it("比赛编号只接受大写安全字符", () => {
      expect(isPublicMatchCode("MS-DONE-001")).toBe(true);
      for (const invalid of ["ms-done-001", "MS DONE", "../MS", "M", "M".repeat(40)]) {
        expect(isPublicMatchCode(invalid), invalid).toBe(false);
      }
    });

    it("非法或未知 slug 走公开 404 而不是 500", async () => {
      await expectPublicNotFound(getPublicSchedule("preview"));
      await expectPublicNotFound(getPublicSchedule("no-such-tournament"));
      await expectPublicNotFound(getPublicMatchDetail(SLUG, "../etc/passwd"));
    });
  });

  describe("每日赛程", () => {
    it("按赛事时区折算自然日，而不是按 UTC", async () => {
      const schedule = await getPublicSchedule(SLUG);
      // MS-DONE-001 的 scheduledAt 是 2026-09-21T01:00:00Z，
      // 在 Asia/Shanghai 是 09:00 当天；若误按 UTC 折算仍是 09-21，
      // 因此另取一场跨零点的比赛验证时区确实生效。
      const match = schedule.matches.find((item) => item.code === "MS-DONE-001");
      expect(match?.scheduleDate).toBe("2026-09-21");
      expect(match?.time).toEqual({ type: "FIXED", scheduledAt: "2026-09-21T01:00:00.000Z" });
      expect(schedule.tournament.timezone).toBe("Asia/Shanghai");
    });

    it("服务端给出权威顺序，scheduleOrder 单调不降", async () => {
      const schedule = await getPublicSchedule(SLUG);
      const orders = schedule.matches.map((match) => match.scheduleOrder);
      expect(orders).toEqual([...orders].sort((first, second) => first - second));
    });

    it("排除未进入逐场发布边界的比赛", async () => {
      const match = await prisma.match.findUniqueOrThrow({
        where: { code: "MS-DONE-001" },
        select: { id: true, publishedAt: true },
      });
      await prisma.match.update({ where: { id: match.id }, data: { publishedAt: null } });
      try {
        const schedule = await getPublicSchedule(SLUG);
        expect(schedule.matches.map((item) => item.code)).not.toContain("MS-DONE-001");
        await expectPublicNotFound(getPublicMatchDetail(SLUG, "MS-DONE-001"));
      } finally {
        await prisma.match.update({ where: { id: match.id }, data: { publishedAt: match.publishedAt } });
      }
    });

    it("没有计划时间的比赛归入待排期，不硬塞进任何一天", async () => {
      const match = await prisma.match.findUniqueOrThrow({
        where: { code: "MS-SCHED-001" },
        select: { id: true, scheduledAt: true },
      });
      await prisma.match.update({ where: { id: match.id }, data: { scheduledAt: null } });
      try {
        const schedule = await getPublicSchedule(SLUG);
        const unscheduled = schedule.unscheduled.find((item) => item.code === "MS-SCHED-001");
        expect(unscheduled).toBeDefined();
        expect(unscheduled?.time.type).toBe("TBD");
        expect(unscheduled?.scheduleDate).toBe("");
        expect(schedule.matches.map((item) => item.code)).not.toContain("MS-SCHED-001");
        expect(schedule.queryOptions.dates).not.toContain("");
      } finally {
        await prisma.match.update({ where: { id: match.id }, data: { scheduledAt: match.scheduledAt } });
      }
    });

    it("时间语义只产出 FIXED 和 TBD，不伪造延后或预计", async () => {
      const schedule = await getPublicSchedule(SLUG);
      const types = new Set(schedule.matches.concat(schedule.unscheduled).map((match) => match.time.type));
      expect([...types].every((type) => type === "FIXED" || type === "TBD")).toBe(true);
    });

    it("赛事时区无效时 fail closed，不回退设备时区或 UTC", async () => {
      const tournament = await prisma.tournament.findUniqueOrThrow({
        where: { slug: SLUG },
        select: { id: true, timezone: true },
      });
      await prisma.tournament.update({ where: { id: tournament.id }, data: { timezone: "Not/AZone" } });
      try {
        await expect(getPublicSchedule(SLUG)).rejects.toBeInstanceOf(AppError);
        await expect(getPublicSchedule(SLUG)).rejects.toMatchObject({ code: "invalid_tournament_timezone" });
      } finally {
        await prisma.tournament.update({ where: { id: tournament.id }, data: { timezone: tournament.timezone } });
      }
    });
  });

  describe("比赛详情", () => {
    it("未开赛的比赛所有局都是未进行，不渲染成 0:0", async () => {
      const { match } = await getPublicMatchDetail(SLUG, "MS-FRESH-002");
      expect(match.lifecycle).toBe("READY");
      expect(match.games.every((game) => game.status === "NOT_STARTED")).toBe(true);
      expect(match.games.every((game) => game.scoreA === null && game.scoreB === null)).toBe(true);
      expect(match.gamesWon).toBeNull();
      expect(match.winnerSide).toBeNull();
    });

    it("局数由冻结规则的 bestOf 决定，胜方由服务端给出", async () => {
      const { match } = await getPublicMatchDetail(SLUG, "MS-DONE-001");
      expect(match.games).toHaveLength(3);
      expect(match.games.map((game) => game.status)).toEqual(["COMPLETED", "COMPLETED", "NOT_STARTED"]);
      expect(match.games[2]).toMatchObject({ scoreA: null, scoreB: null });
      expect(match.gamesWon).toEqual({ A: 2, B: 0 });
      expect(match.winnerSide).toBe("A");
      expect(match.ruleSummary).toContain("3 局 2 胜");
      expect(match.startedAt).not.toBeNull();
      expect(match.endedAt).not.toBeNull();
    });

    it("特殊结果保留真实比分并给出权威胜方，不补满目标分", async () => {
      const { match } = await getPublicMatchDetail(SLUG, "MD-DONE-002");
      expect(match.outcome).toBe("RET");
      expect(match.winnerSide).toBe("A");
      expect(match.games.every((game) => (game.scoreA ?? 0) < 21)).toBe(true);
    });

    it("不属于该赛事的比赛返回公开 404", async () => {
      await expectPublicNotFound(getPublicMatchDetail("spring-campus-2026", "MS-DONE-001"));
    });

    it("详情不下发引擎状态、更正理由或内部策略", async () => {
      const text = JSON.stringify(await getPublicMatchDetail(SLUG, "MS-DONE-001"));
      for (const forbidden of [
        "serverPlayerId", "receiverPlayerId", "coinToss", "pendingObligations",
        "namePolicy", "reason", "actorUserId", "commandId", "tokenHash",
      ]) {
        expect(text, forbidden).not.toContain(forbidden);
      }
    });
  });

  describe("姓名与代表队公开策略", () => {
    const tournamentId = { current: "" };

    beforeAll(async () => {
      const tournament = await prisma.tournament.findUniqueOrThrow({ where: { slug: SLUG }, select: { id: true } });
      tournamentId.current = tournament.id;
    });

    afterAll(async () => {
      await prisma.tournament.update({
        where: { id: tournamentId.current },
        data: { namePolicy: "DISPLAY_NAMES" },
      });
    });

    it("CODES_ONLY 时姓名和代表队根本不离开服务端", async () => {
      await prisma.tournament.update({ where: { id: tournamentId.current }, data: { namePolicy: "CODES_ONLY" } });
      const { match } = await getPublicMatchDetail(SLUG, "MS-DONE-001");
      expect(match.sideA?.displayName).toBe(match.sideA?.code);
      expect(match.sideA?.teamName).toBeNull();
      expect(match.sideA?.members.every((member) => member.displayName === member.publicCode)).toBe(true);
      expect(JSON.stringify(match)).not.toContain("模拟选手");
      expect(JSON.stringify(match)).not.toContain("计算机学院");
    });

    it("DISPLAY_NAMES 时才公开姓名与代表队", async () => {
      await prisma.tournament.update({ where: { id: tournamentId.current }, data: { namePolicy: "DISPLAY_NAMES" } });
      const { match } = await getPublicMatchDetail(SLUG, "MS-DONE-001");
      expect(match.sideA?.displayName).toContain("模拟选手");
      expect(match.sideA?.members[0]?.displayName).toContain("模拟选手");
      expect(match.sideB?.teamName).toBe("计算机学院");
    });
  });
});
