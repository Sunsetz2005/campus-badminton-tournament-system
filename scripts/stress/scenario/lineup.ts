/**
 * 团体出场名单（§4 第 6 步）：对阵双方确定后，各队负责人盲交；每个小场用不同队员，避免同一人时间重叠。
 * 截止（首个小场计划开始前 lineupDeadlineMinutes）后负责人提交得 `lineup_deadline_passed`，按系统设计由管理员代交并标逾期——
 * 每次代交都记一条发现（P-06：截止按计划时间计算、不随延误顺延）。
 */
import { sleep } from "../core/clock";
import { fixturesOf } from "../core/db";
import type { Rng } from "../core/rng";
import type { LiveRegistry } from "../live/venue";
import type { RunContext, TeamRuntime, TournamentRuntime } from "./context";
import { addFinding } from "./context";
import { RUBBER_GENDER } from "./roster";

export interface LineupRecord {
  fixture: string;
  team: string;
  by: "manager" | "admin";
  status: number;
  code: string | null;
  at: number;
  /** 5xx 后的第几次重试（首交不填）。 */
  attempt?: number;
}

/** 负责人遇到 5xx 后的重试：指数退避（现实 10、20、40、80、160 秒，经压缩时钟），最多 5 次。 */
const RETRY_LIMIT = 5;
const RETRY_BASE_REAL_SECONDS = 10;

type Fixture = Awaited<ReturnType<typeof fixturesOf>>[number];

export async function lineupLoop(options: { context: RunContext; tournament: TournamentRuntime; registry: LiveRegistry; rng: Rng; records: LineupRecord[] }) {
  const { context, tournament, registry, rng, records } = options;
  const team = tournament.plan.team;
  if (!team) return;
  const competition = tournament.competitions.get(team.code)!;
  const submitted = new Set<string>();
  const retries: Promise<void>[] = [];
  const teamByEntry = new Map(tournament.teams.map((item) => [item.entryId, item]));
  while (!registry.stop) {
    for (const fixture of await fixturesOf(competition.id)) {
      if (fixture.lineupsRevealedAt || fixture.decidedAt || tournament.lineupReserved.has(fixture.id)) continue;
      for (const side of ["A", "B"] as const) {
        const entryId = side === "A" ? fixture.sideAEntryId : fixture.sideBEntryId;
        if (!entryId) continue;
        const key = `${fixture.id}:${side}`;
        if (submitted.has(key) || fixture.lineups.some((lineup) => lineup.side === side)) continue;
        const owner = teamByEntry.get(entryId);
        if (!owner) continue;
        if (context.inject.withholdLineup && side === "A" && fixture.sideBEntryId && (context.inject.withheldKey === null || context.inject.withheldKey === key)) {
          if (context.inject.withheldKey === null) {
            context.inject.withheldKey = key;
            context.log(`[注入] ${fixture.code} A 方负责人始终不交名单`);
          }
          continue;
        }
        const rubbers = buildLineup(tournament, owner, team.rubbers, rng.fork(`lineup:${fixture.code}:${side}`));
        const injected = context.inject.lineup500 && !context.inject.lineup500Used ? context.inject.lineup500 : null;
        if (injected) context.inject.lineup500Used = true;
        const byManager = injected === "unsent"
          ? injectedServerError(context, owner.key)
          : await owner.manager.call("POST", `/api/team/${tournament.slug}/fixtures/${fixture.id}/lineup`, { rubbers }, {
              route: "/api/team/[slug]/fixtures/[fixtureId]/lineup",
            });
        if (injected === "saved") {
          context.log(`[注入] ${fixture.code} ${owner.name} 名单真实提交得到 ${byManager.status}，回应换成 500`);
          Object.assign(byManager, injectedServerError(context, owner.key));
        } else if (injected) {
          context.log(`[注入] ${fixture.code} ${owner.name} 名单提交不发出，直接得到 500`);
        }
        records.push({ fixture: fixture.code, team: owner.key, by: "manager", status: byManager.status, code: byManager.code, at: Date.now() });
        if (byManager.ok) {
          submitted.add(key);
          continue;
        }
        if (byManager.code === "lineup_deadline_passed") {
          const byAdmin = await context.admin.call("POST", `/api/admin/tournaments/${tournament.slug}/fixtures/${fixture.id}/lineup`, { side, rubbers }, {
            route: "/api/admin/tournaments/[slug]/fixtures/[fixtureId]/lineup",
          });
          records.push({ fixture: fixture.code, team: owner.key, by: "admin", status: byAdmin.status, code: byAdmin.code, at: Date.now() });
          addFinding(context, {
            kind: "observation",
            area: "出场名单",
            title: `${fixture.code} ${owner.name} 名单截止已过，由管理员代交`,
            detail: { fixture: fixture.code, side, firstRubberPlanned: fixture.matches[0]?.scheduledAt ?? null, adminStatus: byAdmin.status, adminCode: byAdmin.code },
          });
          if (byAdmin.ok) submitted.add(key);
          continue;
        }
        if (byManager.status >= 500) {
          // 5xx 一律计入报告（Metrics 另有逐条 5xx 记录），重试成功也不抵消。重试在后台进行，不挡住其他对阵的名单。
          submitted.add(key);
          addFinding(context, {
            kind: "unexpected",
            area: "出场名单",
            title: `${fixture.code} ${owner.name} 提交名单得到 ${byManager.status} ${byManager.code ?? ""}，负责人退避后重试`,
            detail: { fixture: fixture.code, side, status: byManager.status, code: byManager.code, message: byManager.message, at: new Date().toISOString() },
          });
          retries.push(retryAfterServerError({ context, tournament, competitionId: competition.id, fixture, side, owner, rubbers, records, registry }));
          continue;
        }
        submitted.add(key);
        addFinding(context, { kind: "blocked", area: "出场名单", title: `${fixture.code} ${owner.name} 提交名单被拒绝`, detail: { status: byManager.status, code: byManager.code, message: byManager.message } });
      }
    }
    await sleep(2000);
  }
  await Promise.allSettled(retries);
}

/**
 * 5xx 之后负责人怎么做：等一会儿，刷新页面看名单到底存上没有；确认没存上，再按当前版本号重交。
 * 「当前状态」取两处：负责人刷新团体对抗页（真实用户路径，只看是否打得开）与库里的权威名单（只读，取版本号）。
 */
async function retryAfterServerError(options: {
  context: RunContext;
  tournament: TournamentRuntime;
  competitionId: string;
  fixture: Fixture;
  side: "A" | "B";
  owner: TeamRuntime;
  rubbers: ReturnType<typeof buildLineup>;
  records: LineupRecord[];
  registry: LiveRegistry;
}) {
  const { context, tournament, competitionId, fixture, side, owner, rubbers, records, registry } = options;
  const subject = `${fixture.code} ${owner.name}`;
  const history: { attempt: number; at: string; status: number; code: string | null; pageStatus: number; savedBefore: boolean }[] = [];
  for (let attempt = 1; attempt <= RETRY_LIMIT; attempt += 1) {
    // 退避期间是仿真有意的等待：登记给卡住检测，免得「正在等负责人重试」被判为卡住。
    const backoff = context.clock.ms(RETRY_BASE_REAL_SECONDS * 2 ** (attempt - 1));
    const waitKey = `lineup:${fixture.code}:${side}`;
    registry.intentionalWaits.set(waitKey, Date.now() + backoff + 30_000);
    await sleep(backoff);
    if (registry.stop) return;
    const page = await owner.manager.call("GET", `/team/${tournament.slug}/ties/${fixture.id}`, undefined, { route: "/team/[slug]/ties/[fixtureId]", note: `retry-refresh-${attempt}` });
    const current = (await fixturesOf(competitionId)).find((item) => item.id === fixture.id);
    const mine = current?.lineups.find((lineup) => lineup.side === side) ?? null;
    if (mine) {
      // 事务已回滚，按理不会出现；出现就说明 500 时其实已写入，负责人会重复提交。
      history.push({ attempt, at: new Date().toISOString(), status: 0, code: "already_saved", pageStatus: page.status, savedBefore: true });
      addFinding(context, { kind: "unexpected", area: "出场名单", title: `${subject} 得到 5xx 后刷新发现名单已保存（第 ${mine.version} 版）`, detail: { fixture: fixture.code, side, history } });
      return;
    }
    if (current?.lineupsRevealedAt || current?.decidedAt) {
      addFinding(context, { kind: "blocked", area: "出场名单", title: `${subject} 重试前对抗已公开名单或已决出，停止重试`, detail: { fixture: fixture.code, side, history } });
      return;
    }
    // 确认本方还没有名单：当前版本为「无」，按 null 重交（服务端以 expectedVersion 防止覆盖别人刚交的版本）。
    const result = await owner.manager.call("POST", `/api/team/${tournament.slug}/fixtures/${fixture.id}/lineup`, { rubbers, expectedVersion: null }, {
      route: "/api/team/[slug]/fixtures/[fixtureId]/lineup",
      note: `retry-${attempt}`,
    });
    records.push({ fixture: fixture.code, team: owner.key, by: "manager", status: result.status, code: result.code, at: Date.now(), attempt });
    history.push({ attempt, at: new Date().toISOString(), status: result.status, code: result.code, pageStatus: page.status, savedBefore: false });
    if (result.ok) {
      registry.intentionalWaits.delete(waitKey);
      addFinding(context, { kind: "observation", area: "出场名单", title: `${subject} 第 ${attempt} 次重试提交成功（此前的 5xx 仍计入报告）`, detail: { fixture: fixture.code, side, history } });
      return;
    }
    if (result.code === "version_conflict") {
      // 版本冲突不直接算失败：再查一次名单。已经存上（例如上一次其实写入了）就算完成；仍然没有就按退避继续重试。
      const after = (await fixturesOf(competitionId)).find((item) => item.id === fixture.id);
      const saved = after?.lineups.find((lineup) => lineup.side === side) ?? null;
      history.push({ attempt, at: new Date().toISOString(), status: 0, code: saved ? "conflict_then_saved" : "conflict_not_saved", pageStatus: page.status, savedBefore: Boolean(saved) });
      if (saved) {
        registry.intentionalWaits.delete(waitKey);
        addFinding(context, { kind: "unexpected", area: "出场名单", title: `${subject} 重试得到 version_conflict，复查发现名单已保存（第 ${saved.version} 版），不再重交`, detail: { fixture: fixture.code, side, history } });
        return;
      }
      continue;
    }
    if (result.code === "lineup_deadline_passed") {
      addFinding(context, {
        kind: "blocked",
        area: "出场名单",
        title: `500 + 截止：${subject} 5xx 后重试时已过名单截止（${result.status} ${result.code}），转管理员代交`,
        detail: { combination: "server_error_then_deadline", fixture: fixture.code, side, firstRubberPlanned: fixture.matches[0]?.scheduledAt ?? null, response: { status: result.status, code: result.code, message: result.message }, history },
      });
      const byAdmin = await context.admin.call("POST", `/api/admin/tournaments/${tournament.slug}/fixtures/${fixture.id}/lineup`, { side, rubbers }, {
        route: "/api/admin/tournaments/[slug]/fixtures/[fixtureId]/lineup",
        note: "after-server-error",
      });
      records.push({ fixture: fixture.code, team: owner.key, by: "admin", status: byAdmin.status, code: byAdmin.code, at: Date.now(), attempt });
      if (!byAdmin.ok) addFinding(context, { kind: "blocked", area: "出场名单", title: `${subject} 管理员代交也失败（${byAdmin.status} ${byAdmin.code}）`, detail: { fixture: fixture.code, side, history } });
      return;
    }
    if (result.status < 500) {
      addFinding(context, { kind: "blocked", area: "出场名单", title: `${subject} 重试被拒绝（${result.status} ${result.code}）`, detail: { fixture: fixture.code, side, message: result.message, history } });
      return;
    }
  }
  registry.intentionalWaits.delete(`lineup:${fixture.code}:${side}`);
  addFinding(context, { kind: "blocked", area: "出场名单", title: `卡住：${subject} 名单提交连续 ${RETRY_LIMIT} 次重试仍未成功，跳过`, detail: { fixture: fixture.code, side, history } });
}

/** 注入的 500：记入指标（备注「注入」），让报告的 5xx 逐条记录也能看到它。 */
function injectedServerError(context: RunContext, actor: string) {
  context.metrics.record({ at: Date.now(), actor: `manager-${actor}`, method: "POST", route: "/api/team/[slug]/fixtures/[fixtureId]/lineup", status: 500, code: "internal_error", ms: 0, note: "注入" });
  return { status: 500, ok: false, json: null, code: "internal_error", message: "（注入）服务暂时不可用，请稍后重试。", ms: 0, headers: new Headers() };
}

function buildLineup(tournament: TournamentRuntime, team: TeamRuntime, rubbers: readonly string[], rng: Rng) {
  const planned = tournament.roster.teams.find((item) => item.key === team.key)!;
  const used = new Set<string>();
  return rubbers.map((kind, index) => {
    const take = (gender: "MALE" | "FEMALE") => {
      const pool = rng.shuffle(planned.members.filter((member) => member.person.gender === gender && member.rubberKinds.includes(kind as never) && !used.has(member.person.key)));
      const member = pool[0];
      if (!member) throw new Error(`${team.key} 没有足够的 ${gender} 队员排 ${kind}`);
      used.add(member.person.key);
      return tournament.participantIdByStudentId.get(member.person.studentId)!;
    };
    const gender = RUBBER_GENDER[kind as keyof typeof RUBBER_GENDER];
    const size = kind === "MS" || kind === "WS" ? 1 : 2;
    const ids = gender === "MIXED" ? [take("MALE"), take("FEMALE")] : Array.from({ length: size }, () => take(gender));
    return { order: index + 1, participantIds: ids };
  });
}
