/**
 * 独立的最终名次、淘汰签位映射与团体对抗胜负（§8.4—8.5）。**不引用 src/domain**，依据：
 * - 《分组排名与特殊结果》：决赛定 1、2；有三四名赛定 3、4，没有时两名半决赛负者并列第 3；
 *   更早轮次负者记「并列第 5（八强）」等；小组未出线者不跨组排名；单循环取确认的名次。
 * - 《赛事执行规则 v1.0》：两组 A1—B2、B1—A2；四组 QF1=A1—B2、QF2=C1—D2、QF3=B1—A2、QF4=D1—C2。
 * - 团体对抗：小场胜数先过半者胜；淘汰对抗决出即止（未开始的小场记「未进行」），小组对抗打满。
 */

export interface KnockoutFact {
  code: string;
  kind: "KNOCKOUT" | "THIRD_PLACE";
  round: number;
  sideA: string | null;
  sideB: string | null;
  winner: string | null;
}

export interface ExpectedPlacement {
  entryId: string;
  place: number | null;
  tied: boolean;
  label: string;
}

const ROUND_LABEL: Record<number, string> = { 4: "四强", 8: "八强", 16: "十六强", 32: "三十二强", 64: "六十四强" };

/** 淘汰赛名次。rounds 从 1 开始计，最大轮次是决赛。 */
export function knockoutPlacements(fixtures: readonly KnockoutFact[], thirdPlace: boolean): ExpectedPlacement[] {
  const main = fixtures.filter((item) => item.kind === "KNOCKOUT");
  if (!main.length) return [];
  const finalRound = Math.max(...main.map((item) => item.round));
  const result: ExpectedPlacement[] = [];
  const final = main.find((item) => item.round === finalRound);
  if (final?.winner) {
    result.push({ entryId: final.winner, place: 1, tied: false, label: "第 1 名" });
    const loser = final.winner === final.sideA ? final.sideB : final.sideA;
    if (loser) result.push({ entryId: loser, place: 2, tied: false, label: "第 2 名" });
  }
  const third = fixtures.find((item) => item.kind === "THIRD_PLACE");
  if (thirdPlace && third?.winner) {
    result.push({ entryId: third.winner, place: 3, tied: false, label: "第 3 名" });
    const loser = third.winner === third.sideA ? third.sideB : third.sideA;
    if (loser) result.push({ entryId: loser, place: 4, tied: false, label: "第 4 名" });
  }
  for (const fixture of main) {
    if (!fixture.winner || fixture.round === finalRound) continue;
    const loser = fixture.winner === fixture.sideA ? fixture.sideB : fixture.sideA;
    if (!loser) continue;
    const remaining = 2 ** (finalRound - fixture.round + 1);
    if (remaining === 4) {
      if (!thirdPlace) result.push({ entryId: loser, place: 3, tied: true, label: "并列第 3" });
      continue;
    }
    const place = remaining / 2 + 1;
    result.push({ entryId: loser, place, tied: true, label: `并列第 ${place}（${ROUND_LABEL[remaining] ?? `${remaining} 强`}）` });
  }
  return result;
}

/** 两组 / 四组的固定首轮映射；其他组数返回 null（只校验不变量）。 */
export function fixedFirstRound(groupCodes: readonly string[]): [string, string][] | null {
  const codes = [...groupCodes].sort();
  if (codes.length === 2) {
    const [A, B] = codes;
    return [[`${A}1`, `${B}2`], [`${B}1`, `${A}2`]];
  }
  if (codes.length === 4) {
    const [A, B, C, D] = codes;
    return [[`${A}1`, `${B}2`], [`${C}1`, `${D}2`], [`${B}1`, `${A}2`], [`${D}1`, `${C}2`]];
  }
  return null;
}

export interface RubberFact {
  order: number;
  winnerSide: "A" | "B" | null;
  /** 已复核锁定或记为未进行。 */
  settled: boolean;
  notPlayed: boolean;
  started: boolean;
}

/** 对抗胜负：小场胜数先过半者胜。返回胜方与应记为「未进行」的小场（淘汰对抗决出后尚未开始的）。 */
export function tieOutcome(rubbers: readonly RubberFact[], knockout: boolean) {
  const need = Math.floor(rubbers.length / 2) + 1;
  let a = 0;
  let b = 0;
  let decidedAt: number | null = null;
  const ordered = [...rubbers].sort((x, y) => x.order - y.order);
  for (const rubber of ordered) {
    if (!rubber.settled || rubber.notPlayed) continue;
    if (rubber.winnerSide === "A") a += 1;
    else if (rubber.winnerSide === "B") b += 1;
    if (decidedAt === null && (a >= need || b >= need)) decidedAt = rubber.order;
  }
  const winner = a >= need ? "A" : b >= need ? "B" : null;
  const expectNotPlayed = knockout && winner ? ordered.filter((rubber) => !rubber.started && !(rubber.settled && !rubber.notPlayed)).map((rubber) => rubber.order) : [];
  return { winner, rubbersA: a, rubbersB: b, expectNotPlayed };
}

/**
 * 非 2 次幂签表的轮空（《赛事执行规则 v1.0》：不小于晋级人数的最小 2 次幂签位；轮空优先小组第一，同条件公开随机）。
 * 同条件内谁轮空是随机的，因此只给出「签表大小、轮空数、获得轮空者的名次构成」。
 */
export function byePlan(qualifierRanks: readonly number[]) {
  const count = qualifierRanks.length;
  let size = 1;
  while (size < count) size *= 2;
  const byes = size - count;
  const byeRanks = [...qualifierRanks].sort((a, b) => a - b).slice(0, byes);
  return { bracketSize: size, byes, byeRanks };
}
