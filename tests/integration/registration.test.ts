import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/db/client";
import { assertTestDatabaseUrl } from "@/db/database-safety";
import { IMPORT_HEADERS } from "@/domain/registration/import-plan";
import { toCsv } from "@/domain/registration/csv";
import { publicMatchSelect, publicTournamentCardSelect } from "@/reports/public-fields";
import {
  commitRegistrationImport,
  previewRegistrationImport,
} from "@/server/services/registration-import-service";
import {
  createRegistrationInvite,
  resolveInvite,
  revokeRegistrationInvite,
  submitInviteRegistration,
} from "@/server/services/registration-invite-service";
import {
  batchApproveRegistrations,
  createManualRegistration,
  previewIdentity,
  renameParticipant,
  reviewRegistration,
} from "@/server/services/registration-service";
import {
  addCompetition,
  createTournament,
  publishTournament,
  transitionTournamentPhase,
  updateTournamentSettings,
} from "@/server/services/tournament-admin-service";

const RUN = randomBytes(3).toString("hex");
const createdSlugs: string[] = [];

let adminId = "";
let refereeId = "";

function slugFor(name: string) {
  const slug = `t4a-${RUN}-${name}`;
  createdSlugs.push(slug);
  return slug;
}

async function newTournament(name: string, overrides: Record<string, unknown> = {}) {
  const slug = slugFor(name);
  await createTournament(adminId, {
    slug,
    name: `报名测试 ${name}`,
    startDate: "2026-11-01",
    endDate: "2026-11-02",
    timezone: "Asia/Shanghai",
    namePolicy: "CODES_ONLY",
    rulePreset: "traditional-21",
    competitions: [
      { kind: "MS", code: "MS", name: "男子单打" },
      { kind: "MD", code: "MD", name: "男子双打" },
    ],
    ...overrides,
  });
  const competitions = await prisma.competition.findMany({
    where: { tournament: { slug } },
    select: { id: true, code: true },
  });
  const byCode = Object.fromEntries(competitions.map((item) => [item.code, item.id]));
  return { slug, ms: byCode.MS as string, md: byCode.MD as string };
}

async function registration(referenceCode: string) {
  return prisma.registration.findUniqueOrThrow({
    where: { referenceCode },
    select: { id: true, version: true, status: true, entryId: true },
  });
}

async function approve(slug: string, referenceCode: string, resolutions?: Record<string, unknown>) {
  const current = await registration(referenceCode);
  return reviewRegistration(adminId, slug, current.id, { action: "APPROVE", expectedVersion: current.version, resolutions });
}

function csvBytes(rows: string[][]) {
  return new TextEncoder().encode(toCsv([[...IMPORT_HEADERS], ...rows]));
}

function importRow(...cells: string[]) {
  return [...cells, ...Array(IMPORT_HEADERS.length - cells.length).fill("")];
}

beforeAll(async () => {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  adminId = (await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_ADMIN_EMAIL ?? "" } })).id;
  refereeId = (await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_REFEREE_EMAIL ?? "" } })).id;
});

afterAll(async () => {
  // 只清理本轮在 _test 库中新建的赛事。规则修订对规则档案是 RESTRICT，需先解除再删。
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  for (const slug of createdSlugs) {
    const tournament = await prisma.tournament.findUnique({ where: { slug }, select: { id: true } });
    if (!tournament) continue;
    await prisma.tournament.update({ where: { id: tournament.id }, data: { defaultRuleRevisionId: null } });
    await prisma.ruleProfileRevision.deleteMany({ where: { ruleProfile: { tournamentId: tournament.id } } });
    await prisma.tournament.delete({ where: { id: tournament.id } });
  }
});

describe("赛事创建", () => {
  it("只有平台管理员能新建赛事，创建者自动成为该赛事 ADMIN，规则如实标为演示配置", async () => {
    await expect(
      createTournament(refereeId, { slug: slugFor("denied") }),
    ).rejects.toMatchObject({ status: 403, code: "system_admin_required" });

    const { slug } = await newTournament("create");
    const tournament = await prisma.tournament.findUniqueOrThrow({
      where: { slug },
      select: {
        id: true,
        status: true,
        phase: true,
        namePolicy: true,
        defaultRuleRevision: { select: { sourceLabel: true, adoptedAt: true, config: true } },
        competitions: { select: { code: true, entryType: true }, orderBy: { code: "asc" } },
      },
    });
    expect(tournament).toMatchObject({ status: "DRAFT", phase: "PREPARING", namePolicy: "CODES_ONLY" });
    expect(tournament.defaultRuleRevision?.sourceLabel).toContain("演示配置");
    expect(tournament.defaultRuleRevision?.adoptedAt).toBeNull();
    expect(tournament.competitions).toEqual([
      { code: "MD", entryType: "DOUBLES" },
      { code: "MS", entryType: "SINGLES" },
    ]);
    await expect(
      prisma.roleAssignment.count({ where: { userId: adminId, tournamentId: tournament.id, role: "ADMIN" } }),
    ).resolves.toBe(1);

    await expect(newTournament("create-dup", { slug })).rejects.toMatchObject({ status: 409, code: "slug_taken" });
  });

  it("拒绝无效输入：日期倒置、项目代码重复、时区无效、报名窗口倒置", async () => {
    await expect(newTournament("bad-date", { startDate: "2026-11-03" })).rejects.toMatchObject({ status: 400 });
    await expect(
      newTournament("bad-code", {
        competitions: [
          { kind: "MS", code: "MS", name: "男单甲组" },
          { kind: "WS", code: "MS", name: "女单乙组" },
        ],
      }),
    ).rejects.toMatchObject({ status: 400, message: "项目代码不能重复。" });
    await expect(newTournament("bad-tz", { timezone: "Mars/Olympus" })).rejects.toMatchObject({ status: 400 });
    await expect(
      newTournament("bad-window", { registrationOpensAt: "2026-10-10T09:00", registrationClosesAt: "2026-10-01T09:00" }),
    ).rejects.toMatchObject({ status: 400, message: "报名截止时间必须晚于开始时间。" });
  });

  it("按赛事时区保存报名窗口；阶段只能按报名流程推进，重新开放必须写原因", async () => {
    const { slug } = await newTournament("phase", {
      timezone: "Asia/Shanghai",
      registrationOpensAt: "2026-10-01T09:00",
      registrationClosesAt: "2026-10-20T18:00",
    });
    const stored = await prisma.tournament.findUniqueOrThrow({
      where: { slug },
      select: { registrationOpensAt: true, registrationClosesAt: true },
    });
    expect(stored.registrationOpensAt?.toISOString()).toBe("2026-10-01T01:00:00.000Z");
    expect(stored.registrationClosesAt?.toISOString()).toBe("2026-10-20T10:00:00.000Z");

    // 表单未填写的时间以空字符串提交，视为不设置。
    const blank = await newTournament("blank-window", { registrationOpensAt: "", registrationClosesAt: "", subtitle: "" });
    await expect(
      prisma.tournament.findUniqueOrThrow({ where: { slug: blank.slug }, select: { registrationOpensAt: true, subtitle: true } }),
    ).resolves.toEqual({ registrationOpensAt: null, subtitle: null });

    await expect(transitionTournamentPhase(adminId, slug, { to: "RUNNING" })).rejects.toMatchObject({ status: 409 });
    await expect(transitionTournamentPhase(refereeId, slug, { to: "REGISTRATION_OPEN" })).rejects.toMatchObject({ status: 403 });
    await transitionTournamentPhase(adminId, slug, { to: "REGISTRATION_OPEN" });
    await transitionTournamentPhase(adminId, slug, { to: "REGISTRATION_CLOSED" });
    await expect(transitionTournamentPhase(adminId, slug, { to: "REGISTRATION_OPEN" })).rejects.toMatchObject({
      code: "reason_required",
    });
    await transitionTournamentPhase(adminId, slug, { to: "REGISTRATION_OPEN", reason: "补报截止延后一天" });
    await expect(
      prisma.auditLog.count({ where: { action: "TOURNAMENT_PHASE_CHANGED", tournament: { slug } } }),
    ).resolves.toBe(3);

    await updateTournamentSettings(adminId, slug, { registrationOpensAt: null, registrationClosesAt: "2026-10-21T18:00" });
    await addCompetition(adminId, slug, { kind: "XD", code: "XD", name: "混合双打" });
    await expect(addCompetition(adminId, slug, { kind: "XD", code: "XD", name: "混合双打" })).rejects.toMatchObject({
      code: "competition_code_taken",
    });
    await publishTournament(adminId, slug);
    await expect(publishTournament(adminId, slug)).rejects.toMatchObject({ code: "already_published" });
  });
});

describe("报名与审核", () => {
  it("手工录入只生成待审核报名；审核通过才生成 Entry，且单打恰好 1 人", async () => {
    const { slug, ms } = await newTournament("manual");
    const created = await createManualRegistration(adminId, slug, {
      competitionId: ms,
      members: [{ displayName: "张三", studentId: "2026001", contact: "13800000000" }],
    });
    const pending = await registration(created.referenceCode);
    expect(pending).toMatchObject({ status: "PENDING", entryId: null });
    await expect(prisma.entry.count({ where: { competitionId: ms } })).resolves.toBe(0);

    const result = await approve(slug, created.referenceCode);
    expect(result).toMatchObject({ status: "APPROVED", entryCode: "MS-001" });
    const entry = await prisma.entry.findFirstOrThrow({
      where: { competitionId: ms },
      select: { entryType: true, displayName: true, members: { select: { participant: { select: { publicCode: true, studentId: true } } } } },
    });
    expect(entry).toMatchObject({ entryType: "SINGLES", displayName: "张三" });
    expect(entry.members).toEqual([{ participant: { publicCode: "P001", studentId: "2026001" } }]);

    await expect(
      createManualRegistration(adminId, slug, { competitionId: ms, members: [{ displayName: "甲" }, { displayName: "乙" }] }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_members" });
    await expect(
      createManualRegistration(refereeId, slug, { competitionId: ms, members: [{ displayName: "甲" }] }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("双打 A+B 与 B+A 是同一组合；同一人不能在同一项目加入两个组合", async () => {
    const { slug, md } = await newTournament("pair");
    await createManualRegistration(adminId, slug, {
      competitionId: md,
      members: [
        { displayName: "甲", studentId: "S1" },
        { displayName: "乙", studentId: "S2" },
      ],
    });
    await expect(
      createManualRegistration(adminId, slug, {
        competitionId: md,
        members: [
          { displayName: "乙", studentId: "S2" },
          { displayName: "甲", studentId: "S1" },
        ],
      }),
    ).rejects.toMatchObject({ status: 409, code: "member_already_registered" });
    await expect(
      createManualRegistration(adminId, slug, {
        competitionId: md,
        members: [
          { displayName: "甲", studentId: "S1" },
          { displayName: "丙", studentId: "S3" },
        ],
      }),
    ).rejects.toMatchObject({ status: 409, code: "member_already_registered" });
    await expect(
      createManualRegistration(adminId, slug, {
        competitionId: md,
        members: [
          { displayName: "丁", studentId: "S4" },
          { displayName: "丁", studentId: "S4" },
        ],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("同名不同人：没有学号时不自动合并，必须人工确认新建或关联", async () => {
    const { slug, ms, md } = await newTournament("same-name");
    const first = await createManualRegistration(adminId, slug, { competitionId: ms, members: [{ displayName: "王五" }] });
    const second = await createManualRegistration(adminId, slug, { competitionId: ms, members: [{ displayName: "王五" }] });
    await approve(slug, first.referenceCode);

    await expect(approve(slug, second.referenceCode)).rejects.toMatchObject({
      status: 409,
      code: "identity_ambiguous",
      details: { slot: 1, candidates: [expect.objectContaining({ publicCode: "P001", displayName: "王五" })] },
    });
    // 失败的审核不留下半份数据：没有新人员、没有新 Entry，报名仍待审核。
    await expect(prisma.participant.count({ where: { tournament: { slug } } })).resolves.toBe(1);
    expect((await registration(second.referenceCode)).status).toBe("PENDING");

    await approve(slug, second.referenceCode, { "1": "NEW" });
    const people = await prisma.participant.findMany({
      where: { tournament: { slug } },
      select: { publicCode: true, displayName: true },
      orderBy: { publicCode: "asc" },
    });
    expect(people).toEqual([
      { publicCode: "P001", displayName: "王五" },
      { publicCode: "P002", displayName: "王五" },
    ]);

    // 同一人跨项目：双打报名里关联到已有的 P001，而不是再建一个人。
    const p1 = await prisma.participant.findFirstOrThrow({ where: { tournament: { slug }, publicCode: "P001" } });
    const doubles = await createManualRegistration(adminId, slug, {
      competitionId: md,
      members: [{ displayName: "王五" }, { displayName: "赵六" }],
    });
    await approve(slug, doubles.referenceCode, { "1": { participantId: p1.id } });
    await expect(
      prisma.entryMember.count({ where: { participantId: p1.id } }),
    ).resolves.toBe(2);
  });

  it("学号是唯一可自动判定同一人的依据：学号一致自动关联，学号相同姓名不同则冲突", async () => {
    const { slug, ms, md } = await newTournament("student-id");
    const single = await createManualRegistration(adminId, slug, {
      competitionId: ms,
      members: [{ displayName: "孙七", studentId: "S100" }],
    });
    await approve(slug, single.referenceCode);
    const doubles = await createManualRegistration(adminId, slug, {
      competitionId: md,
      members: [
        { displayName: "孙七", studentId: "s100" },
        { displayName: "周八", studentId: "S101" },
      ],
    });
    await approve(slug, doubles.referenceCode);
    await expect(prisma.participant.count({ where: { tournament: { slug } } })).resolves.toBe(2);

    const tournamentId = (await prisma.tournament.findUniqueOrThrow({ where: { slug } })).id;
    await expect(previewIdentity(prisma, tournamentId, { displayName: "孙 七", studentId: "S100" })).resolves.toMatchObject({
      kind: "MATCH",
    });
    const renamed = await prisma.competition.create({
      data: { tournamentId, code: "MS2", name: "男单乙组", kind: "MS", entryType: "SINGLES" },
    });
    const conflict = await createManualRegistration(adminId, slug, {
      competitionId: renamed.id,
      members: [{ displayName: "吴九", studentId: "S100" }],
    });
    await expect(approve(slug, conflict.referenceCode)).rejects.toMatchObject({ status: 409, code: "identity_conflict" });
    await expect(approve(slug, conflict.referenceCode, { "1": "NEW" })).rejects.toMatchObject({ code: "identity_conflict" });
  });

  it("驳回与撤回必须写原因；撤回已通过的报名会删除未编排的 Entry，之后可以重新报名", async () => {
    const { slug, ms } = await newTournament("withdraw");
    const created = await createManualRegistration(adminId, slug, { competitionId: ms, members: [{ displayName: "郑十", studentId: "S7" }] });
    const pending = await registration(created.referenceCode);
    await expect(
      reviewRegistration(adminId, slug, pending.id, { action: "REJECT", expectedVersion: pending.version, reason: "  " }),
    ).rejects.toMatchObject({ code: "reason_required" });

    await approve(slug, created.referenceCode);
    const approved = await registration(created.referenceCode);
    await expect(
      reviewRegistration(adminId, slug, approved.id, { action: "WITHDRAW", expectedVersion: pending.version, reason: "本人退赛" }),
    ).rejects.toMatchObject({ status: 409, code: "version_conflict" });
    await reviewRegistration(adminId, slug, approved.id, { action: "WITHDRAW", expectedVersion: approved.version, reason: "本人退赛" });
    expect(await registration(created.referenceCode)).toMatchObject({ status: "WITHDRAWN", entryId: null });
    await expect(prisma.entry.count({ where: { competitionId: ms } })).resolves.toBe(0);

    const again = await createManualRegistration(adminId, slug, { competitionId: ms, members: [{ displayName: "郑十", studentId: "S7" }] });
    await approve(slug, again.referenceCode);
    // 重新报名沿用同一人，Entry 编号继续递增不复用。
    const entry = await prisma.entry.findFirstOrThrow({ where: { competitionId: ms }, select: { code: true } });
    expect(entry.code).toBe("MS-002");
    await expect(prisma.participant.count({ where: { tournament: { slug } } })).resolves.toBe(1);
  });

  it("批量通过逐份独立：需要人工确认的报名保持待审核", async () => {
    const { slug, ms } = await newTournament("batch");
    const a = await createManualRegistration(adminId, slug, { competitionId: ms, members: [{ displayName: "甲" }] });
    const b = await createManualRegistration(adminId, slug, { competitionId: ms, members: [{ displayName: "乙" }] });
    const c = await createManualRegistration(adminId, slug, { competitionId: ms, members: [{ displayName: "甲" }] });
    const items = await Promise.all([a, b, c].map(async (item) => {
      const row = await registration(item.referenceCode);
      return { id: row.id, expectedVersion: row.version };
    }));
    const { results } = await batchApproveRegistrations(adminId, slug, { items });
    expect(results.map((item) => item.ok)).toEqual([true, true, false]);
    expect(results[2].code).toBe("identity_ambiguous");
  });

  it("更正姓名不改变身份，同步报名单位显示名并留审计", async () => {
    const { slug, md } = await newTournament("rename");
    const created = await createManualRegistration(adminId, slug, {
      competitionId: md,
      members: [{ displayName: "钱一" }, { displayName: "钱二" }],
    });
    await approve(slug, created.referenceCode);
    await expect(renameParticipant(adminId, slug, "P001", { displayName: "钱壹", reason: "" })).rejects.toMatchObject({
      code: "reason_required",
    });
    await renameParticipant(adminId, slug, "P001", { displayName: "钱壹", reason: "报名表笔误" });
    const entry = await prisma.entry.findFirstOrThrow({ where: { competitionId: md }, select: { displayName: true } });
    expect(entry.displayName).toBe("钱壹 / 钱二");
    const log = await prisma.auditLog.findFirstOrThrow({
      where: { action: "PARTICIPANT_RENAMED", tournament: { slug } },
      select: { metadata: true },
    });
    expect(log.metadata).toMatchObject({ from: "钱一", to: "钱壹", reason: "报名表笔误" });
  });

  it("已开赛或已编排的项目拒绝新增、通过和撤回", async () => {
    const running = await prisma.competition.findFirstOrThrow({
      where: { tournament: { slug: "phase-1-demo" }, code: "MS" },
      select: { id: true },
    });
    await expect(
      createManualRegistration(adminId, "phase-1-demo", { competitionId: running.id, members: [{ displayName: "迟到者" }] }),
    ).rejects.toMatchObject({ status: 409, code: "tournament_locked" });

    const { slug, ms } = await newTournament("frozen");
    const created = await createManualRegistration(adminId, slug, { competitionId: ms, members: [{ displayName: "冯一" }] });
    await approve(slug, created.referenceCode);
    const other = await createManualRegistration(adminId, slug, { competitionId: ms, members: [{ displayName: "冯二" }] });
    // 模拟阶段 4-B 抽签发布后的冻结。
    await prisma.entry.updateMany({ where: { competitionId: ms }, data: { frozenAt: new Date() } });
    const approved = await registration(created.referenceCode);
    await expect(
      reviewRegistration(adminId, slug, approved.id, { action: "WITHDRAW", expectedVersion: approved.version, reason: "退赛" }),
    ).rejects.toMatchObject({ code: "competition_locked" });
    await expect(approve(slug, other.referenceCode)).rejects.toMatchObject({ code: "competition_locked" });
  });
});

describe("数据库兜底", () => {
  it("报名成员数、跨赛事成员、同项目重复成员都由数据库拒绝", async () => {
    const { slug, ms, md } = await newTournament("db");
    const tournamentId = (await prisma.tournament.findUniqueOrThrow({ where: { slug } })).id;
    await expect(
      prisma.registration.create({
        data: { tournamentId, competitionId: md, referenceCode: `R-DB${RUN}`, source: "MANUAL", members: { create: [{ slot: 1, displayName: "独" }] } },
      }),
    ).rejects.toThrow();

    const foreign = await prisma.participant.findFirstOrThrow({ where: { tournament: { slug: "phase-1-demo" } } });
    await expect(
      prisma.entry.create({
        data: {
          competitionId: ms,
          code: "MS-X",
          displayName: "越界",
          entryType: "SINGLES",
          members: { create: [{ slot: 1, competitionId: ms, participantId: foreign.id }] },
        },
      }),
    ).rejects.toThrow();

    const local = await prisma.participant.create({ data: { tournamentId, publicCode: "PX1", displayName: "本地" } });
    await prisma.entry.create({
      data: {
        competitionId: ms,
        code: "MS-Y",
        displayName: "本地",
        entryType: "SINGLES",
        members: { create: [{ slot: 1, competitionId: ms, participantId: local.id }] },
      },
    });
    await expect(
      prisma.entry.create({
        data: {
          competitionId: ms,
          code: "MS-Z",
          displayName: "本地",
          entryType: "SINGLES",
          members: { create: [{ slot: 1, competitionId: ms, participantId: local.id }] },
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.entry.create({
        data: {
          competitionId: ms,
          code: "MS-W",
          displayName: "错位",
          entryType: "SINGLES",
          members: { create: [{ slot: 1, competitionId: md, participantId: local.id }] },
        },
      }),
    ).rejects.toThrow();
  });

  it("公开白名单不包含学号、联系方式和报名数据", () => {
    const serialized = JSON.stringify([publicMatchSelect, publicTournamentCardSelect]);
    for (const field of ["studentId", "contact", "registration", "regulations", "submitterFingerprint"]) {
      expect(serialized).not.toContain(field);
    }
  });
});

describe("批量导入", () => {
  it("预览给出行号与错误；有错误时确认提交整份拒绝，不留半份", async () => {
    const { slug } = await newTournament("import-errors");
    const bytes = csvBytes([importRow("MS", "甲", "S1"), importRow("MS", "=cmd"), importRow("XX", "乙")]);
    const preview = await previewRegistrationImport(adminId, slug, bytes);
    expect(preview.counts).toEqual({ total: 3, new: 1, duplicate: 0, error: 2 });
    expect(preview.rows.filter((row) => row.status === "ERROR").map((row) => row.line)).toEqual([3, 4]);
    expect(preview.canCommit).toBe(false);
    await expect(
      commitRegistrationImport(adminId, slug, bytes, { contentHash: preview.contentHash, newCount: 1, duplicateCount: 0 }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(prisma.registration.count({ where: { tournament: { slug } } })).resolves.toBe(0);
  });

  it("确认后原子写入待审核报名；同一文件不能导入两次；与已有报名重复的行被跳过", async () => {
    const { slug } = await newTournament("import-ok");
    const bytes = csvBytes([
      importRow("MS", "甲", "S1", "计算机学院", "13800000000"),
      importRow("MD", "乙", "S2", "", "", "丙", "S3"),
    ]);
    const preview = await previewRegistrationImport(adminId, slug, bytes);
    expect(preview.canCommit).toBe(true);
    // 联系方式在预览中打码。
    expect(preview.rows[0].members[0].contact).toBe("138••••••00");

    await expect(
      commitRegistrationImport(adminId, slug, bytes, { contentHash: "0".repeat(64), newCount: 2, duplicateCount: 0 }),
    ).rejects.toMatchObject({ code: "import_preview_stale" });
    const result = await commitRegistrationImport(adminId, slug, bytes, {
      contentHash: preview.contentHash,
      newCount: 2,
      duplicateCount: 0,
    });
    expect(result.created).toBe(2);
    const rows = await prisma.registration.findMany({
      where: { tournament: { slug } },
      select: { status: true, source: true, importRowNumber: true },
      orderBy: { importRowNumber: "asc" },
    });
    expect(rows).toEqual([
      { status: "PENDING", source: "IMPORT", importRowNumber: 2 },
      { status: "PENDING", source: "IMPORT", importRowNumber: 3 },
    ]);
    await expect(
      commitRegistrationImport(adminId, slug, bytes, { contentHash: preview.contentHash, newCount: 2, duplicateCount: 0 }),
    ).rejects.toMatchObject({ code: "import_already_committed" });

    // 换一份文件，其中一行与已导入的双打组合成员顺序相反：判为重复并跳过，不会重复建人。
    const second = csvBytes([importRow("MD", "丙", "S3", "", "", "乙", "S2"), importRow("MS", "丁", "S4")]);
    const secondPreview = await previewRegistrationImport(adminId, slug, second);
    expect(secondPreview.counts).toMatchObject({ new: 1, duplicate: 1, error: 0 });
    // 预览后数据变化（有人抢先报了 S4）：确认时发现与预览不一致，整份拒绝。
    const ms = await prisma.competition.findFirstOrThrow({ where: { tournament: { slug }, code: "MS" } });
    await createManualRegistration(adminId, slug, { competitionId: ms.id, members: [{ displayName: "丁", studentId: "S4" }] });
    await expect(
      commitRegistrationImport(adminId, slug, second, { contentHash: secondPreview.contentHash, newCount: 1, duplicateCount: 1 }),
    ).rejects.toMatchObject({ status: 409, code: "import_preview_stale" });
    await expect(prisma.registration.count({ where: { tournament: { slug } } })).resolves.toBe(3);
  });

  it("识别中文 Excel 常见的 GB18030 编码，拒绝超限文件", async () => {
    const { slug } = await newTournament("import-gbk");
    // 「项目代码」等表头的 GB18030 字节由 Node 内置 ICU 编码后回读验证。
    const utf8 = toCsv([[...IMPORT_HEADERS], importRow("MS", "张三")]).replace(/^﻿/, "");
    const gbBytes = encodeGb18030(utf8);
    const preview = await previewRegistrationImport(adminId, slug, gbBytes);
    expect(preview.headerError).toBeNull();
    expect(preview.rows[0].members[0].displayName).toBe("张三");

    await expect(previewRegistrationImport(adminId, slug, new Uint8Array(300 * 1024))).rejects.toMatchObject({ status: 413 });
    await expect(previewRegistrationImport(refereeId, slug, gbBytes)).rejects.toMatchObject({ status: 403 });
  });
});

describe("匿名邀请链接", () => {
  it("只保存令牌摘要；报名未开放时不接受提交；开放后生成待审核报名，不创建任何账号", async () => {
    const { slug, ms } = await newTournament("invite");
    const usersBefore = await prisma.user.count();
    const { token } = await createRegistrationInvite(adminId, slug, {
      label: "计算机学院",
      expiresAt: "2026-12-01T23:00",
      maxSubmissions: 2,
    }, new Date("2026-09-24T00:00:00Z"));
    const stored = await prisma.registrationInvite.findFirstOrThrow({ where: { tournament: { slug } } });
    expect(stored.tokenHash).not.toContain(token);
    expect(JSON.stringify(stored)).not.toContain(token);

    const now = new Date("2026-10-01T00:00:00Z");
    expect((await resolveInvite(token, now)).state).toBe("NOT_YET_OPEN");
    const body = { competitionId: ms, members: [{ displayName: "邀请甲", studentId: "I1" }], consent: true };
    await expect(submitInviteRegistration(token, body, "10.0.0.1", now)).rejects.toMatchObject({
      status: 409,
      code: "registration_closed",
    });

    await transitionTournamentPhase(adminId, slug, { to: "REGISTRATION_OPEN" });
    await expect(submitInviteRegistration(token, { ...body, consent: false }, "10.0.0.1", now)).rejects.toMatchObject({
      code: "consent_required",
    });
    await expect(submitInviteRegistration(token, { ...body, website: "http://spam" }, "10.0.0.1", now)).rejects.toMatchObject({
      status: 400,
    });
    const receipt = await submitInviteRegistration(token, body, "10.0.0.1", now);
    expect(receipt.referenceCode).toMatch(/^R-/);
    expect(await registration(receipt.referenceCode)).toMatchObject({ status: "PENDING", entryId: null });
    const row = await prisma.registration.findUniqueOrThrow({
      where: { referenceCode: receipt.referenceCode },
      select: { source: true, submitterFingerprint: true },
    });
    expect(row.source).toBe("INVITE");
    expect(row.submitterFingerprint).not.toContain("10.0.0.1");
    await expect(prisma.user.count()).resolves.toBe(usersBefore);

    // 名额用尽后与无效令牌不可区分。
    await submitInviteRegistration(token, { ...body, members: [{ displayName: "邀请乙" }] }, "10.0.0.2", now);
    expect((await resolveInvite(token, now)).state).toBe("INVALID");
    await expect(submitInviteRegistration(token, body, "10.0.0.3", now)).rejects.toMatchObject({ status: 404 });
  });

  it("停用、过期和格式错误的令牌统一视为无效；按来源限流", async () => {
    const { slug, ms } = await newTournament("invite-limits");
    await transitionTournamentPhase(adminId, slug, { to: "REGISTRATION_OPEN" });
    const now = new Date();
    const expires = new Date(now.getTime() + 7 * 86_400_000);
    const local = expires.toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(0, 16).replace(" ", "T");
    const { invite, token } = await createRegistrationInvite(adminId, slug, { label: "限流", expiresAt: local, maxSubmissions: 50 });

    for (let index = 0; index < 5; index += 1) {
      await submitInviteRegistration(token, { competitionId: ms, members: [{ displayName: `限流${index}` }], consent: true }, "10.9.9.9");
    }
    await expect(
      submitInviteRegistration(token, { competitionId: ms, members: [{ displayName: "限流6" }], consent: true }, "10.9.9.9"),
    ).rejects.toMatchObject({ status: 429 });
    await submitInviteRegistration(token, { competitionId: ms, members: [{ displayName: "别处" }], consent: true }, "10.9.9.8");

    await revokeRegistrationInvite(adminId, slug, invite.id);
    expect((await resolveInvite(token)).state).toBe("INVALID");
    expect((await resolveInvite("not-a-token")).state).toBe("INVALID");
    expect((await resolveInvite("A".repeat(43))).state).toBe("INVALID");
    expect((await resolveInvite(token, new Date(expires.getTime() + 1000))).state).toBe("INVALID");
  });
});

function encodeGb18030(text: string) {
  // Node 没有内置 GB18030 编码器（TextEncoder 只支持 UTF-8），这里只对测试用到的字符查表。
  const table: Record<string, number[]> = {};
  const decoder = new TextDecoder("gb18030");
  const needed = new Set([...text].filter((character) => character.charCodeAt(0) > 0x7f));
  for (let high = 0x81; high <= 0xfe && needed.size; high += 1) {
    for (let low = 0x40; low <= 0xfe && needed.size; low += 1) {
      if (low === 0x7f) continue;
      const character = decoder.decode(new Uint8Array([high, low]));
      if (needed.has(character)) {
        table[character] = [high, low];
        needed.delete(character);
      }
    }
  }
  if (needed.size) throw new Error(`测试编码表缺少字符：${[...needed].join("")}`);
  const bytes: number[] = [];
  for (const character of text) {
    if (character.charCodeAt(0) <= 0x7f) bytes.push(character.charCodeAt(0));
    else bytes.push(...table[character]);
  }
  return new Uint8Array(bytes);
}
