/**
 * 公开字段白名单。这里是公开端唯一允许读取的数据库形状。
 *
 * 默认禁止出现在任何一个 select 里：数据库/内部 ID、学号与联系方式、登录账号/角色/会话/token/
 * 设备/租约、医疗或纪律细节、原始命令与审计、`ResultRevision.reason`、更正理由，
 * 以及尚未进入逐场发布边界（`Match.publishedAt`）的比赛。
 */

/**
 * 逐场公开发布边界：赛事级 `PUBLISHED` 不等于「该场可公开」。
 * 团体对抗胜负已定后「不再进行」的小场不进入公开赛程（它既不是待开赛，也没有比分）。
 */
export const publishedMatchWhere = { publishedAt: { not: null }, notPlayedAt: null } as const;

/** 首页赛事卡。只有赛事级信息，不含任何比赛明细。 */
export const publicTournamentCardSelect = {
  slug: true,
  name: true,
  subtitle: true,
  organizer: true,
  venue: true,
  summary: true,
  startDate: true,
  endDate: true,
  posterPath: true,
  posterAlt: true,
  timezone: true,
  phase: true,
  updatedAt: true,
} as const;

const publicEntrySelect = {
  code: true,
  displayName: true,
  entryType: true,
  members: {
    select: {
      slot: true,
      participant: { select: { publicCode: true, displayName: true, teamName: true } },
    },
    orderBy: { slot: "asc" as const },
  },
} as const;

/**
 * 单场比赛的公开投影。
 *
 * `snapshot.state` 只在服务端读取，用于取得权威的总局分、胜方和特殊结果中断局；
 * 适配器绝不把它整体下发给浏览器。`resultRevisions` 只取 `revision` 和 `status`
 * 用于推导公开更正标记，`reason` 永远不进入白名单。
 */
export const publicMatchSelect = {
  code: true,
  lifecycleStatus: true,
  outcomeType: true,
  verificationStatus: true,
  scheduledAt: true,
  // 计划时间是否为「接上一场之后」的预计值（阶段 4-C）。
  scheduleEstimated: true,
  // 团体小场：小场序号与类型；上场队员只在双方出场名单交齐公开后才进入投影（盲交期间不公开）。
  rubberKind: true,
  rubberOrder: true,
  fixture: { select: { lineupsRevealedAt: true } },
  players: {
    select: {
      side: true,
      slot: true,
      participant: { select: { publicCode: true, displayName: true, teamName: true } },
    },
  },
  startedAt: true,
  endedAt: true,
  version: true,
  updatedAt: true,
  court: { select: { code: true, name: true } },
  group: { select: { code: true, name: true } },
  sideAEntry: { select: publicEntrySelect },
  sideBEntry: { select: publicEntrySelect },
  games: {
    select: { number: true, scoreA: true, scoreB: true, completed: true },
    orderBy: { number: "asc" as const },
  },
  ruleSnapshot: { select: { config: true } },
  snapshot: { select: { state: true } },
  // 仅结果记录（阶段 6）：胜方与局分取自最新有效修订；修订内容只在服务端读取，不整体下发。
  resultSource: true,
  resultRevisions: {
    select: { revision: true, status: true, source: true, result: true },
    orderBy: { revision: "asc" as const },
  },
} as const;

/** 赛事公开赛程：赛事页头 + 该赛事全部已发布比赛。 */
export const publicScheduleSelect = {
  slug: true,
  name: true,
  subtitle: true,
  venue: true,
  summary: true,
  timezone: true,
  phase: true,
  updatedAt: true,
  // 只在服务端读取，用于决定姓名与代表队是否公开；本身不下发给浏览器。
  namePolicy: true,
  competitions: {
    select: {
      code: true,
      name: true,
      kind: true,
      stages: {
        select: {
          code: true,
          name: true,
          order: true,
          // 不在这里排序：权威赛程顺序（计划时间 → 场地 → 编号，无时间者归入待排期）
          // 由 getPublicSchedule 统一决定，避免两处顺序定义漂移。
          matches: {
            where: publishedMatchWhere,
            select: publicMatchSelect,
          },
        },
        orderBy: { order: "asc" as const },
      },
    },
    orderBy: { code: "asc" as const },
  },
} as const;

/**
 * 阶段 1 的公开白名单，仍由 `GET /api/public/tournaments/[slug]` 使用。
 * 新的门户页面改用上面三个更完整的 select。
 */
export const publicTournamentSelect = {
  slug: true,
  name: true,
  timezone: true,
  status: true,
  competitions: {
    select: {
      code: true,
      name: true,
      kind: true,
      stages: {
        select: {
          code: true,
          name: true,
          matches: {
            select: {
              code: true,
              lifecycleStatus: true,
              outcomeType: true,
              verificationStatus: true,
              scheduledAt: true,
              court: { select: { code: true, name: true } },
              sideAEntry: { select: { code: true, displayName: true } },
              sideBEntry: { select: { code: true, displayName: true } },
              games: {
                select: { number: true, scoreA: true, scoreB: true, completed: true },
                orderBy: { number: "asc" as const },
              },
            },
            orderBy: { code: "asc" as const },
          },
        },
        orderBy: { order: "asc" as const },
      },
    },
    orderBy: { code: "asc" as const },
  },
} as const;
