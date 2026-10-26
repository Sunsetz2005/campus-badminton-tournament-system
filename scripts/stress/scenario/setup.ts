/**
 * 建赛（§4 第 1 步）：管理员经 `POST /api/admin/tournaments` 建赛 → 发布门户 → 开通两名裁判长（`9665321` 的接口）→ 开放报名。
 * 裁判长首次登录按要求修改初始口令。
 */
import { randomBytes } from "node:crypto";

import type { TournamentPlan } from "../config/levels";
import { Client } from "../core/http";
import { localDate, localDateTime, TIMEZONE } from "../core/time";
import { competitionsOf } from "../core/db";
import { lineupNeeds } from "./roster";
import type { CompetitionRuntime, RunContext, TournamentRuntime } from "./context";
import type { TournamentRoster } from "./roster";

export function strongPassword() {
  // 至少 12 位（口令修改接口的下限），不含容易被 shell 误解的字符。
  return `St-${randomBytes(12).toString("base64url")}`;
}

export async function createTournament(context: RunContext, plan: TournamentPlan, roster: TournamentRoster): Promise<TournamentRuntime> {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 36 * 3600_000);
  const slug = `stress-${context.runId}-${plan.key.toLowerCase()}`;
  const competitions = plan.events.map((event) => ({ kind: event.kind, code: event.code, name: event.name }));
  if (plan.team) {
    const needs = lineupNeeds(plan.team.rubbers);
    competitions.push({
      kind: "TEAM",
      code: plan.team.code,
      name: plan.team.name,
      teamFormat: {
        rubbers: plan.team.rubbers,
        rosterMin: Math.max(plan.team.rosterSize[0], needs.MALE + needs.FEMALE),
        rosterMax: plan.team.rosterSize[1],
        minMale: needs.MALE,
        minFemale: needs.FEMALE,
        maxRubbersMale: null,
        maxRubbersFemale: null,
      },
    } as never);
  }
  const created = await context.admin.must<{ id: string; slug: string }>("POST", "/api/admin/tournaments", {
    slug,
    name: `${plan.name} ${context.runId}`,
    organizer: "并发仿真",
    venue: "仿真体育馆",
    startDate: localDate(now),
    endDate: localDate(tomorrow),
    timezone: TIMEZONE,
    namePolicy: "DISPLAY_NAMES",
    refereeMode: plan.refereeMode,
    rulePreset: plan.rulePreset,
    registrationOpensAt: localDateTime(new Date(now.getTime() - 3600_000)),
    registrationClosesAt: localDateTime(new Date(now.getTime() + 6 * 3600_000)),
    competitions,
  }, { route: "/api/admin/tournaments" });
  context.log(`建赛 ${slug}（${plan.rulePreset}，${plan.refereeMode}）`);

  await context.admin.must("POST", `/api/admin/tournaments/${slug}/publish`, {}, { route: "/api/admin/tournaments/[slug]/publish" });
  await context.admin.must("POST", `/api/admin/tournaments/${slug}/phase`, { to: "REGISTRATION_OPEN" }, { route: "/api/admin/tournaments/[slug]/phase" });

  const competitionMap = new Map<string, CompetitionRuntime>();
  for (const row of await competitionsOf(created.id)) {
    competitionMap.set(row.code, { id: row.id, code: row.code, kind: row.kind, entryType: row.entryType, entryIdByKey: new Map() });
  }

  const runtime: TournamentRuntime = {
    plan,
    slug,
    id: created.id,
    roster,
    competitions: competitionMap,
    participantIdByStudentId: new Map(),
    teams: [],
    chiefs: [],
    courts: [],
    forced: new Map(),
    reviewHolds: new Map(),
    reviewHoldUntil: new Map(),
    lineupReserved: new Set(),
    tieScenarios: [],
    delayScenarios: [],
    officials: [],
    deviceMode: plan.refereeMode === "PER_MATCH" ? "personal" : "court",
    withdrawn: new Map(),
    specials: new Map(),
    specialHooks: [],
    hookedEntries: new Set(),
    heldMatches: new Set(),
    rankingHolds: new Set(),
    expectedStuck: new Map(),
  };

  for (let index = 0; index < context.level.chiefs; index += 1) {
    const username = `chief_${context.runId}_${plan.key}_${index + 1}`.toLowerCase();
    const account = await context.admin.must<{ userId: string; initialPassword: string }>(
      "POST",
      `/api/admin/tournaments/${slug}/chief-referees/accounts`,
      { username, name: `仿真裁判长${index + 1}` },
      { route: "/api/admin/tournaments/[slug]/chief-referees/accounts" },
    );
    const client = new Client(context.origin, `chief-${plan.key}-${index + 1}`, context.metrics, context.nextIp());
    await client.signIn(username, account.initialPassword);
    const password = strongPassword();
    await client.changePassword(account.initialPassword, password);
    // 修改口令会注销该账号的「其他」会话，本会话保留。
    context.secrets[username] = password;
    runtime.chiefs.push({ client, userId: account.userId, login: username });
  }
  return runtime;
}
