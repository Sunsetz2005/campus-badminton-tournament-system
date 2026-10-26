/**
 * 报名（§4 第 2—3 步）。
 * - 个人项目：后台逐条录入（`POST registrations`）→ 批量通过（`batch-approve`，每批 ≤100）；
 * - 团体：建队 → 开通负责人（初始口令只返回一次）→ 负责人登录、改口令、提交名单 → 管理员逐份审核通过。
 * CSV 导入与邀请链接在 M3 加入；本文件只走最常用的入口。
 */
import { Client } from "../core/http";
import { entriesOf, participantsOf, pendingRegistrations } from "../core/db";
import { strongPassword } from "./setup";
import type { RunContext, TournamentRuntime } from "./context";

export async function registerIndividuals(context: RunContext, tournament: TournamentRuntime) {
  const slug = tournament.slug;
  for (const [code, list] of tournament.roster.entries) {
    const competition = tournament.competitions.get(code)!;
    for (const entry of list) {
      await context.admin.must("POST", `/api/admin/tournaments/${slug}/registrations`, {
        competitionId: competition.id,
        members: entry.members.map((person) => ({ displayName: person.displayName, studentId: person.studentId, teamName: person.unit })),
        note: `仿真 ${entry.key}`,
      }, { route: "/api/admin/tournaments/[slug]/registrations" });
    }
  }
  const pending = await pendingRegistrations(tournament.id);
  const individual = pending.filter((item) => !item.teamId);
  for (let index = 0; index < individual.length; index += 100) {
    const batch = individual.slice(index, index + 100);
    const result = await context.admin.must<{ results: { id: string; ok: boolean; code?: string; message?: string }[] }>(
      "POST",
      `/api/admin/tournaments/${slug}/registrations/batch-approve`,
      { items: batch.map((item) => ({ id: item.id, expectedVersion: item.version })) },
      { route: "/api/admin/tournaments/[slug]/registrations/batch-approve" },
    );
    const failed = result.results.filter((item) => !item.ok);
    if (failed.length) context.log(`批量通过有 ${failed.length} 份未通过：${failed.slice(0, 3).map((item) => `${item.code} ${item.message}`).join("；")}`);
  }
  context.log(`个人项目报名 ${individual.length} 份已提交并批量审核`);
}

export async function registerTeams(context: RunContext, tournament: TournamentRuntime) {
  const plan = tournament.plan.team;
  if (!plan) return;
  const slug = tournament.slug;
  const competition = tournament.competitions.get(plan.code)!;
  for (const team of tournament.roster.teams) {
    const created = await context.admin.must<{ id: string; name: string }>("POST", `/api/admin/tournaments/${slug}/teams`, { name: team.name }, { route: "/api/admin/tournaments/[slug]/teams" });
    const email = `${team.key.toLowerCase()}.${context.runId}@stress-sim.invalid`;
    const provisioned = await context.admin.must<{ userId: string; initialPassword: string | null }>(
      "POST",
      `/api/admin/tournaments/${slug}/teams/${created.id}/managers`,
      { email, name: `${team.name}领队` },
      { route: "/api/admin/tournaments/[slug]/teams/[teamId]/managers" },
    );
    if (!provisioned.initialPassword) throw new Error(`${email} 已有账号，未拿到初始口令。`);
    const manager = new Client(context.origin, `manager-${team.key}`, context.metrics, context.nextIp());
    await manager.signIn(email, provisioned.initialPassword);
    const password = strongPassword();
    await manager.changePassword(provisioned.initialPassword, password);
    context.secrets[email] = password;
    await manager.must("POST", `/api/team/${slug}/teams/${created.id}/roster`, {
      competitionId: competition.id,
      members: team.members.map((member) => ({
        displayName: member.person.displayName,
        studentId: member.person.studentId,
        gender: member.person.gender,
        rubberKinds: member.rubberKinds,
      })),
      note: `仿真 ${team.key}`,
    }, { route: "/api/team/[slug]/teams/[teamId]/roster" });
    tournament.teams.push({ key: team.key, id: created.id, name: team.name, entryId: null, manager, managerLogin: email });
  }
  const pending = (await pendingRegistrations(tournament.id, competition.id)).filter((item) => item.teamId);
  for (const item of pending) {
    await context.admin.must("POST", `/api/admin/tournaments/${slug}/registrations/${item.id}/review`, { action: "APPROVE", expectedVersion: item.version }, {
      route: "/api/admin/tournaments/[slug]/registrations/[registrationId]/review",
    });
  }
  context.log(`团体 ${tournament.teams.length} 队已建队、负责人提交名单并审核`);
}

/** 把计划中的报名单位对应到系统 Entry；按成员学号匹配，与「页面上看到哪一行」等价。 */
export async function mapEntries(tournament: TournamentRuntime) {
  for (const participant of await participantsOf(tournament.id)) {
    if (participant.studentId) tournament.participantIdByStudentId.set(participant.studentId, participant.id);
  }
  for (const [code, competition] of tournament.competitions) {
    const rows = await entriesOf(competition.id);
    const byStudents = new Map(rows.map((row) => [row.members.map((member) => member.participant.studentId).sort().join("|"), row.id]));
    if (code === tournament.plan.team?.code) {
      for (const team of tournament.teams) {
        const row = rows.find((item) => item.teamId === team.id);
        team.entryId = row?.id ?? null;
        if (row) competition.entryIdByKey.set(team.key, row.id);
      }
      continue;
    }
    for (const entry of tournament.roster.entries.get(code) ?? []) {
      const id = byStudents.get(entry.members.map((person) => person.studentId).sort().join("|"));
      if (id) competition.entryIdByKey.set(entry.key, id);
    }
  }
}

export async function closeRegistration(context: RunContext, tournament: TournamentRuntime) {
  await context.admin.must("POST", `/api/admin/tournaments/${tournament.slug}/phase`, { to: "REGISTRATION_CLOSED" }, { route: "/api/admin/tournaments/[slug]/phase" });
}
