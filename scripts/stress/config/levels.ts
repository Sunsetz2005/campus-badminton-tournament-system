/**
 * 规模档。全部是默认值，可被命令行 `--config <json>` 覆盖（浅合并到对应字段）。
 * 赛制选择遵循测试方案 §3 与 §9：L1 每种赛制至少出现一次，L3 是全规模。
 */
export type EventKind = "MS" | "WS" | "MD" | "WD" | "XD";
export type RubberKind = EventKind;
export type DrawFormat = "ROUND_ROBIN" | "GROUPS_KNOCKOUT" | "KNOCKOUT";

export interface EventPlan {
  kind: EventKind;
  code: string;
  name: string;
  entries: number;
  format: DrawFormat;
  groupCount?: number;
  qualifiersPerGroup?: 1 | 2;
  thirdPlaceMatch?: boolean;
  seeds?: number;
}

export interface TeamPlan {
  code: string;
  name: string;
  teams: number;
  rubbers: RubberKind[];
  rosterSize: [number, number];
  format: DrawFormat;
  groupCount?: number;
  qualifiersPerGroup?: 1 | 2;
  thirdPlaceMatch?: boolean;
  seeds?: number;
}

export interface TournamentPlan {
  key: string;
  name: string;
  rulePreset: "traditional-21" | "alternative-3x15" | "single-game-21";
  refereeMode: "SHARED_ACCOUNT" | "PER_MATCH";
  courts: number;
  events: EventPlan[];
  team: TeamPlan | null;
}

export interface LevelConfig {
  name: string;
  /** 学院数；个人项目与团体队伍都从这些学院出人。 */
  units: number;
  /** 兼项比例（报两个及以上个人项目的人占比）。 */
  multiEventRatio: number;
  /** 团体队员中同时报个人项目的比例。 */
  teamCrossoverRatio: number;
  tournaments: TournamentPlan[];
  spectators: number;
  spectatorIntervalSeconds: number;
  chiefs: number;
  referees: number;
}

const ev = (kind: EventKind, entries: number, format: DrawFormat, extra: Partial<EventPlan> = {}): EventPlan => ({
  kind,
  code: kind,
  name: { MS: "男子单打", WS: "女子单打", MD: "男子双打", WD: "女子双打", XD: "混合双打" }[kind],
  entries,
  format,
  ...extra,
});

export const LEVELS: Record<string, LevelConfig> = {
  /** 开发冒烟：最小闭环，几分钟跑完。 */
  L0: {
    name: "L0",
    units: 4,
    multiEventRatio: 0.3,
    teamCrossoverRatio: 0.4,
    spectators: 3,
    spectatorIntervalSeconds: 10,
    chiefs: 2,
    referees: 2,
    tournaments: [
      {
        key: "M",
        name: "全赛制仿真主赛事",
        rulePreset: "traditional-21",
        refereeMode: "SHARED_ACCOUNT",
        courts: 2,
        events: [ev("MS", 4, "GROUPS_KNOCKOUT", { groupCount: 2, qualifiersPerGroup: 1, thirdPlaceMatch: false }), ev("XD", 3, "ROUND_ROBIN")],
        team: { code: "TEAM", name: "学院团体", teams: 4, rubbers: ["MS", "WS", "XD"], rosterSize: [4, 6], format: "GROUPS_KNOCKOUT", groupCount: 2, qualifiersPerGroup: 1, thirdPlaceMatch: false },
      },
    ],
  },
  /** 方案 §9 L1：2 块场地，每项 4—6 个单位，团体 4 队三小场。 */
  L1: {
    name: "L1",
    units: 6,
    multiEventRatio: 0.3,
    teamCrossoverRatio: 0.4,
    spectators: 10,
    spectatorIntervalSeconds: 10,
    chiefs: 2,
    referees: 6,
    tournaments: [
      {
        key: "M",
        name: "全赛制仿真主赛事",
        rulePreset: "traditional-21",
        refereeMode: "SHARED_ACCOUNT",
        courts: 2,
        events: [
          ev("MS", 6, "GROUPS_KNOCKOUT", { groupCount: 2, qualifiersPerGroup: 2, thirdPlaceMatch: true, seeds: 2 }),
          ev("WS", 5, "KNOCKOUT", { thirdPlaceMatch: true }),
          ev("MD", 4, "ROUND_ROBIN"),
          ev("WD", 4, "KNOCKOUT", { thirdPlaceMatch: false }),
          ev("XD", 6, "GROUPS_KNOCKOUT", { groupCount: 2, qualifiersPerGroup: 2, thirdPlaceMatch: false }),
        ],
        team: { code: "TEAM", name: "学院团体", teams: 4, rubbers: ["MS", "WS", "XD"], rosterSize: [4, 6], format: "GROUPS_KNOCKOUT", groupCount: 2, qualifiersPerGroup: 1, thirdPlaceMatch: false },
      },
    ],
  },
  /**
   * 方案 §9 L2：主赛事 6 块场地、每项约一半规模、团体 8 队；两个卫星赛事各 2 块场地，覆盖 3×15 与单局 21 两种计分配置，
   * 并与主赛事同一时段、同一服务实例运行（跨赛事隔离、同一共用裁判账号跨赛事执裁）。
   */
  L2: {
    name: "L2",
    units: 10,
    multiEventRatio: 0.3,
    teamCrossoverRatio: 0.4,
    spectators: 30,
    spectatorIntervalSeconds: 10,
    chiefs: 2,
    referees: 20,
    tournaments: [
      {
        key: "M",
        name: "全赛制仿真主赛事",
        rulePreset: "traditional-21",
        refereeMode: "SHARED_ACCOUNT",
        courts: 6,
        events: [
          ev("MS", 12, "GROUPS_KNOCKOUT", { groupCount: 3, qualifiersPerGroup: 2, thirdPlaceMatch: true, seeds: 3 }),
          ev("WS", 8, "KNOCKOUT", { thirdPlaceMatch: true, seeds: 2 }),
          ev("MD", 6, "GROUPS_KNOCKOUT", { groupCount: 2, qualifiersPerGroup: 2, thirdPlaceMatch: false }),
          ev("WD", 5, "ROUND_ROBIN"),
          ev("XD", 8, "GROUPS_KNOCKOUT", { groupCount: 2, qualifiersPerGroup: 2, thirdPlaceMatch: false }),
        ],
        team: { code: "TEAM", name: "学院团体", teams: 8, rubbers: ["MS", "WS", "XD"], rosterSize: [4, 6], format: "GROUPS_KNOCKOUT", groupCount: 2, qualifiersPerGroup: 2, thirdPlaceMatch: true, seeds: 2 },
      },
      {
        key: "S1",
        name: "仿真卫星赛事（3×15）",
        rulePreset: "alternative-3x15",
        refereeMode: "SHARED_ACCOUNT",
        courts: 2,
        events: [ev("MS", 8, "KNOCKOUT", { thirdPlaceMatch: true })],
        team: { code: "TEAM", name: "三小场团体", teams: 4, rubbers: ["MS", "WS", "XD"], rosterSize: [4, 6], format: "ROUND_ROBIN" },
      },
      {
        key: "S2",
        name: "仿真卫星赛事（单局 21）",
        rulePreset: "single-game-21",
        refereeMode: "SHARED_ACCOUNT",
        courts: 2,
        events: [ev("WS", 8, "GROUPS_KNOCKOUT", { groupCount: 2, qualifiersPerGroup: 1, thirdPlaceMatch: false })],
        team: null,
      },
    ],
  },
  /** 方案 §9 L3 / §3：主赛事全规模 + 两个卫星赛事。 */
  L3: {
    name: "L3",
    units: 16,
    multiEventRatio: 0.3,
    teamCrossoverRatio: 0.4,
    spectators: 50,
    spectatorIntervalSeconds: 10,
    chiefs: 2,
    referees: 44,
    tournaments: [
      {
        key: "M",
        name: "全赛制仿真主赛事",
        rulePreset: "traditional-21",
        refereeMode: "SHARED_ACCOUNT",
        courts: 12,
        events: [
          ev("MS", 24, "GROUPS_KNOCKOUT", { groupCount: 6, qualifiersPerGroup: 2, thirdPlaceMatch: true, seeds: 4 }),
          ev("WS", 16, "KNOCKOUT", { thirdPlaceMatch: true, seeds: 4 }),
          ev("MD", 12, "GROUPS_KNOCKOUT", { groupCount: 3, qualifiersPerGroup: 2, thirdPlaceMatch: true }),
          ev("WD", 5, "ROUND_ROBIN"),
          ev("XD", 16, "GROUPS_KNOCKOUT", { groupCount: 4, qualifiersPerGroup: 2, thirdPlaceMatch: false }),
        ],
        team: { code: "TEAM", name: "学院团体", teams: 16, rubbers: ["MS", "WS", "MD", "WD", "XD"], rosterSize: [8, 10], format: "GROUPS_KNOCKOUT", groupCount: 4, qualifiersPerGroup: 2, thirdPlaceMatch: true, seeds: 4 },
      },
      {
        key: "S1",
        name: "仿真卫星赛事（3×15）",
        rulePreset: "alternative-3x15",
        refereeMode: "SHARED_ACCOUNT",
        courts: 2,
        events: [ev("MS", 12, "KNOCKOUT", { thirdPlaceMatch: true })],
        team: { code: "TEAM", name: "三小场团体", teams: 4, rubbers: ["MS", "WS", "XD"], rosterSize: [4, 6], format: "ROUND_ROBIN" },
      },
      {
        key: "S2",
        name: "仿真卫星赛事（单局 21）",
        rulePreset: "single-game-21",
        refereeMode: "SHARED_ACCOUNT",
        courts: 2,
        events: [ev("WS", 8, "GROUPS_KNOCKOUT", { groupCount: 2, qualifiersPerGroup: 1, thirdPlaceMatch: false })],
        team: null,
      },
    ],
  },
};
