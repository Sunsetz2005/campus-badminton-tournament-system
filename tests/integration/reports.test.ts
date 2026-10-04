import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/db/client";
import { assertTestDatabaseUrl } from "@/db/database-safety";
import { generateDrawDraft, publishDraw } from "@/server/services/draw-service";
import { createManualRegistration, reviewRegistration } from "@/server/services/registration-service";
import { contentDisposition, generateReportExport, getReportExportFile, listReportExports, tournamentRoles } from "@/server/services/report-export-service";
import { buildReportSnapshot, captureReportSnapshot } from "@/server/services/report-snapshot-service";
import { confirmIndividualGroupRanking, loadCompetitionResults, publishStandings, recordResultOnly, reviewResultOnly } from "@/server/services/results-service";
import { getPublicMatchDetail } from "@/server/services/public-tournament-service";
import { createTournament, transitionTournamentPhase } from "@/server/services/tournament-admin-service";
import { readXlsx, tableRows, type ParsedSheet } from "../support/xlsx-reader";

const RUN = randomBytes(3).toString("hex");
const createdSlugs: string[] = [];
const createdEmails: string[] = [];
let adminId = "";
let refereeId = "";
let chiefId = "";
let organizerId = "";
let outsiderId = "";

const LONG_NAME = "欧阳娜娜·阿卜杜热合曼·买买提提江";

/** 用 poppler 的 pdftotext 独立打开 PDF 取文字；本机未安装时相关断言跳过（文件本身仍做结构自检）。 */
const HAS_PDFTOTEXT = (() => {
  try {
    execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function pdfText(bytes: Uint8Array) {
  return execFileSync("pdftotext", ["-layout", "-", "-"], { input: Buffer.from(bytes), stdio: ["pipe", "pipe", "ignore"] }).toString("utf8");
}

function pdfPages(bytes: Uint8Array) {
  return (Buffer.from(bytes).toString("latin1").match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
}
const STUDENT_ID = "2026990001";
const CONTACT = "+86 138 0000 0001";

async function newUser(label: string) {
  const email = `${label}-${RUN}@reports.test`;
  createdEmails.push(email);
  return (await prisma.user.create({ data: { name: `${label} ${RUN}`, email } })).id;
}

/** 4 人单循环：发布抽签、指派角色，并把全部比赛放进逐场公开边界（模拟赛程已发布）。 */
async function roundRobin(name: string) {
  const slug = `t7-${RUN}-${name}`;
  createdSlugs.push(slug);
  await createTournament(adminId, {
    slug,
    name: `成绩册测试 ${name}`,
    startDate: "2026-11-01",
    endDate: "2026-11-02",
    timezone: "Asia/Shanghai",
    namePolicy: "CODES_ONLY",
    rulePreset: "traditional-21",
    competitions: [{ kind: "MS", code: "MS", name: "男子单打" }],
  });
  const tournament = await prisma.tournament.findUniqueOrThrow({ where: { slug }, select: { id: true } });
  const competition = await prisma.competition.findFirstOrThrow({ where: { tournamentId: tournament.id }, select: { id: true } });
  await transitionTournamentPhase(adminId, slug, { to: "REGISTRATION_OPEN" });
  const names = [LONG_NAME, "选手乙", "选手丙", "选手丁"];
  for (const [index, displayName] of names.entries()) {
    const created = await createManualRegistration(adminId, slug, {
      competitionId: competition.id,
      members: [
        index === 0
          ? { displayName, teamName: "数学科学学院", studentId: STUDENT_ID, contact: CONTACT }
          : { displayName, teamName: `学院${index + 1}` },
      ],
    });
    const registration = await prisma.registration.findUniqueOrThrow({ where: { referenceCode: created.referenceCode }, select: { id: true, version: true } });
    await reviewRegistration(adminId, slug, registration.id, { action: "APPROVE", expectedVersion: registration.version });
  }
  const draft = await generateDrawDraft(adminId, slug, "MS", { format: "ROUND_ROBIN" });
  await transitionTournamentPhase(adminId, slug, { to: "REGISTRATION_CLOSED" });
  await publishDraw(adminId, slug, "MS", draft.drawId, { confirm: true });
  await prisma.roleAssignment.createMany({
    data: [
      { userId: refereeId, tournamentId: tournament.id, role: "REFEREE" },
      { userId: chiefId, tournamentId: tournament.id, role: "CHIEF_REFEREE" },
      { userId: adminId, tournamentId: tournament.id, role: "CHIEF_REFEREE" },
      { userId: organizerId, tournamentId: tournament.id, role: "ORGANIZER" },
    ],
  });
  const base = Date.UTC(2026, 10, 1, 1, 0);
  const matches = await prisma.match.findMany({ where: { stage: { competition: { tournamentId: tournament.id } } }, orderBy: { code: "asc" }, select: { id: true, code: true } });
  for (const [index, match] of matches.entries()) {
    await prisma.match.update({ where: { id: match.id }, data: { publishedAt: new Date(), scheduledAt: new Date(base + index * 30 * 60_000) } });
  }
  return { slug, tournamentId: tournament.id, competitionId: competition.id, matchCodes: matches.map((match) => match.code) };
}

const WIN = [{ a: 21, b: 12 }, { a: 21, b: 15 }];

async function confirmResult(slug: string, matchCode: string, games = WIN) {
  const recorded = await recordResultOnly(adminId, slug, matchCode, { outcome: "NORMAL", games, reason: "纸质记分表补录" });
  await reviewResultOnly(chiefId, slug, matchCode, { action: "CONFIRM", expectedRevision: recorded.revision, reason: "核对无误" });
  return recorded.revision;
}

async function fileOf(id: string) {
  return prisma.reportExport.findUniqueOrThrow({ where: { id }, select: { content: true, sha256: true, supersededAt: true, version: true } });
}

function sheet(sheets: ParsedSheet[], name: string) {
  const found = sheets.find((item) => item.name === name);
  if (!found) throw new Error(`缺少工作表 ${name}`);
  return found;
}

beforeAll(async () => {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  adminId = (await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_ADMIN_EMAIL ?? "" } })).id;
  refereeId = (await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_REFEREE_EMAIL ?? "" } })).id;
  chiefId = await newUser("chief");
  organizerId = await newUser("organizer");
  outsiderId = await newUser("outsider");
});

afterAll(async () => {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  for (const slug of createdSlugs) {
    const tournament = await prisma.tournament.findUnique({ where: { slug }, select: { id: true } });
    if (!tournament) continue;
    const matchWhere = { stage: { competition: { tournamentId: tournament.id } } };
    await prisma.matchEvent.deleteMany({ where: { match: matchWhere } });
    await prisma.resultRevision.deleteMany({ where: { match: matchWhere } });
    await prisma.scoringSession.deleteMany({ where: { match: matchWhere } });
    await prisma.match.deleteMany({ where: matchWhere });
    await prisma.tournament.update({ where: { id: tournament.id }, data: { defaultRuleRevisionId: null } });
    await prisma.ruleProfileRevision.deleteMany({ where: { ruleProfile: { tournamentId: tournament.id } } });
    await prisma.tournament.delete({ where: { id: tournament.id } });
  }
  await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
});

describe("对外版本：字段白名单、姓名策略与公式注入", () => {
  it("编号公开时不出现姓名、学号与联系方式；公开姓名后长姓名完整出现；历史脏数据中的公式按文本写出", async () => {
    const { slug, tournamentId, matchCodes } = await roundRobin("public");
    await confirmResult(slug, matchCodes[0]);

    const codesOnly = await generateReportExport(adminId, slug, { kind: "DATA_WORKBOOK", edition: "DRAFT" });
    const codesFile = await fileOf(codesOnly.id);
    const codesText = Buffer.from(codesFile.content).toString("latin1") + readXlsx(Buffer.from(codesFile.content)).map((item) => item.xml).join("");
    for (const secret of [LONG_NAME, "选手乙", STUDENT_ID, CONTACT, "数学科学学院", "纸质记分表补录", "核对无误"]) expect(codesText).not.toContain(secret);

    // 绕过录入校验直接写入一个公式样式的姓名，模拟历史数据；导出层必须独立防住。
    const formulaName = '=HYPERLINK("http://evil.example","点我")';
    await prisma.tournament.update({ where: { id: tournamentId }, data: { namePolicy: "DISPLAY_NAMES" } });
    await prisma.participant.updateMany({ where: { tournamentId, displayName: "选手乙" }, data: { displayName: formulaName } });
    await prisma.entry.updateMany({ where: { competition: { tournamentId }, displayName: "选手乙" }, data: { displayName: formulaName } });

    const named = await generateReportExport(adminId, slug, { kind: "DATA_WORKBOOK", edition: "DRAFT" });
    expect(named.version).toBe(2);
    const sheets = readXlsx(Buffer.from((await fileOf(named.id)).content));
    expect(sheets.map((item) => item.name)).toEqual(["说明", "参赛名单", "分组", "对阵", "赛程", "逐场成绩", "名次", "特殊结果"]);
    const entries = tableRows(sheet(sheets, "参赛名单"), "项目").rows;
    expect(entries.map((row) => row[2])).toEqual(expect.arrayContaining([LONG_NAME, formulaName]));
    expect(entries.find((row) => row[2] === LONG_NAME)?.[4]).toBe("数学科学学院");
    const allXml = sheets.map((item) => item.xml).join("");
    expect(allXml).not.toMatch(/<f[ >]/);
    expect(allXml).not.toContain(STUDENT_ID);
    expect(allXml).not.toContain("13800000001");
    // 公式样式的单元格一律带 quotePrefix 样式（s="4"）。
    const formulaCells = [...allXml.matchAll(/<c r="[A-Z]+\d+" s="(\d+)" t="inlineStr"><is><t xml:space="preserve">=HYPERLINK/g)];
    expect(formulaCells.length).toBeGreaterThan(0);
    expect(formulaCells.every((cell) => cell[1] === "4")).toBe(true);
  });
});

describe("内部报名名单与下载权限", () => {
  it("只有管理员与编排员能生成和下载内部名单；裁判长、裁判与无关账号一律拒绝；跨赛事与伪造 ID 返回 404", async () => {
    const { slug, tournamentId } = await roundRobin("internal");
    await expect(generateReportExport(chiefId, slug, { kind: "REGISTRATIONS_INTERNAL" })).rejects.toMatchObject({ status: 403 });
    await expect(generateReportExport(refereeId, slug, { kind: "DATA_WORKBOOK", edition: "DRAFT" })).rejects.toMatchObject({ status: 403 });
    await expect(generateReportExport(outsiderId, slug, { kind: "DATA_WORKBOOK", edition: "DRAFT" })).rejects.toMatchObject({ status: 403 });
    await expect(generateReportExport(organizerId, slug, { kind: "DATA_WORKBOOK", edition: "OFFICIAL" })).rejects.toMatchObject({ status: 403 });
    await expect(generateReportExport(adminId, slug, { kind: "HTML_PAGE", edition: "DRAFT" })).rejects.toMatchObject({ status: 400 });

    const internal = await generateReportExport(organizerId, slug, { kind: "REGISTRATIONS_INTERNAL" });
    const internalSheets = readXlsx(Buffer.from((await fileOf(internal.id)).content));
    const rows = tableRows(internalSheets[0], "项目").rows;
    expect(rows).toHaveLength(4);
    const first = rows.find((row) => row[7] === LONG_NAME);
    expect(first?.[9]).toBe(STUDENT_ID);
    expect(first?.[11]).toBe(CONTACT);
    expect(internalSheets[0].rows[1][0]).toContain("内部资料");
    // 「+86」开头的联系方式同样按文本加 quotePrefix。
    expect(internalSheets[0].xml).toMatch(/s="4" t="inlineStr"><is><t xml:space="preserve">\+86 138/);

    const draft = await generateReportExport(chiefId, slug, { kind: "DATA_WORKBOOK", edition: "DRAFT" });
    await expect(getReportExportFile(chiefId, slug, internal.id)).rejects.toMatchObject({ status: 403 });
    await expect(getReportExportFile(refereeId, slug, draft.id)).rejects.toMatchObject({ status: 403 });
    await expect(getReportExportFile(outsiderId, slug, draft.id)).rejects.toMatchObject({ status: 403 });
    await expect(getReportExportFile(chiefId, slug, randomUUID())).rejects.toMatchObject({ status: 404 });
    await expect(getReportExportFile(chiefId, slug, "../../etc/passwd")).rejects.toMatchObject({ status: 404 });
    const other = await roundRobin("internal-other");
    await expect(getReportExportFile(adminId, other.slug, draft.id)).rejects.toMatchObject({ status: 404 });

    const downloaded = await getReportExportFile(chiefId, slug, draft.id);
    expect(downloaded.fileName).toBe(`${slug}-data-draft-v1.xlsx`);
    expect(downloaded.contentType).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(contentDisposition(downloaded.fileName, downloaded.displayName)).toMatch(/^attachment; filename="[a-z0-9.-]+"; filename\*=UTF-8''[A-Za-z0-9%._-]+$/);

    // 管理员兼裁判长：按全部角色判断，能看到内部名单。
    const listed = await listReportExports(tournamentId, await tournamentRoles(adminId, tournamentId));
    expect(listed.map((item) => item.kind).sort()).toEqual(["DATA_WORKBOOK", "REGISTRATIONS_INTERNAL"]);
    const chiefListed = await listReportExports(tournamentId, await tournamentRoles(chiefId, tournamentId));
    expect(chiefListed.map((item) => item.kind)).toEqual(["DATA_WORKBOOK"]);
  });
});

describe("草稿与正式版、更正后替代、历史文件不可改写", () => {
  it("正式版只含已确认结果；数据未变不重复生成；更正后旧版标记已被替代且字节不变；名次待重发时拒绝正式版", async () => {
    const { slug, tournamentId, competitionId, matchCodes } = await roundRobin("official");
    expect(matchCodes).toHaveLength(6);
    for (const code of matchCodes.slice(0, 5)) await confirmResult(slug, code);
    // 第 6 场只补录、尚未复核：草稿给出暂定比分，正式版不给。
    await recordResultOnly(adminId, slug, matchCodes[5], { outcome: "NORMAL", games: [{ a: 21, b: 19 }, { a: 22, b: 20 }], reason: "补录" });

    const draft = await generateReportExport(adminId, slug, { kind: "DATA_WORKBOOK", edition: "DRAFT" });
    const draftResults = tableRows(sheet(readXlsx(Buffer.from((await fileOf(draft.id)).content)), "逐场成绩"), "比赛编号").rows;
    const pendingDraft = draftResults.find((row) => row[0] === matchCodes[5]);
    expect(pendingDraft?.[5]).toBe("21:19 22:20");
    expect(pendingDraft?.[9]).toBe("暂定 · 待复核");

    const v1 = await generateReportExport(chiefId, slug, { kind: "DATA_WORKBOOK", edition: "OFFICIAL" });
    const v1File = await fileOf(v1.id);
    const v1Sheets = readXlsx(Buffer.from(v1File.content));
    const officialResults = tableRows(sheet(v1Sheets, "逐场成绩"), "比赛编号").rows;
    const pendingOfficial = officialResults.find((row) => row[0] === matchCodes[5]);
    expect(pendingOfficial?.[5] ?? "").toBe("");
    expect(pendingOfficial?.[8] ?? "").toBe("");
    expect(pendingOfficial?.[9]).toBe("未确认（待复核）");
    // 数据库、Excel 对同一已确认结果的比分一致。
    for (const code of matchCodes.slice(0, 5)) {
      const games = await prisma.game.findMany({ where: { match: { code } }, orderBy: { number: "asc" } });
      expect(officialResults.find((row) => row[0] === code)?.[5]).toBe(games.map((game) => `${game.scoreA}:${game.scoreB}`).join(" "));
    }
    expect(tableRows(sheet(v1Sheets, "说明"), "项目").rows.find((row) => row[0] === "版本")?.[1]).toContain("正式版");

    await expect(generateReportExport(adminId, slug, { kind: "DATA_WORKBOOK", edition: "OFFICIAL" })).rejects.toMatchObject({ code: "report_unchanged" });

    // 第 6 场确认、裁判长确认小组名次并发布榜单后，正式版引用榜单版本并替代上一版。
    const pendingRevision = (await prisma.resultRevision.findFirstOrThrow({ where: { match: { code: matchCodes[5] } }, orderBy: { revision: "desc" } })).revision;
    await reviewResultOnly(chiefId, slug, matchCodes[5], { action: "CONFIRM", expectedRevision: pendingRevision, reason: "核对无误" });
    const group = await prisma.group.findFirstOrThrow({ where: { stage: { competitionId } }, select: { code: true } });
    const loaded = await loadCompetitionResults(prisma, tournamentId, "MS");
    const groupState = loaded?.results?.groups[0];
    await confirmIndividualGroupRanking(chiefId, slug, "MS", group.code, {
      order: groupState?.ranking.status === "NEEDS_DECISION" ? groupState.ranking.rows.map((row) => row.entryId) : undefined,
      reason: groupState?.ranking.status === "NEEDS_DECISION" ? "现场抽签，见证人：裁判长" : undefined,
    });
    await publishStandings(adminId, slug, "MS", { note: "第一次发布" });

    const v2 = await generateReportExport(adminId, slug, { kind: "DATA_WORKBOOK", edition: "OFFICIAL" });
    expect(v2.supersededVersion).toBe(v1.version);
    const v1After = await fileOf(v1.id);
    expect(v1After.supersededAt).not.toBeNull();
    expect(Buffer.from(v1After.content).equals(Buffer.from(v1File.content))).toBe(true);
    expect(v1After.sha256).toBe(v1File.sha256);
    const v2Sheets = readXlsx(Buffer.from((await fileOf(v2.id)).content));
    const rankings = tableRows(sheet(v2Sheets, "名次"), "项目").rows;
    expect(rankings.filter((row) => row[1] === "最终名次")).toHaveLength(4);
    expect(rankings.every((row) => row[5] !== "暂定（未确认，不作为正式名次）")).toBe(true);
    expect(tableRows(sheet(v2Sheets, "说明"), "项目").rows.find((row) => row[0] === "名次榜单版本")?.[1]).toBe("MS：第 1 版");

    // 更正一场已确认结果：名次撤回、榜单需重发 → 拒绝生成正式版；草稿仍可生成。
    const lockedRevision = (await prisma.resultRevision.findFirstOrThrow({ where: { match: { code: matchCodes[0] }, status: "LOCKED" } })).revision;
    await reviewResultOnly(chiefId, slug, matchCodes[0], { action: "REOPEN", expectedRevision: lockedRevision, reason: "记分表抄错" });
    await expect(generateReportExport(adminId, slug, { kind: "DATA_WORKBOOK", edition: "OFFICIAL" })).rejects.toMatchObject({ code: "standings_need_republish" });
    await expect(generateReportExport(adminId, slug, { kind: "DATA_WORKBOOK", edition: "DRAFT" })).resolves.toMatchObject({ version: 4 });

    // 数据库兜底：已生成文件不可改写，已被替代的不能再改替代关系，同时最多一份当前正式版。
    await expect(prisma.reportExport.update({ where: { id: v2.id }, data: { content: new Uint8Array([1, 2, 3]), byteSize: 3 } })).rejects.toThrow();
    await expect(prisma.reportExport.update({ where: { id: v1.id }, data: { supersededAt: null, supersededByExportId: null } })).rejects.toThrow();
    const current = await prisma.reportExport.count({ where: { tournamentId, kind: "DATA_WORKBOOK", edition: "OFFICIAL", supersededAt: null } });
    expect(current).toBe(1);
  });
});

describe("一致性快照", () => {
  it("取数事务进行中别人提交的更正不会混进同一份快照；事务结束后重新取数才看到", async () => {
    const { slug, tournamentId, matchCodes } = await roundRobin("consistency");
    const revision = await confirmResult(slug, matchCodes[0]);

    const { first, second } = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const before = await buildReportSnapshot(tx, tournamentId, "DRAFT");
        // 另一连接在取数途中重开这场结果。
        await reviewResultOnly(chiefId, slug, matchCodes[0], { action: "REOPEN", expectedRevision: revision, reason: "更正" });
        const after = await buildReportSnapshot(tx, tournamentId, "DRAFT");
        return { first: before, second: after };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60_000 },
    );
    expect(second).toEqual(first);
    expect(first.matches.find((match) => match.code === matchCodes[0])?.confirmed).toBe(true);

    const fresh = await captureReportSnapshot(tournamentId, "DRAFT");
    // 取数时刻是数据库事务时刻，不能因时区解析偏移。
    expect(Math.abs(fresh.capturedAt.getTime() - Date.now())).toBeLessThan(60_000);
    expect(fresh.snapshot.matches.find((match) => match.code === matchCodes[0])?.confirmed).toBe(false);
    expect(fresh.snapshot).not.toEqual(first);
  });
});

describe("空赛事与单双打演示数据", () => {
  it("没有报名与比赛的赛事也能生成，各表写明「暂无」", async () => {
    const slug = `t7-${RUN}-empty`;
    createdSlugs.push(slug);
    await createTournament(adminId, {
      slug,
      name: "成绩册测试 空赛事",
      startDate: "2026-11-01",
      endDate: "2026-11-01",
      timezone: "Asia/Shanghai",
      namePolicy: "CODES_ONLY",
      rulePreset: "traditional-21",
      competitions: [{ kind: "WS", code: "WS", name: "女子单打" }],
    });
    const created = await generateReportExport(adminId, slug, { kind: "DATA_WORKBOOK", edition: "OFFICIAL" });
    const sheets = readXlsx(Buffer.from((await fileOf(created.id)).content));
    expect(tableRows(sheet(sheets, "逐场成绩"), "比赛编号").rows).toEqual([["没有已公开的比赛。"]]);
    expect(tableRows(sheet(sheets, "名次"), "项目").rows[0]).toEqual(["女子单打", "—", "", "", "", "", "本项目没有已发布的抽签，不产生名次。"]);
  });

  it("阶段 1 演示赛事：双打两名成员完整列出，RET 只列结局与实际比分、不泄露内部原因，比分与数据库一致", async () => {
    const tournament = await prisma.tournament.findUniqueOrThrow({ where: { slug: "phase-1-demo" }, select: { id: true } });
    const { snapshot } = await captureReportSnapshot(tournament.id, "OFFICIAL");
    const doubles = snapshot.matches.filter((match) => match.competitionCode === "MD" && !match.sideA.pending);
    expect(doubles.length).toBeGreaterThan(0);
    expect(doubles.every((match) => match.sideA.members.length === 2 && match.sideB.members.length === 2)).toBe(true);
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain("模拟现场特殊结果");
    expect(text).not.toMatch(/studentId|contact|reason/);
    for (const match of snapshot.matches.filter((item) => item.confirmed)) {
      const games = await prisma.game.findMany({ where: { match: { code: match.code }, completed: true }, orderBy: { number: "asc" } });
      expect(match.games).toEqual(games.map((game) => ({ a: game.scoreA, b: game.scoreB })));
    }
    expect(snapshot.specialResults.every((item) => /（(WO|RET|DSQ)）|终止|轮空/.test(item.text))).toBe(true);
  });
});

describe("PDF 成绩册", () => {
  it.skipIf(!HAS_PDFTOTEXT)("多页成绩册：跨页重复表头、编号公开时不出现姓名；草稿有醒目标记；比分与名次在数据库、公开网页、Excel、PDF 中一致", async () => {
    const { slug, tournamentId, matchCodes } = await roundRobin("pdf");
    for (const code of matchCodes) await confirmResult(slug, code, [{ a: 21, b: 17 }, { a: 19, b: 21 }, { a: 21, b: 16 }]);
    const group = await prisma.group.findFirstOrThrow({ where: { stage: { competition: { tournamentId } } }, select: { code: true } });
    const loaded = await loadCompetitionResults(prisma, tournamentId, "MS");
    const ranking = loaded?.results?.groups[0].ranking;
    await confirmIndividualGroupRanking(chiefId, slug, "MS", group.code, {
      order: ranking?.status === "NEEDS_DECISION" ? ranking.rows.map((row) => row.entryId) : undefined,
      reason: ranking?.status === "NEEDS_DECISION" ? "现场抽签，见证人：裁判长" : undefined,
    });
    await publishStandings(adminId, slug, "MS", {});

    const draft = await generateReportExport(adminId, slug, { kind: "BOOKLET_PDF", edition: "DRAFT" });
    const draftFile = await fileOf(draft.id);
    const draftText = pdfText(draftFile.content);
    expect(draftText).toContain("草稿 · 非正式成绩");
    for (const secret of [LONG_NAME, STUDENT_ID, "数学科学学院"]) expect(draftText).not.toContain(secret);

    await prisma.tournament.update({ where: { id: tournamentId }, data: { namePolicy: "DISPLAY_NAMES", status: "PUBLISHED", publishedAt: new Date() } });
    const official = await generateReportExport(chiefId, slug, { kind: "BOOKLET_PDF", edition: "OFFICIAL" });
    const bytes = (await fileOf(official.id)).content;
    expect(Buffer.from(bytes).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdfPages(bytes)).toBeGreaterThanOrEqual(8);
    const text = pdfText(bytes);
    expect(text).toContain("正式版");
    expect(text).not.toContain("草稿 · 非正式成绩");
    // 页脚：每页都有版本、数据修订号与页码（pdftotext 抽取时空格可能被吞掉）。
    expect(text.replace(/\s+/g, "")).toMatch(/第1\/\d+页/);
    expect(text).toContain(`第 ${official.version} 版 · 数据修订`);
    // 长姓名完整出现（允许版式换行把它拆到两行：去掉空白后比较）。
    expect(text.replace(/\s+/g, "")).toContain(LONG_NAME);
    expect(text).not.toContain(STUDENT_ID);

    const workbook = await generateReportExport(adminId, slug, { kind: "DATA_WORKBOOK", edition: "OFFICIAL" });
    const sheets = readXlsx(Buffer.from((await fileOf(workbook.id)).content));
    const excelResults = tableRows(sheet(sheets, "逐场成绩"), "比赛编号").rows;
    const excelPlacements = tableRows(sheet(sheets, "名次"), "项目").rows.filter((row) => row[1] === "最终名次");
    for (const code of matchCodes) {
      const games = await prisma.game.findMany({ where: { match: { code } }, orderBy: { number: "asc" } });
      const scoreline = games.map((game) => `${game.scoreA}:${game.scoreB}`).join(" ");
      const publicDetail = await getPublicMatchDetail(slug, code);
      expect(publicDetail.match.games.filter((game) => game.scoreA !== null).map((game) => `${game.scoreA}:${game.scoreB}`).join(" ")).toBe(scoreline);
      expect(excelResults.find((row) => row[0] === code)?.[5]).toBe(scoreline);
      // 逐场结果页里带比分的那一行（状态列可能折行，不用它定位）。
      const line = text.split("\n").find((item) => item.includes(code) && /\d+:\d+ \d+:\d+/.test(item));
      expect(line, `PDF 中 ${code} 的结果行`).toBeDefined();
      expect(line).toContain(scoreline);
    }
    expect(excelPlacements).toHaveLength(4);
    for (const placement of excelPlacements) {
      const line = text.split("\n").find((item) => item.includes("最终名次") && item.includes(placement[3]));
      expect(line, `PDF 中 ${placement[3]} 的名次行`).toBeDefined();
      expect(line).toMatch(new RegExp(`最终名次\\s+${placement[2]}\\s+${placement[3]}`));
    }
  }, 120_000);

  it.skipIf(!HAS_PDFTOTEXT)("长表跨页时每页重复表头", async () => {
    const tournament = await prisma.tournament.findUniqueOrThrow({ where: { slug: "phase-1-demo" }, select: { id: true } });
    const captured = await captureReportSnapshot(tournament.id, "DRAFT");
    const { renderBookletHtml, bookletFooterTemplate } = await import("@/reports/booklet-html");
    const { renderPdf } = await import("@/server/services/pdf-renderer");
    const meta = { capturedAt: captured.capturedAt, snapshotHash: captured.snapshotHash, version: null };
    const pdf = await renderPdf(renderBookletHtml(captured.snapshot, meta), bookletFooterTemplate(captured.snapshot, meta));
    const pages = pdfText(pdf).split("\f");
    const resultPages = pages.filter((page) => page.includes("逐局比分"));
    expect(resultPages.length).toBeGreaterThanOrEqual(2);
    expect(resultPages.every((page) => /比赛编号\s+项目/.test(page))).toBe(true);
  }, 120_000);
});
