/**
 * 一次运行的共享状态：配置、随机流、时钟、指标、各赛事的系统编号与登录客户端，以及「发现」列表。
 * 发现（finding）只记录事实：在哪一步、请求了什么、系统怎么回应；分类（bug / 设计未定义 / 预计卡住 / 不可测）在报告阶段做。
 */
import type { LevelConfig, TournamentPlan } from "../config/levels";
import type { Clock } from "../core/clock";
import type { Client } from "../core/http";
import type { Metrics } from "../core/metrics";
import type { Rng } from "../core/rng";
import type { TournamentRoster } from "./roster";

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
}

export interface RunContext {
  runId: string;
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
