/**
 * 异常注入 · 裁判相关（测试方案 §13.9，逐场指派模式；M4）。
 *
 * - 赛前换人：裁判长开赛前换人，原裁判拿不到控制，新裁判可以取得。
 * - 换上的人正在别场执裁：409 referee_busy；只与已发布赛程时间重叠时只提示（返回 overlapping）不拒绝，随后换回。
 * - 中途换人，同一台设备交接：平板退出原裁判、新裁判登录继续——原会话被吊销、代次 +1、比分不丢，之后事件记在新裁判名下。
 * - 中途换人，换设备接管：新裁判用自己的手机进入；原手机之后的写入被拒。
 * - 裁判上一场拖长：开赛前挑一名裁判相邻两场（不同场地），前一场强制打长；观察后一场的延误推算（原因、预计开始）与实际开始。
 * - 指派冲突：建赛时已做（草稿里同一人排进重叠两场后发布被拦截），这里把那次结果登记为对照。
 */
import { sleep } from "../core/clock";
import { matchesOfTournament, prisma } from "../core/db";
import { Client } from "../core/http";
import type { Rng } from "../core/rng";
import type { Server } from "../core/server";
import { recordProbe, type ProbeVerdict, type RunContext, type TournamentRuntime } from "../scenario/context";
import { loadPublishedDelays } from "../../../src/server/services/schedule-facts";
import { brief, driver, toRally, withBorrowed, type Env } from "./injections";
import { available, checkIn, type Official } from "./officials";
import type { MatchStateView } from "./referee";
import type { LiveRegistry } from "./venue";
import { SIM_OFFICIATING_NAME } from "../officiating-name";

const GROUP = "§13.9 裁判相关（逐场指派）";

function probe(context: RunContext, item: { id: string; title: string; expected: string; actual: string; ok: boolean | "undefined" | "skipped"; match: string; detail?: Record<string, unknown> }) {
  const verdict: ProbeVerdict = item.ok === "undefined" ? "设计未定义" : item.ok === "skipped" ? "未触发" : item.ok ? "符合" : "不符";
  recordProbe(context, { id: item.id, group: GROUP, title: item.title, expected: item.expected, actual: item.actual, verdict, match: item.match, detail: item.detail });
}

/** 建赛后、开赛前调用：挑相邻两场的同一名裁判，前一场强制打长。 */
export async function planRefereeOverrun(context: RunContext, tournament: TournamentRuntime) {
  const matches = (await matchesOfTournament(tournament.id)).filter((match) => !match.rubberKind && match.scheduledAt && match.scheduledEndAt && match.officialAssignments[0] && match.sideAEntryId && match.sideBEntryId);
  const slack = 2 * 60_000;
  for (const first of matches.sort((x, y) => x.scheduledAt!.getTime() - y.scheduledAt!.getTime())) {
    const referee = first.officialAssignments[0].userId;
    const next = matches.find(
      (match) =>
        match.code !== first.code &&
        match.officialAssignments[0]?.userId === referee &&
        match.courtId !== first.courtId &&
        match.scheduledAt!.getTime() >= first.scheduledEndAt!.getTime() &&
        match.scheduledAt!.getTime() - first.scheduledEndAt!.getTime() <= slack &&
        !tournament.forced.has(match.code),
    );
    if (!next || tournament.forced.has(first.code)) continue;
    tournament.forced.set(first.code, { kind: "LONG", why: "§13.9 裁判上一场拖长" });
    context.log(`[注入] 裁判上一场拖长：${first.code} 强制打长，观察同一裁判的下一场 ${next.code}（另一块场地）`);
    return { first: first.code, next: next.code, nextId: next.id, refereeUserId: referee };
  }
  // 自动建议把裁判固定在一块场地，自然不会出现跨场地相邻的两场：由裁判长在开赛前把相邻另一块场地的下一场换给同一人
  // （正常的换人操作，赛程重叠只提示不拒绝；这里选的是与该裁判其他指派都不重叠的那一场）。
  const chief = tournament.chiefs[0]?.client;
  if (chief) {
    const overlapsOwn = (referee: string, candidate: (typeof matches)[number]) =>
      matches.some((match) => match.code !== candidate.code && match.officialAssignments[0]?.userId === referee && match.scheduledAt! < candidate.scheduledEndAt! && match.scheduledEndAt! > candidate.scheduledAt!);
    for (const first of matches) {
      if (tournament.forced.has(first.code)) continue;
      const referee = first.officialAssignments[0].userId;
      const next = matches.find(
        (match) =>
          match.courtId !== first.courtId &&
          !tournament.forced.has(match.code) &&
          match.officialAssignments[0].userId !== referee &&
          match.scheduledAt!.getTime() >= first.scheduledEndAt!.getTime() &&
          match.scheduledAt!.getTime() - first.scheduledEndAt!.getTime() <= slack &&
          !overlapsOwn(referee, match),
      );
      if (!next) continue;
      const swapped = await chief.call("POST", `/api/admin/tournaments/${tournament.slug}/schedule/matches/${next.code}/referee`, { refereeUserId: referee, reason: "仿真注入：构造同一裁判跨场地相邻两场" }, {
        route: "/api/admin/tournaments/[slug]/schedule/matches/[matchCode]/referee",
      });
      if (!swapped.ok) {
        context.log(`[注入] 裁判上一场拖长：把 ${next.code} 换给 ${first.code} 的裁判失败 ${swapped.status} ${swapped.code ?? ""}`);
        continue;
      }
      tournament.forced.set(first.code, { kind: "LONG", why: "§13.9 裁判上一场拖长" });
      context.log(`[注入] 裁判上一场拖长：${next.code} 由裁判长换给 ${first.code} 的裁判；${first.code} 强制打长，观察下一场（另一块场地）`);
      return { first: first.code, next: next.code, nextId: next.id, refereeUserId: referee };
    }
  }
  context.log("[注入] 裁判上一场拖长：没有找到同一裁判、不同场地、相邻的两场，也无法构造");
  return null;
}

export async function refereeInjectionLoop(options: {
  context: RunContext;
  tournament: TournamentRuntime;
  registry: LiveRegistry;
  server: Server;
  rng: Rng;
  overrun: Awaited<ReturnType<typeof planRefereeOverrun>>;
  only?: Set<string>;
}) {
  const { context, tournament, registry, only } = options;
  const env: Env = { context, tournament, registry, server: options.server, rng: options.rng, tablets: [] as unknown as Env["tablets"] };
  // 「拖长」两场在场地协程第一次选场之前就占住（这里到第一个 await 之间同步执行，场地协程还没来得及选）。
  const overrunPlan = options.overrun && (!only || only.has("overrun") || only.has("referee")) ? options.overrun : null;
  if (overrunPlan) {
    registry.active.set(overrunPlan.first, "inject-hold");
    registry.active.set(overrunPlan.next, "inject-hold");
  }
  const jobs: [string, () => Promise<void>][] = [
    ["swap-before", () => swapBeforeStart(env)],
    ["swap-busy", () => swapToBusy(env)],
    ["swap-mid", () => swapMidMatch(env, "same-device")],
    ["swap-mid-other", () => swapMidMatch(env, "other-device")],
    ["overrun", () => watchOverrun(env, options.overrun)],
  ];
  recordAssignmentConflict(env);
  await sleep(10_000);
  await Promise.allSettled(
    jobs
      .filter(([key]) => !only || only.has(key) || only.has("referee"))
      .map(async ([key, run]) => {
        try {
          await run();
        } catch (error) {
          recordProbe(context, { id: `13.9-${key}:*`, group: "脚本", title: `注入 ${key}`, expected: "—", actual: error instanceof Error ? `${error.message}\n${error.stack}` : String(error), verdict: "脚本错误" });
        }
      }),
  );
}

const chiefOf = (env: Env) => env.tournament.chiefs[0].client;

async function replaceReferee(env: Env, code: string, official: Official, reason: string) {
  return chiefOf(env).call<{ revokedSessions: number; overlapping: { code: string }[] }>("POST", `/api/admin/tournaments/${env.tournament.slug}/schedule/matches/${code}/referee`, { refereeUserId: official.userId, reason }, {
    route: "/api/admin/tournaments/[slug]/schedule/matches/[matchCode]/referee",
  });
}

const officialOf = (env: Env, userId: string | undefined) => env.tournament.officials.find((item) => item.userId === userId) ?? null;

/** 一场还没开始、双方已定的比赛，并先占住（场地协程不选），由回调处理完再放回。 */
async function holdUpcoming(env: Env, filter: (match: Awaited<ReturnType<typeof matchesOfTournament>>[number]) => boolean, body: (match: Awaited<ReturnType<typeof matchesOfTournament>>[number]) => Promise<void>) {
  const { registry } = env;
  while (!registry.stop) {
    const matches = await matchesOfTournament(env.tournament.id);
    const target = matches
      .filter((match) => ["SCHEDULED", "READY"].includes(match.lifecycleStatus) && match.version === 0 && !match.rubberKind && match.sideAEntryId && match.sideBEntryId && !registry.active.has(match.code) && !env.tournament.forced.has(match.code))
      .filter(filter)
      .sort((x, y) => (y.scheduledAt?.getTime() ?? 0) - (x.scheduledAt?.getTime() ?? 0))[0];
    if (target) {
      registry.active.set(target.code, "inject-hold");
      try {
        const fresh = await prisma.match.findUnique({ where: { code: target.code }, select: { version: true, lifecycleStatus: true } });
        if (fresh && fresh.version === 0 && ["SCHEDULED", "READY"].includes(fresh.lifecycleStatus)) {
          await body(target);
          return;
        }
      } finally {
        if (registry.active.get(target.code) === "inject-hold") registry.active.delete(target.code);
      }
    }
    await sleep(2000);
  }
}

async function swapBeforeStart(env: Env) {
  await holdUpcoming(env, (match) => Boolean(officialOf(env, match.officialAssignments[0]?.userId)), async (match) => {
    const original = officialOf(env, match.officialAssignments[0].userId)!;
    const replacement = env.tournament.officials.find((item) => item.userId !== original.userId && item.key !== "PLATFORM" && !item.busyWith);
    if (!replacement) return;
    const swapped = await replaceReferee(env, match.code, replacement, "仿真注入：开赛前换人");
    const oldTry = await original.client!.call("POST", `/api/matches/${match.code}/control`, { deviceSessionId: env.rng.uuid(), officiatingName: SIM_OFFICIATING_NAME }, { route: "/api/matches/[code]/control" });
    const newTry = await replacement.client!.call<{ sessionId: string; takeoverGeneration: number; controlToken: string }>("POST", `/api/matches/${match.code}/control`, { deviceSessionId: env.rng.uuid(), officiatingName: SIM_OFFICIATING_NAME }, { route: "/api/matches/[code]/control" });
    if (newTry.ok) {
      await replacement.client!.call("DELETE", `/api/matches/${match.code}/control`, { scoringSessionId: newTry.json!.sessionId, takeoverGeneration: newTry.json!.takeoverGeneration }, {
        route: "/api/matches/[code]/control",
        headers: { Authorization: `Bearer ${newTry.json!.controlToken}` },
      });
    }
    probe(env.context, {
      id: "13.9-swap-before",
      title: "赛前换人（裁判长开赛前换人）",
      expected: "原裁判拿不到控制权；新裁判可以正常取得",
      actual: `换人 ${brief(swapped)}（${original.key} → ${replacement.key}）；原裁判取得 ${brief(oldTry)}，新裁判取得 ${brief(newTry)}`,
      ok: swapped.ok && !oldTry.ok && newTry.ok,
      match: match.code,
    });
  });
}

async function swapToBusy(env: Env) {
  // 等到有裁判正在执裁。
  let busy: Official | undefined;
  while (!env.registry.stop && !busy) {
    busy = env.tournament.officials.find((item) => item.busyWith && item.key !== "PLATFORM" && env.registry.playing.has(item.busyWith));
    if (!busy) await sleep(2000);
  }
  if (!busy) return;
  const busyOfficial = busy;
  await holdUpcoming(env, (match) => match.officialAssignments[0]?.userId !== busyOfficial.userId, async (match) => {
    const live = await prisma.match.findUnique({ where: { code: busyOfficial.busyWith ?? "" }, select: { lifecycleStatus: true } });
    const refused = await replaceReferee(env, match.code, busyOfficial, "仿真注入：换上正在别场执裁的裁判");
    probe(env.context, {
      id: "13.9-swap-busy",
      title: "换上的人正在别场执裁",
      expected: "409 referee_busy",
      actual: `${busyOfficial.key} 正在 ${busyOfficial.busyWith}（${live?.lifecycleStatus ?? "?"}），换人 ${brief(refused)}`,
      ok: refused.status === 409 && refused.code === "referee_busy",
      match: match.code,
    });
    // 只与已发布赛程时间重叠：找一名此刻空闲、但已发布赛程里有与这场时间重叠的比赛的裁判；换上后再换回原裁判。
    const original = officialOf(env, match.officialAssignments[0]?.userId);
    const begin = match.scheduledAt?.getTime() ?? 0;
    const end = match.scheduledEndAt?.getTime() ?? begin;
    const others = await matchesOfTournament(env.tournament.id);
    const overlapping = others.find((item) => item.code !== match.code && item.officialAssignments[0] && item.scheduledAt && item.scheduledEndAt && item.scheduledAt.getTime() < end && item.scheduledEndAt.getTime() > begin && ["SCHEDULED", "READY"].includes(item.lifecycleStatus));
    const candidate = overlapping ? officialOf(env, overlapping.officialAssignments[0].userId) : null;
    if (!candidate || !original || candidate.userId === original.userId || candidate.busyWith) {
      probe(env.context, { id: "13.9-swap-overlap", title: "换上的人只与已发布赛程时间重叠", expected: "只提示、不拒绝", actual: "没有找到此刻空闲且已发布赛程与该场重叠的裁判", ok: "skipped", match: match.code });
      return;
    }
    const accepted = await replaceReferee(env, match.code, candidate, "仿真注入：换上与已发布赛程重叠的裁判");
    const restored = accepted.ok ? await replaceReferee(env, match.code, original, "仿真注入：换回原裁判") : null;
    probe(env.context, {
      id: "13.9-swap-overlap",
      title: "换上的人只与已发布赛程时间重叠",
      expected: "接受，并在回应里列出重叠的比赛（只提示、不拒绝）",
      actual: `${candidate.key}（已发布 ${overlapping!.code} 与本场重叠）换上 ${brief(accepted)}，提示重叠 ${accepted.json?.overlapping?.map((item) => item.code).join("、") || "无"}；换回原裁判 ${restored ? brief(restored) : "—"}`,
      ok: accepted.ok && (accepted.json?.overlapping?.length ?? 0) > 0 && Boolean(restored?.ok),
      match: match.code,
    });
  });
}

/** 中途换人。same-device：本场用一台平板（以原裁判登录），换人后平板退出、新裁判登录；other-device：新裁判用自己的手机。 */
async function swapMidMatch(env: Env, mode: "same-device" | "other-device") {
  const id = mode === "same-device" ? "13.9-swap-mid-same" : "13.9-swap-mid-other";
  const title = mode === "same-device" ? "中途换人，同一台设备交接" : "中途换人，换设备接管";
  await withBorrowed(
    env,
    title,
    async (borrowed) => {
      const code = borrowed.code;
      const original = borrowed.official;
      const device = mode === "same-device" ? new Client(env.context.origin, `inject-tablet-${code}`, env.context.metrics, env.context.nextIp()) : original.client!;
      if (mode === "same-device") await device.signIn(original.login, env.context.secrets[original.login]);
      const deviceSessionId = env.rng.uuid();
      const first = driver(env, borrowed, device, deviceSessionId);
      if (!(await first.acquire()).ok) throw new Error("原裁判取得控制失败");
      await first.refresh();
      await toRally(first, 4);
      const generation = first.control!.takeoverGeneration;
      const scoreBefore = { ...(first.state as MatchStateView).score, version: first.state!.version };

      // 接替者：空闲、不是平台共用账号。
      let replacement: Official | undefined;
      while (!env.registry.stop && !replacement) {
        replacement = env.tournament.officials.find((item) => item.userId !== original.userId && item.key !== "PLATFORM" && available(item));
        if (!replacement) await sleep(1000);
      }
      if (!replacement || !checkIn(env.context, replacement, code)) throw new Error("没有空闲的接替裁判");
      const swappedAt = Date.now();
      const swapped = await replaceReferee(env, code, replacement, `仿真注入：${title}`);
      borrowed.segments.push({ official: replacement, from: swappedAt });
      const oldWrite = await first.post(first.envelope("RALLY_WON", { side: "A" }));

      let next;
      if (mode === "same-device") {
        await device.signOut();
        await device.signIn(replacement.login, env.context.secrets[replacement.login]);
        next = driver(env, borrowed, device, deviceSessionId);
      } else {
        next = driver(env, borrowed, replacement.client!);
      }
      const acquired = await next.acquire();
      await next.refresh();
      const scoreAfter = next.state ? { ...next.state.score, version: next.state.version } : null;
      const firstCommand = acquired.ok ? await next.post(next.envelope("RALLY_WON", { side: "B" })) : null;
      const actor = firstCommand?.ok ? await prisma.matchEvent.findFirst({ where: { match: { code } }, orderBy: { version: "desc" }, select: { actorUserId: true } }) : null;
      probe(env.context, {
        id,
        title,
        expected: mode === "same-device" ? "原会话被吊销；新裁判取得控制时代次 +1，比分不丢；之后事件 actorUserId 是新裁判" : "同上；原手机之后的写入得到 not_controller 或无指派",
        actual: `换人 ${brief(swapped)}（吊销会话 ${swapped.json?.revokedSessions ?? "—"}）；原${mode === "same-device" ? "平板" : "手机"}再记分 ${brief(oldWrite)}；接替者取得 ${brief(acquired)}（代次 ${generation} → ${acquired.json?.takeoverGeneration ?? "—"}），比分 ${scoreBefore.A}:${scoreBefore.B} v${scoreBefore.version} → ${scoreAfter ? `${scoreAfter.A}:${scoreAfter.B} v${scoreAfter.version}` : "—"}；第一条命令 ${firstCommand ? brief(firstCommand) : "—"}，记在${actor?.actorUserId === replacement.userId ? "新裁判" : actor?.actorUserId === original.userId ? "原裁判" : "其他账号"}名下`,
        ok:
          swapped.ok &&
          (swapped.json?.revokedSessions ?? 0) >= 1 &&
          !oldWrite.ok &&
          acquired.ok &&
          acquired.json!.takeoverGeneration === generation + 1 &&
          scoreAfter?.A === scoreBefore.A &&
          scoreAfter?.B === scoreBefore.B &&
          actor?.actorUserId === replacement.userId,
        match: code,
        detail: { oldWrite: oldWrite.code },
      });
      return next.play();
    },
    // 逐场指派：由系统指派的那个人执裁，人要空闲。
    (match) => {
      const official = officialOf(env, match.officialAssignments[0]?.userId);
      return official && official.key !== "PLATFORM" && available(official) ? official : null;
    },
  );
}

async function watchOverrun(env: Env, plan: Awaited<ReturnType<typeof planRefereeOverrun>>) {
  if (!plan) {
    probe(env.context, { id: "13.9-referee-overrun", title: "裁判上一场拖长，耽误下一场", expected: "下一场显示延误，cause=REFEREE", actual: "建赛后没有找到同一裁判、不同场地、相邻的两场", ok: "skipped", match: "—" });
    return;
  }
  // C32 下一场长局的墙钟时长远短于计划时段，加上场地空了就提前开赛，前一场永远不会超出计划结束。
  // 构造：前一场压到计划结束前 30 秒才放行（强制长局），放行时同一裁判被占住，下一场只能等他——相当于「上一场晚开又打长」。
  const firstRow = await prisma.match.findUniqueOrThrow({ where: { code: plan.first }, select: { scheduledEndAt: true } });
  const releaseAt = firstRow.scheduledEndAt!.getTime() - 30_000;
  env.registry.intentionalWaits.set(`inject:overrun:${plan.first}`, releaseAt + 15 * 60_000);
  while (!env.registry.stop && Date.now() < releaseAt) await sleep(1000);
  env.registry.active.delete(plan.first);
  // 等前一场真正开打（裁判被占住）再放下一场。
  for (let index = 0; index < 600 && !env.registry.stop; index += 1) {
    const started = await prisma.match.findUnique({ where: { code: plan.first }, select: { startedAt: true } });
    if (started?.startedAt) break;
    await sleep(1000);
  }
  env.registry.active.delete(plan.next);
  env.registry.intentionalWaits.delete(`inject:overrun:${plan.first}`);
  const causes = new Set<string>();
  let maxDelay = 0;
  let projectedAtFirstEnd: number | null = null;
  let firstEndedAt: number | null = null;
  while (!env.registry.stop) {
    const rows = await prisma.match.findMany({ where: { code: { in: [plan.first, plan.next] } }, select: { code: true, startedAt: true, endedAt: true, scheduledAt: true, scheduledEndAt: true } });
    const first = rows.find((row) => row.code === plan.first);
    const next = rows.find((row) => row.code === plan.next);
    if (next?.startedAt) {
      const lag = next.scheduledAt ? Math.round((next.startedAt.getTime() - next.scheduledAt.getTime()) / 6000) / 10 : null;
      const firstOver = first?.endedAt && first.scheduledEndAt ? Math.round((first.endedAt.getTime() - first.scheduledEndAt.getTime()) / 6000) / 10 : null;
      // 延误推算取场地、裁判、选手三个约束里最晚的那个作原因：同场地前一场（加换场间隔）结束得更晚时，场地才是决定因素，
      // 这时归因 COURT 是对的，本项算「裁判约束没能单独构造出来」。
      const courtPrevious = await prisma.match.findFirst({
        where: { courtId: (await prisma.match.findUnique({ where: { code: plan.next }, select: { courtId: true } }))?.courtId ?? "", scheduledAt: { lt: next.scheduledAt ?? new Date(0) }, code: { not: plan.next } },
        orderBy: { scheduledAt: "desc" },
        select: { code: true, endedAt: true },
      });
      const changeoverMs = env.context.clock.profile.changeoverMinutes * 60_000;
      const courtBinding = Boolean(courtPrevious?.endedAt && first?.endedAt && courtPrevious.endedAt.getTime() + changeoverMs >= first.endedAt.getTime());
      probe(env.context, {
        id: "13.9-referee-overrun",
        title: "裁判上一场拖长，耽误下一场（不同场地）",
        expected: "下一场显示延误，cause=REFEREE；对比系统提示的预计开始与实际开始（构造：前一场压到计划结束前 30 秒才开打）",
        actual: `${plan.first} 超出计划结束 ${firstOverText(firstOver)}；${plan.next} 实际开始偏差 ${lag ?? "—"} 分钟，系统推算最大延误 ${maxDelay} 分钟，原因 ${[...causes].join("/") || "无"}；前一场结束时推算的开始 ${projectedAtFirstEnd ? new Date(projectedAtFirstEnd).toISOString().slice(11, 19) : "—"}，实际 ${next.startedAt.toISOString().slice(11, 19)}${courtBinding ? `；同场地前一场 ${courtPrevious!.code} 结束更晚（场地才是决定因素），裁判约束未单独构造出来` : ""}`,
        ok: causes.has("REFEREE") && maxDelay > 0 ? true : courtBinding && causes.has("COURT") ? "skipped" : false,
        match: plan.next,
        detail: { firstEndedAt, projectedAtFirstEnd, courtPrevious: courtPrevious?.code, courtPreviousEndedAt: courtPrevious?.endedAt, courtBinding },
      });
      return;
    }
    const delays = await loadPublishedDelays(prisma, env.tournament.id, new Date());
    const projection = delays.get(plan.nextId);
    if (projection?.delayed) {
      maxDelay = Math.max(maxDelay, projection.delayMinutes);
      if (projection.cause) causes.add(projection.cause);
    }
    if (first?.endedAt && !firstEndedAt) {
      firstEndedAt = first.endedAt.getTime();
      projectedAtFirstEnd = projection?.projectedStart ?? null;
    }
    await sleep(3000);
  }
}

const firstOverText = (minutes: number | null) => (minutes === null ? "—" : `${minutes} 分钟`);

/** 指派冲突：建赛时制造的裁判重叠草稿是否被发布拦截（schedule.ts 已做，这里登记成注入对照）。 */
function recordAssignmentConflict(env: Env) {
  const blocked = env.tournament.refereeDraft?.blockedPublish ?? null;
  probe(env.context, {
    id: "13.9-assign-conflict",
    title: "指派冲突：草稿中同一人排进时间重叠的两场后发布",
    expected: "REFEREE_OVERLAP 作为硬冲突拦截发布",
    actual: blocked ? `制造重叠 ${env.tournament.refereeDraft!.overlaps.length} 处，发布 ${blocked.status} ${blocked.code ?? ""}（REFEREE_OVERLAP ${blocked.refereeOverlapIssues} 条）` : "建赛时没有制造指派冲突",
    ok: blocked ? blocked.status === 409 && blocked.refereeOverlapIssues > 0 : "skipped",
    match: "—",
  });
}
