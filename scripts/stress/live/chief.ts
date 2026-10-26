/**
 * 裁判长（§4 第 8—9 步）。
 * - 复核队列：依据「我的执裁」里的待复核列表；每名裁判长按场次编号分工，接管控制 → `CONFIRM_RESULT` → 释放。
 *   复核锁定才触发晋级回填与对抗结算，所以复核排队本身就是延误来源（§5.1）。
 * - 小组名次：组内比赛全部锁定（或未进行）后确认；有并列待裁定时，由仿真「现场抽签」决定并列者顺序、写明依据——
 *   系统不替人抽签（§6.5），这一步与真实裁判长的做法一致。
 */
import { randomUUID } from "node:crypto";

import { loadIndividualGroupRanking } from "../../../src/server/services/results-service";
import { loadGroupStandings } from "../../../src/server/services/team-tie-service";
import { groupsOf, prisma } from "../core/db";
import { sleep } from "../core/clock";
import type { Rng } from "../core/rng";
import type { RunContext, TournamentRuntime } from "../scenario/context";
import { addFinding } from "../scenario/context";
import { OfficiatingCache } from "./officiating";
import type { MatchStateView } from "./referee";
import type { LiveRegistry } from "./venue";

export interface ReviewRecord {
  matchCode: string;
  chief: string;
  submittedSeenAt: number;
  confirmedAt: number | null;
  commandId: string | null;
  status: number;
  code: string | null;
}

export async function chiefReviewLoop(options: {
  context: RunContext;
  tournament: TournamentRuntime;
  index: number;
  registry: LiveRegistry;
  reviews: ReviewRecord[];
  rng: Rng;
}) {
  const { context, tournament, index, registry, reviews, rng } = options;
  const chief = tournament.chiefs[index];
  const cache = new OfficiatingCache(chief.userId, tournament.slug, 1000);
  const firstSeen = new Map<string, number>();
  const failed = new Set<string>();
  while (!registry.stop) {
    let view;
    try {
      view = await cache.get(true);
    } catch (error) {
      context.log(`裁判长 ${chief.login} 读取待复核失败：${error instanceof Error ? error.message : String(error)}`);
      await sleep(2000);
      continue;
    }
    const mine = view.reviewMatches
      .filter((match) => match.verificationStatus === "PENDING_REVIEW" && !failed.has(match.code))
      .filter((match) => hash(match.code) % tournament.chiefs.length === index);
    for (const match of mine) {
      if (firstSeen.has(match.code)) continue;
      firstSeen.set(match.code, Date.now());
      const hold = tournament.reviewHolds.get(match.code);
      if (hold) registry.intentionalWaits.set(match.code, Date.now() + context.clock.ms(hold));
      const until = tournament.reviewHoldUntil.get(match.code);
      if (until && until > Date.now()) registry.intentionalWaits.set(match.code, until);
    }
    // 延误情形 3：指定比赛的复核延后（裁判长被其他事务耽搁），到点前先处理别的。
    const due = mine.filter((match) => {
      const hold = tournament.reviewHolds.get(match.code);
      const until = tournament.reviewHoldUntil.get(match.code) ?? 0;
      return (!hold || Date.now() - firstSeen.get(match.code)! >= context.clock.ms(hold)) && Date.now() >= until;
    });
    if (!due.length) {
      await sleep(1000);
      continue;
    }
    const target = due.sort((a, b) => firstSeen.get(a.code)! - firstSeen.get(b.code)!)[0];
    const record = await confirmResult(context, chief.client, target.code, rng);
    reviews.push({ matchCode: target.code, chief: chief.login, submittedSeenAt: firstSeen.get(target.code)!, ...record });
    if (record.confirmedAt) registry.lastProgressAt = Date.now();
    else if (record.status === 0 || record.status >= 500) {
      // 服务端暂时故障（数据库故障注入等）：记下，稍后重试，不当作这场永远复核不了。
      addFinding(context, { kind: "unexpected", area: "复核", title: `${target.code} 复核得到 ${record.status} ${record.code ?? ""}，稍后重试`, detail: { tournament: tournament.plan.key, ...record } });
      await sleep(3000);
    } else {
      failed.add(target.code);
      addFinding(context, { kind: "blocked", area: "复核", title: `${target.code} 复核锁定失败`, detail: { tournament: tournament.plan.key, ...record } });
    }
  }
}

export async function confirmResult(context: RunContext, client: RunContext["admin"], matchCode: string, rng: Rng) {
  const deviceSessionId = rng.uuid();
  const takeover = await client.call<{ sessionId: string; controlToken: string; takeoverGeneration: number }>(
    "POST",
    `/api/matches/${matchCode}/control/takeover`,
    { deviceSessionId, reason: "仿真：裁判长复核" },
    { route: "/api/matches/[code]/control/takeover" },
  );
  if (!takeover.ok) return { confirmedAt: null, commandId: null, status: takeover.status, code: takeover.code };
  const control = takeover.json!;
  const auth = { Authorization: `Bearer ${control.controlToken}` };
  const stateResult = await client.call<{ state: MatchStateView }>("GET", `/api/matches/${matchCode}/state`, undefined, { route: "/api/matches/[code]/state" });
  const version = stateResult.json?.state?.version;
  const commandId = randomUUID();
  const confirm = await client.call("POST", `/api/matches/${matchCode}/commands`, {
    commandId,
    occurredAt: new Date().toISOString(),
    expectedVersion: version,
    scoringSessionId: control.sessionId,
    takeoverGeneration: control.takeoverGeneration,
    type: "CONFIRM_RESULT",
    payload: { reason: "仿真：裁判长复核无误" },
  }, { route: "/api/matches/[code]/commands", headers: auth, note: "CONFIRM_RESULT" });
  await client.call("DELETE", `/api/matches/${matchCode}/control`, { scoringSessionId: control.sessionId, takeoverGeneration: control.takeoverGeneration }, {
    route: "/api/matches/[code]/control",
    headers: auth,
  });
  return { confirmedAt: confirm.ok ? Date.now() : null, commandId: confirm.ok ? commandId : null, status: confirm.status, code: confirm.code };
}

export interface RankingRecord {
  competition: string;
  group: string;
  at: number;
  status: number;
  code: string | null;
  lots: boolean;
  /** 系统给出的并列待裁定块（抽签前）。 */
  unresolved?: string[][];
}

/** 小组名次确认。个人项目与团体项目共用同一接口（服务端按项目类型分派）。 */
export async function groupRankingLoop(options: {
  context: RunContext;
  tournament: TournamentRuntime;
  registry: LiveRegistry;
  rng: Rng;
  confirmations: RankingRecord[];
}) {
  const { context, tournament, registry, rng, confirmations } = options;
  const chief = tournament.chiefs[0];
  const done = new Set<string>();
  while (!registry.stop) {
    for (const competition of tournament.competitions.values()) {
      const groups = await groupsOf(competition.id);
      for (const group of groups) {
        const key = `${competition.code}/${group.code}`;
        if (group.rankingConfirmedAt || done.has(key) || tournament.rankingHolds.has(key)) continue;
        const isTeam = competition.entryType === "TEAM";
        const ready = isTeam
          ? group.fixtures.length > 0 && group.fixtures.every((fixture) => fixture.matches.every((match) => match.notPlayedAt || match.verificationStatus === "LOCKED"))
          : group.matches.length > 0 && group.matches.every((match) => match.notPlayedAt || match.verificationStatus === "LOCKED");
        if (!ready) continue;
        let body: { order?: string[]; reason?: string } = {};
        let lots = false;
        let lotsBlocks: string[][] = [];
        {
          // 个人与团体的并列块形状相同（rows[].entryId + unresolved[][]）；团体用对抗积分榜。
          const ranking = isTeam ? (await loadGroupStandings(prisma, group.id)).standings : (await loadIndividualGroupRanking(prisma, group.id)).ranking;
          if (ranking.unresolved.length) {
            lots = true;
            const order = ranking.rows.map((row: { entryId: string }) => row.entryId);
            for (const block of ranking.unresolved) {
              const positions = order.map((id: string, position: number) => (block.includes(id) ? position : -1)).filter((position: number) => position >= 0);
              const shuffled = rng.shuffle(block);
              positions.forEach((position: number, slot: number) => (order[position] = shuffled[slot]));
            }
            lotsBlocks = ranking.unresolved;
            body = { order, reason: `仿真现场抽签：并列 ${ranking.unresolved.map((block: string[]) => block.length).join("、")} 方，由裁判长主持抽签、两名裁判员见证` };
          }
        }
        const result = await chief.client.call("POST", `/api/admin/tournaments/${tournament.slug}/competitions/${competition.code}/groups/${group.code}/ranking`, body, {
          route: "/api/admin/tournaments/[slug]/competitions/[code]/groups/[group]/ranking",
        });
        confirmations.push({ competition: competition.code, group: group.code, at: Date.now(), status: result.status, code: result.code, lots, unresolved: lotsBlocks });
        if (result.ok) {
          done.add(key);
          registry.lastProgressAt = Date.now();
          context.log(`小组名次确认 ${tournament.plan.key}/${key}${lots ? "（含抽签）" : ""}`);
        } else if (result.status === 0 || result.status >= 500) {
          addFinding(context, { kind: "unexpected", area: "小组名次", title: `${tournament.plan.key}/${key} 名次确认得到 ${result.status} ${result.code ?? ""}，稍后重试`, detail: { status: result.status, code: result.code, message: result.message } });
        } else if (result.code !== "ranking_not_confirmable") {
          done.add(key);
          addFinding(context, { kind: "blocked", area: "小组名次", title: `${tournament.plan.key}/${key} 名次确认被拒绝`, detail: { status: result.status, code: result.code, message: result.message } });
        }
      }
    }
    await sleep(2000);
  }
}

function hash(text: string) {
  let value = 0;
  for (let index = 0; index < text.length; index += 1) value = (value * 31 + text.charCodeAt(index)) >>> 0;
  return value;
}
