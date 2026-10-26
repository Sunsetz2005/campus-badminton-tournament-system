/**
 * 一次运行的共享状态：配置、随机流、时钟、指标、各赛事的系统编号与登录客户端，以及「发现」列表。
 * 发现（finding）只记录事实：在哪一步、请求了什么、系统怎么回应；分类（bug / 设计未定义 / 预计卡住 / 不可测）在报告阶段做。
 */
import type { LevelConfig, TournamentPlan } from "../config/levels";
import type { Clock } from "../core/clock";
import type { Client } from "../core/http";
import type { Metrics } from "../core/metrics";
import type { Rng } from "../core/rng";
import type { ForcedNarrative } from "../live/narrative";
import type { DelayScenario } from "./delays";
import type { Official } from "../live/officials";
import type { TournamentRoster } from "./roster";
import type { TieScenario } from "./ties";

export type FindingKind = "blocked" | "unexpected" | "observation" | "design_undefined" | "script_error";

export interface Finding {
  at: string;
  kind: FindingKind;
  area: string;
  title: string;
  detail: Record<string, unknown>;
}

export interface CompetitionRuntime {
  id: string;
  code: string;
  kind: string;
  entryType: string;
  /** 计划报名单位键 → 系统 Entry.id */
  entryIdByKey: Map<string, string>;
}

export interface TeamRuntime {
  key: string;
  id: string;
  name: string;
  entryId: string | null;
  manager: Client;
  managerLogin: string;
}

export interface TournamentRuntime {
  plan: TournamentPlan;
  slug: string;
  id: string;
  roster: TournamentRoster;
  competitions: Map<string, CompetitionRuntime>;
  /** 学号 → Participant.id */
  participantIdByStudentId: Map<string, string>;
  teams: TeamRuntime[];
  chiefs: { client: Client; userId: string; login: string }[];
  courts: string[];
  /** 注入点指定的比赛走向（强制同分、强制长局），按比赛编号。 */
  forced: Map<string, ForcedNarrative>;
  /** 裁判长对指定比赛的复核延后（现实秒，经压缩时钟），用于延误情形 3。 */
  reviewHolds: Map<string, number>;
  /** 复核延后到指定时刻（墙钟毫秒）。用于需要「等到某个截止过去」的情形（D7）。 */
  reviewHoldUntil: Map<string, number>;
  /** 由异常注入亲自提交名单的团体对抗（fixture.id），名单协程跳过。 */
  lineupReserved: Set<string>;
  tieScenarios: TieScenario[];
  delayScenarios: DelayScenario[];
  /** 具名裁判（逐场指派模式）或仿真裁判（共用账号模式）。 */
  officials: Official[];
  refereeDraft?: import("./schedule").RefereeDraftRecord;
  /**
   * 设备模式（§13.9）：`court` 每块场地一台平板（逐场指派模式下交接要退出上一个人、下一名裁判登录）；
   * `personal` 每名裁判一台手机随人移动（共用账号模式下同一账号同时有多名裁判的登录会话）。
   */
  deviceMode: "court" | "personal";
  /** 赛务异常（M5，§6）：退出比赛的报名单位。场地开出它的比赛时按计划录入弃权；团体队不再交名单。 */
  withdrawn: Map<string, { reason: string; at: number }>;
  /** 指定比赛按计划录入的特殊结果（弃权、退赛、取消资格、中止）。 */
  specials: Map<string, SpecialPlan>;
  /** 开赛时按双方决定特殊结果的规则（例如「某人每轮的对手都弃权」），依次询问，第一个非空的生效。 */
  specialHooks: ((match: SpecialHookMatch) => SpecialPlan | null)[];
  /** 有按双方决定特殊结果规则的报名单位（specialHooks 用到的）：注入借用比赛时避开，免得绕过规则。 */
  hookedEntries: Set<string>;
  /** 暂不开赛的比赛（例如延后抽签项目在撤销重抽之前）。场地调度跳过。 */
  heldMatches: Set<string>;
  /** 小组名次暂缓确认（「项目/小组」），由赛务异常处理完排除后再放开。 */
  rankingHolds: Set<string>;
  /** 预计卡住（§6 已知缺口）：项目编号 → 原因。运行结束判定时，这些项目里缺一方的比赛不算未完成，单独列出。 */
  expectedStuck: Map<string, string>;
}

export interface SpecialHookMatch {
  code: string;
  competitionCode: string;
  groupId: string | null;
  round: number | null;
  fixtureKind: string | null;
  sideAEntryId: string | null;
  sideBEntryId: string | null;
}

/**
 * 按计划录入的特殊结果。`loser` 是弃权 / 退赛 / 被取消资格的一方（中止没有）；
 * `at` 为空表示开赛即录（弃权），否则打到第 `game` 局、本局两方合计 `points` 分时录入（退赛、取消资格）。
 */
export interface SpecialPlan {
  type: "WO" | "RET" | "DSQ" | "ABANDONED";
  loser: "A" | "B" | null;
  at: { game: number; points: number } | null;
  reason: string;
}

/**
 * 故障注入（只在仿真侧，不改被测系统）：用于验证仿真脚本自身对异常的处理。
 * - lineup500：第一次负责人名单提交得到 500。`unsent` 不发请求、直接当作 500；`saved` 真实提交成功后把回应换成 500（模拟「已写入但回应丢失」）。
 * - withholdLineup：第一个双方已定的团体对抗里，A 方负责人始终不交名单（构造永远开不了的比赛，验证卡住检测）。
 * - reviewHoldSeconds：第一场个人比赛的复核延后（现实秒数，经压缩时钟），验证有意等待不被判卡住。
 */
export interface Injections {
  lineup500: "unsent" | "saved" | null;
  lineup500Used: boolean;
  withholdLineup: boolean;
  withheldKey: string | null;
  reviewHoldSeconds: number;
}

/**
 * 异常注入与赛务异常的一项期望 / 实际对照（M4、M5）。「未触发」表示构造条件没有出现，不等于通过；
 * 「预计卡住·已证实 / 未证实」用于方案里事先判断会卡住的情形（§6），「不可测」是系统没有对应功能。
 */
export type ProbeVerdict = "符合" | "不符" | "设计未定义" | "预计卡住·已证实" | "预计卡住·未证实" | "不可测" | "未触发" | "脚本错误";

export interface ProbeRecord {
  at: string;
  id: string;
  group: string;
  title: string;
  expected: string;
  actual: string;
  verdict: ProbeVerdict;
  match?: string;
  detail?: Record<string, unknown>;
}

export interface RunContext {
  runId: string;
  /** 异常注入的期望 / 实际对照。 */
  probes: ProbeRecord[];
  inject: Injections;
  runDir: string;
  origin: string;
  level: LevelConfig;
  rng: Rng;
  clock: Clock;
  metrics: Metrics;
  admin: Client;
  refereeLogin: { login: string; password: string };
  tournaments: TournamentRuntime[];
  findings: Finding[];
  /** 为每个模拟客户端分配不同来源地址（没有反向代理时有效）；false 时全部共用一个来源。 */
  distinctClientIps: boolean;
  /** 本机未提交目录里保存运行时生成的口令（不进报告）。 */
  secretsFile: string;
  secrets: Record<string, string>;
  log: (message: string) => void;
  nextIp: () => string | null;
}

export function addFinding(context: RunContext, finding: Omit<Finding, "at">) {
  const entry = { at: new Date().toISOString(), ...finding };
  context.findings.push(entry);
  context.log(`[发现:${finding.kind}] ${finding.area} · ${finding.title}`);
  return entry;
}

export function recordProbe(context: RunContext, probe: Omit<ProbeRecord, "at">) {
  const entry = { at: new Date().toISOString(), ...probe };
  context.probes.push(entry);
  context.log(`[注入结果:${probe.verdict}] ${probe.id} ${probe.title}${probe.match ? `（${probe.match}）` : ""}：${probe.actual}`);
  return entry;
}
