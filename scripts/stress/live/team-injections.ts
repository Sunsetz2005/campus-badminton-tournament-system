/**
 * 异常注入 · 团体与结果联动（测试方案 §7 团体部分；M4）。
 *
 * - 名单：注入接管一场对抗的名单提交（名单协程跳过它），依次做重复人员、正常提交、不带版本重复提交、带版本修改，
 *   一方故意拖到截止后由负责人提交（预计被拒）、管理员代交；名单里放一名同时报个人项目的队员。
 * - 同一对抗两小场由两名裁判长同时复核（对阵行锁 + 可串行化），之后由团体判定核对比分不丢不重。
 * - 结果重开联动：淘汰对阵已回填下一轮时重开上游结果——下一轮未开赛应撤回签位并重算，已开赛应 `downstream_started`。
 *   团体与个人淘汰各做一次（个人淘汰在 L1 也有，团体淘汰对阵在 L2 才有）。
 * - 淘汰对抗提前决出：赛后按库里事实核对未开始的小场记「未进行」、小组对抗打满。
 */
import { randomUUID } from "node:crypto";

import { sleep } from "../core/clock";
import { fixturesOf, matchesOfTournament, prisma } from "../core/db";
import { Client, type CallResult } from "../core/http";
import type { Rng } from "../core/rng";
import { recordProbe, type ProbeVerdict, type RunContext, type TournamentRuntime } from "../scenario/context";
import { RUBBER_GENDER } from "../scenario/roster";
import { confirmResult, type ReviewRecord } from "./chief";
import type { Control, MatchStateView } from "./referee";
import type { LiveRegistry } from "./venue";

const GROUP = "§7 团体与结果联动";

interface Env {
  context: RunContext;
  tournament: TournamentRuntime;
  registry: LiveRegistry;
  rng: Rng;
  reviews: ReviewRecord[];
  tablet: Client;
}

export async function teamInjectionLoop(options: { context: RunContext; tournament: TournamentRuntime; registry: LiveRegistry; rng: Rng; reviews: ReviewRecord[]; only?: Set<string> }) {
  const { context, tournament, only } = options;
  const tablet = new Client(context.origin, `inject-${tournament.plan.key}-tablet-team`, context.metrics, context.nextIp());
  await tablet.signIn(context.refereeLogin.login, context.refereeLogin.password);
  const env: Env = { ...options, tablet };
  const groups: [string, (env: Env) => Promise<void>][] = [
    ["lineup", lineupProbes],
    ["confirm", concurrentConfirmProbe],
    ["reopen", reopenProbes],
  ];
  await Promise.allSettled(
    groups
      .filter(([key]) => !only || only.has(key))
      .filter(([key]) => key === "reopen" || tournament.plan.team)
      .map(async ([key, run]) => {
        try {
          await run(env);
        } catch (error) {
          recordProbe(context, { id: `${key}:*`, group: "脚本", title: `注入组 ${key}`, expected: "—", actual: error instanceof Error ? `${error.message}\n${error.stack}` : String(error), verdict: "脚本错误" });
        }
      }),
  );
}

function probe(env: Env, item: { id: string; title: string; expected: string; actual: string; ok: boolean | "undefined" | "skipped"; match: string; detail?: Record<string, unknown> }) {
  const verdict: ProbeVerdict = item.ok === "undefined" ? "设计未定义" : item.ok === "skipped" ? "未触发" : item.ok ? "符合" : "不符";
  recordProbe(env.context, { id: item.id, group: GROUP, title: item.title, expected: item.expected, actual: item.actual, verdict, match: item.match, detail: item.detail });
}

const brief = (result: CallResult) => `${result.status}${result.code ? ` ${result.code}` : ""}`;

// ---------------------------------------------------------------- 名单

type Fixture = Awaited<ReturnType<typeof fixturesOf>>[number];

const OVERLAP_GENDERS: Record<string, string[]> = { MS: ["MALE"], MD: ["MALE"], WS: ["FEMALE"], WD: ["FEMALE"], XD: ["MALE", "FEMALE"] };

async function lineupProbes(env: Env) {
  const { context, tournament, registry } = env;
  const team = tournament.plan.team!;
  const competition = tournament.competitions.get(team.code)!;
  const deadlineMs = context.clock.profile.lineupDeadlineMinutes * 60_000;
  // 选一场双方已定、还没有任何名单、离截止至少 3 分钟的对抗；没有就等。
  let fixture: Fixture | null = null;
  const passed = new Set<string>();
  while (!registry.stop && !fixture) {
    const now = Date.now();
    fixture =
      (await fixturesOf(competition.id)).find((item) => {
        const first = Math.min(...item.matches.map((match) => match.scheduledAt?.getTime() ?? Infinity));
        return !passed.has(item.id) && item.sideAEntryId && item.sideBEntryId && !item.lineups.length && !item.lineupsRevealedAt && first - deadlineMs - now > 3 * 60_000;
      }) ?? null;
    if (!fixture) {
      await sleep(3000);
      continue;
    }
    // 占住后等名单协程手上已经发出的提交落地，再复查：占住之前它可能已在给这场交名单。
    tournament.lineupReserved.add(fixture.id);
    await sleep(5000);
    if (await prisma.fixtureLineup.count({ where: { fixtureId: fixture.id } })) {
      tournament.lineupReserved.delete(fixture.id);
      passed.add(fixture.id);
      fixture = null;
    }
  }
  if (!fixture) return;
  const fixtureId = fixture.id;
  const firstPlanned = Math.min(...fixture.matches.map((match) => match.scheduledAt!.getTime()));
  const deadline = firstPlanned - deadlineMs;
  // 本对抗在名单交齐前开不了：登记为有意等待，免得卡住检测在等截止时误判。
  registry.intentionalWaits.set(`inject:lineup:${fixture.code}`, deadline + 5 * 60_000);
  context.log(`[注入] 名单注入接管 ${fixture.code}（首个小场 ${new Date(firstPlanned).toISOString().slice(11, 16)}，截止 ${new Date(deadline).toISOString().slice(11, 19)}）`);

  const teamOf = (entryId: string) => tournament.teams.find((item) => item.entryId === entryId)!;
  const sideA = teamOf(fixture.sideAEntryId!);
  const sideB = teamOf(fixture.sideBEntryId!);
  const kinds = team.rubbers;
  const path = `/api/team/${tournament.slug}/fixtures/${fixtureId}/lineup`;
  const route = "/api/team/[slug]/fixtures/[fixtureId]/lineup";
  const versionOf = async (side: "A" | "B") => (await prisma.fixtureLineup.findUnique({ where: { fixtureId_side: { fixtureId, side } }, select: { version: true } }))?.version ?? null;

  // 1. 同一队员放进两场小场：优先选计划时间重叠、性别相容的两场；没有就选不重叠的两场。
  const valid = buildLineup(tournament, sideA.key, kinds, env.rng.fork("lineup:A")).rubbers;
  const intervals = fixture.matches.map((match) => ({ order: match.rubberOrder!, kind: match.rubberKind!, start: match.scheduledAt!.getTime(), end: match.scheduledAt!.getTime() + context.clock.profile.rubberMinutes * 60_000 }));
  let pair: { from: number; to: number; overlapping: boolean } | null = null;
  for (const left of intervals) {
    for (const right of intervals) {
      if (left.order >= right.order) continue;
      const shared = OVERLAP_GENDERS[left.kind].find((gender) => OVERLAP_GENDERS[right.kind].includes(gender));
      if (!shared) continue;
      const overlapping = left.start < right.end && right.start < left.end;
      if (!pair || (overlapping && !pair.overlapping)) pair = { from: left.order, to: right.order, overlapping };
    }
  }
  if (pair) {
    const duplicated = valid.map((item) => ({ ...item, participantIds: [...item.participantIds] }));
    const fromKind = kinds[pair.from - 1];
    const toKind = kinds[pair.to - 1];
    const gender = OVERLAP_GENDERS[fromKind].find((value) => OVERLAP_GENDERS[toKind].includes(value))!;
    const person = pickByGender(tournament, sideA.key, duplicated[pair.from - 1].participantIds, gender);
    const target = duplicated[pair.to - 1];
    const slot = target.participantIds.findIndex((id) => genderOf(tournament, sideA.key, id) === gender);
    if (person && slot >= 0) {
      target.participantIds[slot] = person;
      const result = await sideA.manager.call("POST", path, { rubbers: duplicated }, { route });
      if (pair.overlapping) {
        probe(env, {
          id: "7.15",
          title: "名单中同一队员放进时间重叠的两场小场",
          expected: "400 invalid_lineup",
          actual: `第 ${pair.from}、${pair.to} 场计划重叠，提交 ${brief(result)}${result.message ? `：${result.message}` : ""}`,
          ok: result.status === 400 && result.code === "invalid_lineup",
          match: fixture.code,
        });
      } else {
        const limits = await prisma.competition.findUnique({ where: { id: competition.id }, select: { teamMaxRubbersMale: true, teamMaxRubbersFemale: true } });
        probe(env, {
          id: "7.15",
          title: "名单中同一队员兼两场小场（本对抗没有计划重叠的同性别小场）",
          expected: "时间重叠或超过兼项上限时 400 invalid_lineup；两者都不满足时（读代码）接受",
          actual: `第 ${pair.from}、${pair.to} 场不重叠，兼项上限 男 ${limits?.teamMaxRubbersMale ?? "未设"} / 女 ${limits?.teamMaxRubbersFemale ?? "未设"}；提交 ${brief(result)}`,
          ok: "skipped",
          match: fixture.code,
        });
      }
      if (result.ok) {
        // 被接受了：后面的正常提交要按修改处理，先记下版本。
        valid.splice(0, valid.length, ...duplicated);
      }
    }
  }

  // 2. 截止前正常提交（若上一步已被接受，这一步就是不带版本的重复提交）。
  const existing = await versionOf("A");
  const first = await sideA.manager.call("POST", path, { rubbers: valid }, { route });
  const again = await sideA.manager.call("POST", path, { rubbers: valid }, { route });
  probe(env, {
    id: "7.14a",
    title: "截止前提交，再不带版本重复提交",
    expected: "首次成功；不带版本的重复提交 409 version_conflict",
    actual: `首次 ${brief(first)}${existing !== null ? `（此前已有第 ${existing} 版）` : ""}，不带版本重复 ${brief(again)}`,
    ok: (existing === null ? first.ok : first.status === 409) && again.status === 409 && again.code === "version_conflict",
    match: fixture.code,
  });
  const current = await versionOf("A");
  const amended = await sideA.manager.call("POST", path, { rubbers: buildLineup(tournament, sideA.key, kinds, env.rng.fork("lineup:A2")).rubbers, expectedVersion: current }, { route });
  const stale = await sideA.manager.call("POST", path, { rubbers: valid, expectedVersion: current }, { route });
  probe(env, {
    id: "7.14b",
    title: "截止前带版本修改；再用旧版本修改",
    expected: "带当前版本修改成功（版本 +1）；旧版本 409 version_conflict",
    actual: `当前第 ${current} 版，修改 ${brief(amended)} → 第 ${await versionOf("A")} 版；旧版本 ${brief(stale)}`,
    ok: amended.ok && (await versionOf("A")) === (current ?? 0) + 1 && stale.status === 409 && stale.code === "version_conflict",
    match: fixture.code,
  });

  // 3. B 方拖到截止之后：负责人提交，再由管理员代交。名单里放一名同时报个人项目的队员。
  while (!registry.stop && Date.now() <= deadline + 2000) await sleep(1000);
  if (registry.stop) {
    // 没等到截止就停了（超时、卡住或宿主暂停）：这时提交不是「截止后」，不记结果。
    tournament.lineupReserved.delete(fixtureId);
    registry.intentionalWaits.delete(`inject:lineup:${fixture.code}`);
    return;
  }
  const lateLineup = buildLineup(tournament, sideB.key, kinds, env.rng.fork("lineup:B"), true);
  const late = await sideB.manager.call("POST", path, { rubbers: lateLineup.rubbers }, { route });
  const byAdmin = await context.admin.call("POST", `/api/admin/tournaments/${tournament.slug}/fixtures/${fixtureId}/lineup`, { side: "B", rubbers: lateLineup.rubbers }, {
    route: "/api/admin/tournaments/[slug]/fixtures/[fixtureId]/lineup",
  });
  const afterLock = await sideA.manager.call("POST", path, { rubbers: valid, expectedVersion: await versionOf("A") }, { route });
  probe(env, {
    id: "7.14c",
    title: "截止后负责人提交、管理员代交；双方交齐后负责人再改",
    expected: "截止后负责人 409 lineup_deadline_passed；管理员代交成功；交齐后锁定，负责人修改被拒",
    actual: `负责人 ${brief(late)}，管理员代交 ${brief(byAdmin)}，交齐后 A 方再改 ${brief(afterLock)}`,
    ok: late.status === 409 && late.code === "lineup_deadline_passed" && byAdmin.ok && !afterLock.ok,
    match: fixture.code,
  });
  if (lateLineup.crossover) {
    const individual = await prisma.match.findMany({
      where: { stage: { competition: { tournamentId: tournament.id } }, rubberKind: null, OR: [{ sideAEntry: { members: { some: { participantId: lateLineup.crossover.participantId } } } }, { sideBEntry: { members: { some: { participantId: lateLineup.crossover.participantId } } } }] },
      select: { code: true, scheduledAt: true },
    });
    const rubber = fixture.matches.find((match) => match.rubberOrder === lateLineup.crossover!.order)!;
    const rubberStart = rubber.scheduledAt!.getTime();
    const rubberEnd = rubberStart + context.clock.profile.rubberMinutes * 60_000;
    const overlapping = individual.filter((match) => match.scheduledAt && match.scheduledAt.getTime() < rubberEnd && match.scheduledAt.getTime() + context.clock.profile.matchMinutes * 60_000 > rubberStart);
    probe(env, {
      id: "7.16",
      title: "名单队员同时报了个人项目",
      expected: "预计接受（名单校验不看个人项目时间）＝设计未定义",
      actual: `第 ${lateLineup.crossover.order} 场放入兼报个人项目的队员（个人比赛 ${individual.length} 场，其中与该小场计划重叠 ${overlapping.length} 场${overlapping.length ? `：${overlapping.map((item) => item.code).join("、")}` : ""}）；代交 ${brief(byAdmin)}`,
      ok: "undefined",
      match: fixture.code,
    });
  } else {
    probe(env, { id: "7.16", title: "名单队员同时报了个人项目", expected: "预计接受＝设计未定义", actual: "B 方名单里没有兼报个人项目的队员可选", ok: "skipped", match: fixture.code });
  }
  if (!byAdmin.ok) {
    // 管理员代交失败会让这场对抗永远开不了：交给名单协程按常规处理。
    tournament.lineupReserved.delete(fixtureId);
  }
  registry.intentionalWaits.delete(`inject:lineup:${fixture.code}`);
}

/** 与名单协程相同的组队方式；`preferCrossover` 时优先放一名同时报个人项目的队员，并返回放在哪一场。 */
function buildLineup(tournament: TournamentRuntime, teamKey: string, rubbers: readonly string[], rng: Rng, preferCrossover = false) {
  const planned = tournament.roster.teams.find((item) => item.key === teamKey)!;
  const individualStudents = new Set([...tournament.roster.entries.values()].flat().flatMap((entry) => entry.members.map((person) => person.studentId)));
  const used = new Set<string>();
  let crossover: { order: number; participantId: string } | null = null;
  const lineup = rubbers.map((kind, index) => {
    const take = (gender: "MALE" | "FEMALE") => {
      const pool = rng.shuffle(planned.members.filter((member) => member.person.gender === gender && member.rubberKinds.includes(kind as never) && !used.has(member.person.key)));
      const preferred = preferCrossover && !crossover ? pool.find((member) => individualStudents.has(member.person.studentId)) : undefined;
      const member = preferred ?? pool[0];
      if (!member) throw new Error(`${teamKey} 没有足够的 ${gender} 队员排 ${kind}`);
      used.add(member.person.key);
      const id = tournament.participantIdByStudentId.get(member.person.studentId)!;
      if (preferred) crossover = { order: index + 1, participantId: id };
      return id;
    };
    const gender = RUBBER_GENDER[kind as keyof typeof RUBBER_GENDER];
    const size = kind === "MS" || kind === "WS" ? 1 : 2;
    const ids = gender === "MIXED" ? [take("MALE"), take("FEMALE")] : Array.from({ length: size }, () => take(gender));
    return { order: index + 1, participantIds: ids };
  });
  return { rubbers: lineup, crossover: crossover as { order: number; participantId: string } | null };
}

function genderOf(tournament: TournamentRuntime, teamKey: string, participantId: string) {
  const planned = tournament.roster.teams.find((item) => item.key === teamKey)!;
  return planned.members.find((member) => tournament.participantIdByStudentId.get(member.person.studentId) === participantId)?.person.gender ?? null;
}

function pickByGender(tournament: TournamentRuntime, teamKey: string, ids: string[], gender: string) {
  return ids.find((id) => genderOf(tournament, teamKey, id) === gender) ?? null;
}

// ---------------------------------------------------------------- 同一对抗两小场同时复核

async function concurrentConfirmProbe(env: Env) {
  const { context, tournament, registry } = env;
  if (tournament.chiefs.length < 2) {
    probe(env, { id: "7.18", title: "同一对抗两小场由两名裁判长同时复核", expected: "比分不丢不重", actual: "本规模只有 1 名裁判长", ok: "skipped", match: "—" });
    return;
  }
  const competition = tournament.competitions.get(tournament.plan.team!.code)!;
  // 选一场还没开打的小组对抗（小组对抗打满，三场都会有结果），把前两场的复核挂起。
  let fixture: Fixture | null = null;
  while (!registry.stop && !fixture) {
    fixture = (await fixturesOf(competition.id)).find((item) => item.groupId && item.sideAEntryId && item.sideBEntryId && !tournament.lineupReserved.has(item.id) && item.matches.every((match) => match.lifecycleStatus === "SCHEDULED" || match.lifecycleStatus === "READY")) ?? null;
    if (!fixture) await sleep(3000);
  }
  if (!fixture) return;
  const [first, second] = fixture.matches.filter((match) => !match.notPlayedAt).slice(0, 2).map((match) => match.code);
  const holdUntil = Date.now() + 60 * 60_000;
  tournament.reviewHoldUntil.set(first, holdUntil);
  tournament.reviewHoldUntil.set(second, holdUntil);
  context.log(`[注入] ${fixture.code} 的 ${first}、${second} 复核挂起，等两场都待复核后由两名裁判长同时复核`);
  try {
    for (;;) {
      if (registry.stop) return;
      const rows = await prisma.match.findMany({ where: { code: { in: [first, second] } }, select: { code: true, verificationStatus: true } });
      if (rows.length === 2 && rows.every((row) => row.verificationStatus === "PENDING_REVIEW")) break;
      await sleep(1000);
    }
    const startedAt = Date.now();
    const [a, b] = await Promise.all([
      confirmResult(context, tournament.chiefs[0].client, first, env.rng.fork("confirm:1")),
      confirmResult(context, tournament.chiefs[1].client, second, env.rng.fork("confirm:2")),
    ]);
    env.reviews.push({ matchCode: first, chief: tournament.chiefs[0].login, submittedSeenAt: startedAt, ...a });
    env.reviews.push({ matchCode: second, chief: tournament.chiefs[1].login, submittedSeenAt: startedAt, ...b });
    const after = await prisma.match.findMany({ where: { code: { in: [first, second] } }, select: { code: true, verificationStatus: true, games: { select: { scoreA: true, scoreB: true } } } });
    probe(env, {
      id: "7.18",
      title: "同一对抗两小场由两名裁判长同时复核",
      expected: "两条都受理；对抗小场比分不丢不重（团体判定另行独立核对）",
      actual: `${first} ${a.status}${a.code ? ` ${a.code}` : ""}，${second} ${b.status}${b.code ? ` ${b.code}` : ""}；复核后 ${after.map((row) => `${row.code.split("-").pop()} ${row.verificationStatus}（${row.games.map((game) => `${game.scoreA}:${game.scoreB}`).join(" ")}）`).join("，")}`,
      ok: Boolean(a.confirmedAt && b.confirmedAt) && after.every((row) => row.verificationStatus === "LOCKED"),
      match: fixture.code,
    });
  } finally {
    tournament.reviewHoldUntil.delete(first);
    tournament.reviewHoldUntil.delete(second);
  }
}

// ---------------------------------------------------------------- 结果重开联动

/**
 * 淘汰对阵已回填下一轮时重开上游结果。对团体（对抗的决胜小场）与个人淘汰各做一次「下一轮未开赛」，再各做一次「已开赛」。
 * 「未开赛」时为确定能在下一轮开赛前完成，先把下一轮的比赛登记为仿真占用（场地协程不选），重开 → 重交 → 复核锁定后放回。
 */
async function reopenProbes(env: Env) {
  const variants: { key: "team" | "individual"; label: string }[] = [
    { key: "team", label: "团体对抗" },
    { key: "individual", label: "个人淘汰" },
  ];
  await Promise.allSettled(variants.map(async (variant) => {
    if (variant.key === "team" && !env.tournament.plan.team) return;
    await reopenCase(env, variant, "not_started");
    await reopenCase(env, variant, "started");
  }));
}

async function reopenCase(env: Env, variant: { key: "team" | "individual"; label: string }, mode: "not_started" | "started") {
  const { registry } = env;
  const id = `7.19-${variant.key}-${mode === "not_started" ? "a" : "b"}`;
  const title = `${variant.label}结果重开：下一轮${mode === "not_started" ? "未开赛" : "已开赛"}`;
  const expected = mode === "not_started" ? "撤回下一轮签位并重算；重交、复核后重新回填" : "409 downstream_started，结果不变";
  const deadline = Date.now() + 90 * 60_000;
  for (;;) {
    if (registry.stop || Date.now() > deadline) {
      probe(env, { id, title, expected, actual: "运行中没有出现符合条件的对阵", ok: "skipped", match: "—" });
      return;
    }
    const candidate = await findReopenCandidate(env, variant.key, mode);
    if (!candidate) {
      await sleep(1000);
      continue;
    }
    const { upstream, downstream, reopenCode, side } = candidate;
    const held = downstream.matches.map((match) => match.code);
    if (mode === "not_started") {
      // 先占住下一轮，再复查确实没开赛（占住之前可能刚被场地协程选中）。
      for (const code of held) if (!registry.active.has(code)) registry.active.set(code, "inject-hold");
      registry.intentionalWaits.set(`inject:reopen:${upstream.code}`, Date.now() + 20 * 60_000);
      const started = await prisma.match.count({ where: { code: { in: held }, OR: [{ lifecycleStatus: { notIn: ["SCHEDULED", "READY"] } }, { version: { gt: 0 } }] } });
      if (started) {
        for (const code of held) if (registry.active.get(code) === "inject-hold") registry.active.delete(code);
        registry.intentionalWaits.delete(`inject:reopen:${upstream.code}`);
        continue;
      }
    }
    try {
      await runReopen(env, { id, title, expected, mode, upstream, downstream, reopenCode, side });
    } finally {
      for (const code of held) if (registry.active.get(code) === "inject-hold") registry.active.delete(code);
      registry.intentionalWaits.delete(`inject:reopen:${upstream.code}`);
    }
    return;
  }
}

type FixtureRow = Awaited<ReturnType<typeof loadFixtures>>[number];

async function loadFixtures(tournamentId: string) {
  return prisma.fixture.findMany({
    where: { competition: { tournamentId }, kind: { in: ["KNOCKOUT", "THIRD_PLACE"] } },
    select: {
      id: true,
      code: true,
      competition: { select: { code: true, entryType: true } },
      sideAEntryId: true,
      sideBEntryId: true,
      sideAFixtureId: true,
      sideBFixtureId: true,
      winnerEntryId: true,
      decidedAt: true,
      matches: { select: { code: true, lifecycleStatus: true, verificationStatus: true, version: true, notPlayedAt: true, sideAEntryId: true, sideBEntryId: true, games: { select: { scoreA: true, scoreB: true, completed: true } } }, orderBy: { rubberOrder: "asc" } },
    },
  });
}

async function findReopenCandidate(env: Env, kind: "team" | "individual", mode: "not_started" | "started") {
  const fixtures = await loadFixtures(env.tournament.id);
  const byId = new Map(fixtures.map((item) => [item.id, item]));
  for (const downstream of fixtures) {
    if (kind === "team" ? downstream.competition.entryType !== "TEAM" : downstream.competition.entryType === "TEAM") continue;
    const started = downstream.matches.some((match) => match.version > 0 || !["SCHEDULED", "READY"].includes(match.lifecycleStatus));
    if (mode === "not_started" ? started : !started) continue;
    for (const side of ["A", "B"] as const) {
      const upstreamId = side === "A" ? downstream.sideAFixtureId : downstream.sideBFixtureId;
      const filled = side === "A" ? downstream.sideAEntryId : downstream.sideBEntryId;
      const upstream = upstreamId ? byId.get(upstreamId) : undefined;
      if (!upstream || !filled || !upstream.winnerEntryId) continue;
      // 重开哪一场：个人淘汰就是那一场；团体取胜方赢下的最后一个已锁定小场（决胜小场）。
      const locked = upstream.matches.filter((match) => match.verificationStatus === "LOCKED" && !match.notPlayedAt);
      const winnerSide = upstream.winnerEntryId === upstream.sideAEntryId ? "A" : "B";
      const gameWinner = (game: { scoreA: number; scoreB: number; completed: boolean }) => (!game.completed ? null : game.scoreA > game.scoreB ? "A" : "B");
      const decider = [...locked].reverse().find((match) => {
        const won = match.games.filter((game) => gameWinner(game) === winnerSide).length;
        const lost = match.games.filter((game) => gameWinner(game) && gameWinner(game) !== winnerSide).length;
        return won > lost;
      });
      if (!decider) continue;
      return { upstream, downstream, reopenCode: decider.code, side };
    }
  }
  return null;
}

async function runReopen(env: Env, item: { id: string; title: string; expected: string; mode: "not_started" | "started"; upstream: FixtureRow; downstream: FixtureRow; reopenCode: string; side: "A" | "B" }) {
  const { tournament } = env;
  const chief = tournament.chiefs[0];
  const sideField = item.side === "A" ? "sideAEntryId" : "sideBEntryId";
  const before = { winner: item.upstream.winnerEntryId, downstreamSide: item.downstream[sideField] };
  const takeover = await chief.client.call<Control>("POST", `/api/matches/${item.reopenCode}/control/takeover`, { deviceSessionId: randomUUID(), reason: "仿真注入：结果重开联动" }, { route: "/api/matches/[code]/control/takeover" });
  if (!takeover.ok) {
    probe(env, { id: item.id, title: item.title, expected: item.expected, actual: `裁判长接管 ${item.reopenCode} 失败 ${brief(takeover)}`, ok: false, match: item.reopenCode });
    return;
  }
  const control = takeover.json!;
  const auth = { Authorization: `Bearer ${control.controlToken}` };
  const state = await chief.client.call<{ state: MatchStateView }>("GET", `/api/matches/${item.reopenCode}/state`, undefined, { route: "/api/matches/[code]/state" });
  const commandId = randomUUID();
  const reopen = await chief.client.call("POST", `/api/matches/${item.reopenCode}/commands`, {
    commandId,
    occurredAt: new Date().toISOString(),
    expectedVersion: state.json?.state?.version,
    scoringSessionId: control.sessionId,
    takeoverGeneration: control.takeoverGeneration,
    type: "REOPEN_RESULT",
    payload: { reason: "仿真注入：重开已回填下一轮的结果" },
  }, { route: "/api/matches/[code]/commands", headers: auth, note: "REOPEN_RESULT" });
  env.reviews.push({ matchCode: item.reopenCode, chief: chief.login, submittedSeenAt: Date.now(), confirmedAt: null, commandId: reopen.ok ? commandId : null, status: reopen.status, code: reopen.code });
  await chief.client.call("DELETE", `/api/matches/${item.reopenCode}/control`, { scoringSessionId: control.sessionId, takeoverGeneration: control.takeoverGeneration }, { route: "/api/matches/[code]/control", headers: auth });
  const afterReopen = await prisma.fixture.findUnique({ where: { id: item.downstream.id }, select: { sideAEntryId: true, sideBEntryId: true } });
  const upstreamAfter = await prisma.fixture.findUnique({ where: { id: item.upstream.id }, select: { winnerEntryId: true } });

  if (item.mode === "started") {
    probe(env, {
      id: item.id,
      title: item.title,
      expected: item.expected,
      actual: `重开 ${item.reopenCode}：${brief(reopen)}；下一轮 ${item.downstream.code} 的 ${item.side} 方${afterReopen?.[sideField] === before.downstreamSide ? "不变" : "被改动"}`,
      ok: reopen.status === 409 && reopen.code === "downstream_started" && afterReopen?.[sideField] === before.downstreamSide,
      match: item.reopenCode,
    });
    return;
  }
  if (!reopen.ok) {
    probe(env, { id: item.id, title: item.title, expected: item.expected, actual: `重开 ${item.reopenCode} 被拒 ${brief(reopen)}${reopen.message ? `：${reopen.message}` : ""}`, ok: false, match: item.reopenCode });
    return;
  }
  // 裁判（共用账号平板）重新提交，交给裁判长复核协程锁定；等下一轮重新回填。
  const resubmit = await resubmitResult(env, item.reopenCode);
  let refilled: string | null = null;
  const until = Date.now() + 10 * 60_000;
  while (Date.now() < until && !env.registry.stop) {
    const row = await prisma.fixture.findUnique({ where: { id: item.downstream.id }, select: { sideAEntryId: true, sideBEntryId: true } });
    const locked = await prisma.match.findUnique({ where: { code: item.reopenCode }, select: { verificationStatus: true } });
    if (locked?.verificationStatus === "LOCKED" && row?.[sideField]) {
      refilled = row[sideField];
      break;
    }
    await sleep(1000);
  }
  probe(env, {
    id: item.id,
    title: item.title,
    expected: item.expected,
    actual: `重开 ${item.reopenCode}：${brief(reopen)}；上游胜方 ${upstreamAfter?.winnerEntryId ? "仍在" : "已撤回"}，下一轮 ${item.downstream.code} 的 ${item.side} 方 ${afterReopen?.[sideField] ? "仍在（未撤回）" : "已撤回"}；重交 ${resubmit}；复核锁定后下一轮${refilled ? (refilled === before.downstreamSide ? "重新回填（同一方）" : "回填为另一方") : "未回填（10 分钟内）"}`,
    ok: !upstreamAfter?.winnerEntryId && !afterReopen?.[sideField] && Boolean(refilled),
    match: item.reopenCode,
  });
}

async function resubmitResult(env: Env, code: string) {
  const deviceSessionId = env.rng.uuid();
  const acquired = await env.tablet.call<Control>("POST", `/api/matches/${code}/control`, { deviceSessionId }, { route: "/api/matches/[code]/control" });
  if (!acquired.ok) return `取得控制 ${brief(acquired)}`;
  const control = acquired.json!;
  const auth = { Authorization: `Bearer ${control.controlToken}` };
  const state = await env.tablet.call<{ state: MatchStateView }>("GET", `/api/matches/${code}/state`, undefined, { route: "/api/matches/[code]/state" });
  const commandId = randomUUID();
  const submit = await env.tablet.call("POST", `/api/matches/${code}/commands`, {
    commandId,
    occurredAt: new Date().toISOString(),
    expectedVersion: state.json?.state?.version,
    scoringSessionId: control.sessionId,
    takeoverGeneration: control.takeoverGeneration,
    type: "SUBMIT_RESULT",
    payload: { reason: "仿真注入：重开后重新提交" },
  }, { route: "/api/matches/[code]/commands", headers: auth, note: "SUBMIT_RESULT" });
  env.reviews.push({ matchCode: code, chief: "（裁判重交）", submittedSeenAt: Date.now(), confirmedAt: null, commandId: submit.ok ? commandId : null, status: submit.status, code: submit.code });
  await env.tablet.call("DELETE", `/api/matches/${code}/control`, { scoringSessionId: control.sessionId, takeoverGeneration: control.takeoverGeneration }, { route: "/api/matches/[code]/control", headers: auth });
  return `${state.json?.state?.phase ?? "?"} → ${brief(submit)}`;
}

// ---------------------------------------------------------------- 赛后：淘汰对抗提前决出

export async function teamOutcomeProbes(context: RunContext, tournament: TournamentRuntime) {
  if (!tournament.plan.team) return;
  const competition = tournament.competitions.get(tournament.plan.team.code)!;
  const fixtures = await fixturesOf(competition.id);
  const knockout = fixtures.filter((item) => !item.groupId && item.decidedAt);
  const early = knockout.filter((item) => item.matches.some((match) => match.notPlayedAt));
  const groupUnplayed = fixtures.filter((item) => item.groupId && item.matches.some((match) => match.notPlayedAt));
  const matches = new Map((await matchesOfTournament(tournament.id)).map((match) => [match.code, match]));
  const startedButNotPlayed = early.flatMap((item) => item.matches.filter((match) => match.notPlayedAt && (matches.get(match.code)?.version ?? 0) > 0).map((match) => match.code));
  recordProbe(context, {
    id: "7.17",
    group: GROUP,
    title: "淘汰对抗提前决出",
    expected: "未开始的小场记「未进行」；已开始的照常打完计入；小组对抗打满",
    actual: `淘汰对抗 ${knockout.length} 场，其中提前决出 ${early.length} 场（${early.map((item) => `${item.code}：${item.matches.filter((match) => match.notPlayedAt).map((match) => match.rubberOrder).join("、")} 未进行`).join("；") || "无"}）；已开始却记未进行 ${startedButNotPlayed.length} 场；小组对抗出现未进行 ${groupUnplayed.length} 场`,
    verdict: early.length === 0 ? "未触发" : startedButNotPlayed.length === 0 && groupUnplayed.length === 0 ? "符合" : "不符",
    match: early.map((item) => item.code).join("、") || "—",
  });
}
