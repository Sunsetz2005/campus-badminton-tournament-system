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
