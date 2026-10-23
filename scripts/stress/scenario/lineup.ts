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
}

export async function lineupLoop(options: { context: RunContext; tournament: TournamentRuntime; registry: LiveRegistry; rng: Rng; records: LineupRecord[] }) {
  const { context, tournament, registry, rng, records } = options;
  const team = tournament.plan.team;
  if (!team) return;
  const competition = tournament.competitions.get(team.code)!;
  const submitted = new Set<string>();
  const teamByEntry = new Map(tournament.teams.map((item) => [item.entryId, item]));
  while (!registry.stop) {
    for (const fixture of await fixturesOf(competition.id)) {
      if (fixture.lineupsRevealedAt || fixture.decidedAt) continue;
      for (const side of ["A", "B"] as const) {
        const entryId = side === "A" ? fixture.sideAEntryId : fixture.sideBEntryId;
        if (!entryId) continue;
        const key = `${fixture.id}:${side}`;
        if (submitted.has(key) || fixture.lineups.some((lineup) => lineup.side === side)) continue;
        const owner = teamByEntry.get(entryId);
        if (!owner) continue;
        const rubbers = buildLineup(tournament, owner, team.rubbers, rng.fork(`lineup:${fixture.code}:${side}`));
        const byManager = await owner.manager.call("POST", `/api/team/${tournament.slug}/fixtures/${fixture.id}/lineup`, { rubbers }, {
          route: "/api/team/[slug]/fixtures/[fixtureId]/lineup",
        });
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
        submitted.add(key);
        addFinding(context, { kind: "blocked", area: "出场名单", title: `${fixture.code} ${owner.name} 提交名单被拒绝`, detail: { status: byManager.status, code: byManager.code, message: byManager.message } });
      }
    }
    await sleep(2000);
  }
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
