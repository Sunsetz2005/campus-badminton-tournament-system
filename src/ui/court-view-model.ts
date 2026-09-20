import type {
  LogicalCourt,
  MatchPhase,
  MatchState,
  PhysicalEnd,
  Side,
} from "@/domain/rules/match-engine";

export type CourtScreenHalf = "LEFT" | "RIGHT";
export type CourtScreenRow = "TOP" | "BOTTOM";
export type CourtPlayerRole = "SERVER" | "RECEIVER" | null;

export interface CourtCellViewModel {
  screenHalf: CourtScreenHalf;
  screenRow: CourtScreenRow;
  physicalEnd: PhysicalEnd;
  logicalCourt: LogicalCourt;
  side: Side;
  playerId: string | null;
  role: CourtPlayerRole;
}

export interface CourtHalfViewModel {
  screenHalf: CourtScreenHalf;
  physicalEnd: PhysicalEnd;
  side: Side;
  physicalEndConfirmed: boolean;
  cells: readonly [CourtCellViewModel, CourtCellViewModel];
}

export interface CourtViewModel {
  flipped: boolean;
  physicalEndsConfirmed: boolean;
  leftPhysicalEnd: PhysicalEnd;
  rightPhysicalEnd: PhysicalEnd;
  halves: readonly [CourtHalfViewModel, CourtHalfViewModel];
  cells: readonly CourtCellViewModel[];
}

const ACTIVE_SERVICE_PHASES = new Set<MatchPhase>(["IN_PROGRESS", "OBLIGATIONS_PENDING", "PAUSED"]);

const SCREEN_ROWS: readonly CourtScreenRow[] = ["TOP", "BOTTOM"];

function oppositeSide(side: Side): Side {
  return side === "A" ? "B" : "A";
}

function physicalEndForHalf(screenHalf: CourtScreenHalf, flipped: boolean): PhysicalEnd {
  if (screenHalf === "LEFT") return flipped ? "END_2" : "END_1";
  return flipped ? "END_1" : "END_2";
}

function logicalCourtForCell(screenHalf: CourtScreenHalf, screenRow: CourtScreenRow): LogicalCourt {
  if (screenHalf === "LEFT") return screenRow === "TOP" ? "L" : "R";
  return screenRow === "TOP" ? "R" : "L";
}

function physicalEndAssignment(state: MatchState) {
  const confirmed =
    state.physicalEnds !== null &&
    state.physicalEnds.A !== state.physicalEnds.B &&
    [state.physicalEnds.A, state.physicalEnds.B].every((end) => end === "END_1" || end === "END_2");

  if (!confirmed) {
    return {
      confirmed: false,
      sideByEnd: { END_1: "A", END_2: "B" } satisfies Record<PhysicalEnd, Side>,
    };
  }

  return {
    confirmed: true,
    sideByEnd: {
      [state.physicalEnds!.A]: "A",
      [state.physicalEnds!.B]: "B",
    } as Record<PhysicalEnd, Side>,
  };
}

function singlesCourtForSide(state: MatchState, side: Side): LogicalCourt | null {
  const playerId = state.players[side][0] ?? null;
  if (playerId === null) return null;
  if (playerId === state.serverPlayerId) return state.serverCourt;
  if (playerId === state.receiverPlayerId) return state.receiverCourt;
  if (state.servingSide === side) return state.serverCourt;
  if (state.servingSide !== null) return state.receiverCourt;
  return null;
}

function playerForCell(state: MatchState, side: Side, logicalCourt: LogicalCourt): string | null {
  if (state.format === "DOUBLES") return state.logicalCourts?.[side][logicalCourt] ?? null;
  return singlesCourtForSide(state, side) === logicalCourt ? (state.players[side][0] ?? null) : null;
}

function roleForCell(
  state: MatchState,
  side: Side,
  logicalCourt: LogicalCourt,
  playerId: string | null,
): CourtPlayerRole {
  if (!ACTIVE_SERVICE_PHASES.has(state.phase) || state.servingSide === null || playerId === null) return null;

  if (
    side === state.servingSide &&
    logicalCourt === state.serverCourt &&
    playerId === state.serverPlayerId
  ) {
    return "SERVER";
  }

  if (
    side === oppositeSide(state.servingSide) &&
    logicalCourt === state.receiverCourt &&
    playerId === state.receiverPlayerId
  ) {
    return "RECEIVER";
  }

  return null;
}

function buildHalf(
  state: MatchState,
  screenHalf: CourtScreenHalf,
  physicalEnd: PhysicalEnd,
  side: Side,
  physicalEndConfirmed: boolean,
): CourtHalfViewModel {
  const cells = SCREEN_ROWS.map((screenRow) => {
    const logicalCourt = logicalCourtForCell(screenHalf, screenRow);
    const playerId = playerForCell(state, side, logicalCourt);
    return {
      screenHalf,
      screenRow,
      physicalEnd,
      logicalCourt,
      side,
      playerId,
      role: roleForCell(state, side, logicalCourt, playerId),
    } satisfies CourtCellViewModel;
  }) as [CourtCellViewModel, CourtCellViewModel];

  return { screenHalf, physicalEnd, side, physicalEndConfirmed, cells };
}

/**
 * Projects the authoritative match state onto a top-down court.
 *
 * The projection never derives scoring or rotation rules. When physical ends
 * have not been established, it uses a stable A/END_1 and B/END_2 fallback and
 * marks every returned end as unconfirmed.
 */
export function buildCourtViewModel(state: MatchState, flipped: boolean): CourtViewModel {
  const assignment = physicalEndAssignment(state);
  const leftPhysicalEnd = physicalEndForHalf("LEFT", flipped);
  const rightPhysicalEnd = physicalEndForHalf("RIGHT", flipped);
  const left = buildHalf(
    state,
    "LEFT",
    leftPhysicalEnd,
    assignment.sideByEnd[leftPhysicalEnd],
    assignment.confirmed,
  );
  const right = buildHalf(
    state,
    "RIGHT",
    rightPhysicalEnd,
    assignment.sideByEnd[rightPhysicalEnd],
    assignment.confirmed,
  );
  const halves = [left, right] as const;

  return {
    flipped,
    physicalEndsConfirmed: assignment.confirmed,
    leftPhysicalEnd,
    rightPhysicalEnd,
    halves,
    cells: halves.flatMap((half) => half.cells),
  };
}
