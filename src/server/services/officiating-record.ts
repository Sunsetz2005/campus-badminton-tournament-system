import type { Prisma, RefereeMode } from "@/generated/prisma/client";
import { utcToZonedLocal } from "@/domain/time/zoned-time";

/**
 * 执裁记录（赛务口径 O-2 扩展 / 方案 B2）：排班裁判与实际执裁人并列。
 *
 * - 排班：本场当前有效的主裁判指派；共用账号模式不逐场指派，为空。
 * - 实际执裁：按时间列出每次取得控制（控制会话）与同一设备上的换人交接（`OFFICIATING_HANDOVER` 审计）。
 *   共用账号登记的姓名优先；具名账号用账号姓名；裁判长接管写明「裁判长」。
 *
 * 只给裁判长看板、复核列表与内部名单使用；公开页不显示裁判姓名（姓名公开策略不变）。
 */

/** 只要实际操作的是平台共用裁判账号，或赛事是共用账号模式，取得控制前都须填写本人姓名。 */
export function officiatingNameRequired(refereeMode: RefereeMode, platformReferee: boolean) {
  return refereeMode === "SHARED_ACCOUNT" || platformReferee;
}

export interface OfficiatingRecordEntry {
  name: string;
  at: Date;
  kind: "ACQUIRED" | "HANDOVER" | "TAKEOVER";
}

export interface OfficiatingRecord {
  /** 排班裁判；null 表示未逐场指派。 */
  scheduled: { name: string; shared: boolean } | null;
  actual: OfficiatingRecordEntry[];
}

type Client = Prisma.TransactionClient;

const UNNAMED_SHARED = "共用账号（未登记姓名）";

export async function loadOfficiatingRecords(client: Client, matchIds: readonly string[]): Promise<Map<string, OfficiatingRecord>> {
  const records = new Map<string, OfficiatingRecord>();
  if (!matchIds.length) return records;
  const ids = [...new Set(matchIds)];
  const [assignments, sessions, handovers] = await Promise.all([
    client.officialAssignment.findMany({
      where: { matchId: { in: ids }, role: "MAIN_REFEREE", active: true },
      orderBy: { updatedAt: "desc" },
      select: { matchId: true, user: { select: { name: true, platformReferee: true } } },
    }),
    client.scoringSession.findMany({
      where: { matchId: { in: ids } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { matchId: true, deviceSessionId: true, createdAt: true, actingRole: true, officiatingName: true, user: { select: { name: true, platformReferee: true } } },
    }),
    client.auditLog.findMany({
      where: { action: "OFFICIATING_HANDOVER", targetType: "Match", targetId: { in: ids }, outcome: "SUCCESS" },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      select: { targetId: true, occurredAt: true, metadata: true },
    }),
  ]);
  const ensure = (matchId: string) => {
    let record = records.get(matchId);
    if (!record) {
      record = { scheduled: null, actual: [] };
      records.set(matchId, record);
    }
    return record;
  };
  for (const assignment of assignments) {
    const record = ensure(assignment.matchId);
    record.scheduled ??= { name: assignment.user.platformReferee ? "共用账号" : assignment.user.name, shared: assignment.user.platformReferee };
  }
  const events = new Map<string, OfficiatingRecordEntry[]>();
  const push = (matchId: string, entry: OfficiatingRecordEntry) => {
    const list = events.get(matchId) ?? [];
    list.push(entry);
    events.set(matchId, list);
  };
  const parsedHandovers = handovers.flatMap((handover) => {
    const metadata = handover.metadata as { to?: unknown; from?: unknown; deviceSessionId?: unknown } | null;
    if (typeof metadata?.to !== "string" || !metadata.to) return [];
    return [{
      matchId: handover.targetId,
      at: handover.occurredAt,
      to: metadata.to,
      from: typeof metadata.from === "string" && metadata.from ? metadata.from : null,
      deviceSessionId: typeof metadata.deviceSessionId === "string" ? metadata.deviceSessionId : null,
    }];
  });
  for (const [index, session] of sessions.entries()) {
    // 同一场的下一个控制会话开始后，交接就属于那个会话了。
    const nextStart = sessions.slice(index + 1).find((later) => later.matchId === session.matchId)?.createdAt;
    const takeover = session.actingRole === "CHIEF_REFEREE";
    // 交接时会话上的姓名被原地改成新执裁人；最初登记的姓名取同一设备第一次交接的「from」。
    const firstHandover = parsedHandovers.find(
      (handover) => handover.matchId === session.matchId && handover.deviceSessionId === session.deviceSessionId &&
        handover.at >= session.createdAt &&
        (!nextStart || handover.at < nextStart),
    );
    // 复判第二轮 RV2-03：交接审计的 from 为空（B2 上线前未登记姓名的旧会话），说明会话开始时没人登记，不能退回到已被改写的会话姓名。
    const registered = firstHandover ? firstHandover.from : session.officiatingName;
    const name = registered ?? (session.user.platformReferee ? UNNAMED_SHARED : session.user.name);
    push(session.matchId, { name: takeover ? `${name}（裁判长接管）` : name, at: session.createdAt, kind: takeover ? "TAKEOVER" : "ACQUIRED" });
  }
  for (const handover of parsedHandovers) push(handover.matchId, { name: handover.to, at: handover.at, kind: "HANDOVER" });
  for (const [matchId, list] of events) {
    list.sort((left, right) => left.at.getTime() - right.at.getTime());
    // 同一人连续多次取得控制（续用、刷新页面）只记第一次。
    const actual = list.filter((entry, index) => index === 0 || entry.name !== list[index - 1]!.name);
    ensure(matchId).actual = actual;
  }
  return records;
}

function clock(at: Date, timeZone: string) {
  return utcToZonedLocal(at, timeZone).slice(11, 16);
}

/** 排班一栏的文字。 */
export function scheduledText(record: OfficiatingRecord | undefined, refereeMode: RefereeMode) {
  if (record?.scheduled) return record.scheduled.name;
  return refereeMode === "SHARED_ACCOUNT" ? "未逐场指派（共用账号模式）" : "未指派";
}

/** 实际执裁一栏的文字：「李四 09:05 → 王五 09:40（交接）」。还没人取得控制时返回 null。 */
export function actualText(record: OfficiatingRecord | undefined, timeZone: string) {
  if (!record?.actual.length) return null;
  return record.actual
    .map((entry) => `${entry.name} ${clock(entry.at, timeZone)}${entry.kind === "HANDOVER" ? "（交接）" : ""}`)
    .join(" → ");
}

/** 一行摘要：「排班：张三 · 实际执裁：李四 09:05」。 */
export function officiatingSummary(record: OfficiatingRecord | undefined, refereeMode: RefereeMode, timeZone: string) {
  const actual = actualText(record, timeZone);
  return `排班：${scheduledText(record, refereeMode)} · 实际执裁：${actual ?? "尚无人取得控制"}`;
}
