/**
 * 独立期望比分模型（§8.2）。**不引用 src/domain**：只按《赛事执行规则 v1.0》§计分配置表实现——
 * 目标分 / 分差 / 封顶 / 局数、每局领先方首次到达 intervalAt 的局中间歇、局间间歇（betweenGamesSeconds>0 时）与局间换边、
 * 决胜局领先方首次到达阈值的换边。
 *
 * 输入是命令序列（类型 + 载荷），输出每条命令之后「应当」的比分、局分、当前局与待办类型集合。
 * 与服务端返回的状态逐条比较；两边不一致时先怀疑本模型（§12.5 取舍 1），再判定系统问题。
 *
 * 目前覆盖：开局/局间设置、逐分、间歇确认、换边确认、提交/复核（不改比分）、WO/RET/DSQ/ABANDONED（只校验比分冻结）。
 * 撤销与四类更正在 M4 注入时加入；遇到未建模的命令返回 `unsupported`，该场之后不再逐条比较。
 */

export interface OracleRule {
  bestOf: number;
  targetPoints: number;
  winBy: number;
  capPoints: number;
  intervalAt: number | null;
  decidingGameChangeEndsAt: number | null;
  /** 局间间歇秒数；>0 时每局结束（比赛未结束）产生一个间歇待办。单局 21 没有局间。 */
  betweenGamesSeconds: number;
}

export type ObligationKind = "INTERVAL" | "CHANGE_ENDS";

export interface OracleState {
  currentGame: number;
  score: { A: number; B: number };
  gamesWon: { A: number; B: number };
  completedGames: { A: number; B: number }[];
  pending: ObligationKind[];
  /** 本局已触发过的阈值（每局只触发一次）。 */
  issued: Set<string>;
  over: boolean;
  frozen: boolean;
}

export function initialOracleState(): OracleState {
  return { currentGame: 1, score: { A: 0, B: 0 }, gamesWon: { A: 0, B: 0 }, completedGames: [], pending: [], issued: new Set(), over: false, frozen: false };
}

export function gamesToWin(rule: OracleRule) {
  return (rule.bestOf + 1) / 2;
}

/** 一局是否已经决出：到目标分且领先至少 winBy，或任一方到封顶分。 */
export function gameDecided(a: number, b: number, rule: OracleRule) {
  const high = Math.max(a, b);
  if (high >= rule.capPoints) return true;
  return high >= rule.targetPoints && Math.abs(a - b) >= rule.winBy;
}

function isDecidingGame(state: OracleState, rule: OracleRule) {
  const need = gamesToWin(rule);
  return state.gamesWon.A === need - 1 && state.gamesWon.B === need - 1;
}

export type OracleStep = { ok: true } | { ok: false; reason: "unsupported" | "invalid"; detail: string };

export function applyOracle(state: OracleState, rule: OracleRule, type: string, payload: Record<string, unknown>): OracleStep {
  switch (type) {
    case "RECORD_COIN_TOSS":
    case "INVALIDATE_COIN_TOSS":
    case "CONFIRM_OPENING_SETUP":
    case "SUBMIT_RESULT":
    case "CONFIRM_RESULT":
    case "REOPEN_RESULT":
    case "LET":
    case "PAUSE_MATCH":
    case "RESUME_MATCH":
    case "CORRECT_LOGICAL_COURTS":
    case "CORRECT_SERVICE_ORDER":
      return { ok: true };
    case "CONFIRM_NEXT_GAME_SETUP":
      state.score = { A: 0, B: 0 };
      state.pending = [];
      state.issued = new Set();
      return { ok: true };
    case "ACKNOWLEDGE_INTERVAL":
      return removePending(state, "INTERVAL");
    case "CONFIRM_CHANGE_ENDS":
    case "RECORD_MISSED_CHANGE_ENDS":
      return removePending(state, "CHANGE_ENDS");
    case "RECORD_SPECIAL_OUTCOME":
      state.frozen = true;
      state.over = true;
      state.pending = [];
      return { ok: true };
    case "INVALIDATE_SPECIAL_OUTCOME":
      return { ok: false, reason: "unsupported", detail: "作废特殊结果尚未建模" };
    case "VOID_MATCH_SCORING":
      // 赛务口径 S-7：第一局结束前作废本场计分，回到抛币前的初始状态。
      Object.assign(state, initialOracleState());
      return { ok: true };
    case "RALLY_WON": {
      if (state.over) return { ok: false, reason: "invalid", detail: "比赛已结束仍记分" };
      const side = payload.side === "A" ? "A" : "B";
      state.score[side] += 1;
      const { A, B } = state.score;
      if (gameDecided(A, B, rule)) {
        const winner = A > B ? "A" : "B";
        state.gamesWon[winner] += 1;
        state.completedGames.push({ A, B });
        if (state.gamesWon[winner] >= gamesToWin(rule)) {
          state.over = true;
          state.pending = [];
        } else {
          // 局间间歇与局间换边。
          state.pending = rule.betweenGamesSeconds > 0 ? ["INTERVAL", "CHANGE_ENDS"] : ["CHANGE_ENDS"];
          state.currentGame += 1;
        }
        return { ok: true };
      }
      const leader = Math.max(A, B);
      if (rule.intervalAt && leader === rule.intervalAt && !state.issued.has("INTERVAL")) {
        state.issued.add("INTERVAL");
        state.pending.push("INTERVAL");
      }
      if (rule.decidingGameChangeEndsAt && isDecidingGame(state, rule) && leader === rule.decidingGameChangeEndsAt && !state.issued.has("CHANGE_ENDS")) {
        state.issued.add("CHANGE_ENDS");
        state.pending.push("CHANGE_ENDS");
      }
      return { ok: true };
    }
    default:
      return { ok: false, reason: "unsupported", detail: `命令 ${type} 尚未建模` };
  }
}

function removePending(state: OracleState, kind: ObligationKind): OracleStep {
  const index = state.pending.indexOf(kind);
  if (index < 0) return { ok: false, reason: "invalid", detail: `没有待处理的 ${kind}` };
  state.pending.splice(index, 1);
  return { ok: true };
}

/** 与服务端状态比较；返回差异描述（空数组表示一致）。 */
export function diffAgainst(
  oracle: OracleState,
  server: {
    currentGame: number;
    score: { A: number; B: number };
    gamesWon: { A: number; B: number };
    completedGames?: { scoreA?: number; scoreB?: number; A?: number; B?: number }[];
    pendingObligations: { type: string }[];
  },
) {
  const differences: string[] = [];
  if (oracle.gamesWon.A !== server.gamesWon.A || oracle.gamesWon.B !== server.gamesWon.B) {
    differences.push(`局分 期望 ${oracle.gamesWon.A}:${oracle.gamesWon.B} 实际 ${server.gamesWon.A}:${server.gamesWon.B}`);
  }
  // 局结束后、下一局设置前，双方比分停在该局终局比分（本模型同样只在下一局设置时清零）；局号不比较。
  if (!oracle.frozen) {
    if (oracle.score.A !== server.score.A || oracle.score.B !== server.score.B) {
      differences.push(`比分 期望 ${oracle.score.A}:${oracle.score.B} 实际 ${server.score.A}:${server.score.B}（第 ${server.currentGame} 局）`);
    }
  }
  const completed = (server.completedGames ?? []).map((game) => ({ A: game.A ?? game.scoreA ?? -1, B: game.B ?? game.scoreB ?? -1 }));
  if (completed.length !== oracle.completedGames.length || completed.some((game, index) => game.A !== oracle.completedGames[index].A || game.B !== oracle.completedGames[index].B)) {
    differences.push(`已完成局 期望 ${fmt(oracle.completedGames)} 实际 ${fmt(completed)}`);
  }
  const expected = [...oracle.pending].sort().join(",");
  const actual = server.pendingObligations.map((item) => item.type).filter((type) => type === "INTERVAL" || type === "CHANGE_ENDS").sort().join(",");
  if (expected !== actual) differences.push(`待办 期望 [${expected}] 实际 [${actual}]`);
  return differences;
}

function fmt(games: { A: number; B: number }[]) {
  return games.map((game) => `${game.A}-${game.B}`).join(" ") || "无";
}
