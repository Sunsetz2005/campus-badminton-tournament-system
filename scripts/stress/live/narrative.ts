/**
 * 比赛走向（§5.2）：每场抽一个模板，逐球决定胜方。模板只看当前比分与局数，不看服务端以外的状态。
 * - ROUT 一边倒：强方每球胜率 0.7—0.8；
 * - TIGHT 拉锯：0.5，常打满三局；
 * - DEUCE 多次加分：到 (target-2) 平后交替得分若干次再分胜负；
 * - CAP 封顶：一路交替直到封顶分（29:29 → 30）；
 * - COMEBACK 决胜局逆转：前两局各胜一局，决胜局落后方后程反超。
 * - LONG 强制长局：打满三局、每局都到 20 平后多次交替，用于延误情形（§5.3）；
 * - SCRIPT 指定比分：逐局给定最终比分（A/B 方视角），用于强制同分（小组名次并列）。
 */
import type { Rng } from "../core/rng";

export type NarrativeKind = "ROUT" | "TIGHT" | "DEUCE" | "CAP" | "COMEBACK" | "LONG" | "SCRIPT";

/** 注入点给一场比赛指定的走向：强制长局，或逐局指定最终比分。 */
export type ForcedNarrative = { kind: "LONG"; why: string } | { kind: "SCRIPT"; games: { A: number; B: number }[]; why: string };

export interface RuleShape {
  bestOf: number;
  targetPoints: number;
  winBy: number;
  capPoints: number;
}

export interface ScoreView {
  currentGame: number;
  score: { A: number; B: number };
  gamesWon: { A: number; B: number };
}

export class Narrative {
  readonly strong: "A" | "B";
  readonly pStrong: number;
  private deuceRallies: number;
  private deuceGame = 0;
  private deciderFavoured: "A" | "B" = "A";

  constructor(readonly kind: NarrativeKind, private rng: Rng, readonly script: { A: number; B: number }[] | null = null) {
    this.strong = rng.chance(0.5) ? "A" : "B";
    this.pStrong = kind === "ROUT" ? 0.7 + rng.next() * 0.1 : kind === "COMEBACK" ? 0.55 : 0.5;
    this.deuceRallies = kind === "DEUCE" ? rng.int(2, 6) : 0;
  }

  static forced(spec: ForcedNarrative, rng: Rng) {
    return spec.kind === "SCRIPT" ? new Narrative("SCRIPT", rng, spec.games) : new Narrative("LONG", rng);
  }

  static pick(rng: Rng, weights: Partial<Record<NarrativeKind, number>> = { ROUT: 0.35, TIGHT: 0.35, DEUCE: 0.15, CAP: 0.05, COMEBACK: 0.1 }) {
    const entries = Object.entries(weights) as [NarrativeKind, number][];
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = rng.next() * total;
    for (const [kind, weight] of entries) {
      roll -= weight;
      if (roll <= 0) return new Narrative(kind, rng);
    }
    return new Narrative(entries[0][0], rng);
  }

  /** 下一球的胜方。 */
  next(view: ScoreView, rule: RuleShape): "A" | "B" {
    const { A, B } = view.score;
    const weak = this.strong === "A" ? "B" : "A";
    const deuceFloor = rule.targetPoints - 1;
    if (this.kind === "SCRIPT") {
      // 败方先追到目标分（且不超过胜方），之后胜方连得到局终；这样胜方不会提前达到获胜条件。
      const target = this.script?.[view.currentGame - 1];
      if (!target) return this.rng.chance(0.5) ? "A" : "B";
      const winner = target.A > target.B ? "A" : "B";
      const loser = winner === "A" ? "B" : "A";
      const loserScore = view.score[loser];
      return loserScore < target[loser] && loserScore <= view.score[winner] ? loser : winner;
    }
    if (this.kind === "LONG") {
      // 第 1 局强方、第 2 局弱方、决胜局随机；每局都咬到 20 平，再交替 3—7 球。
      if (this.deuceGame !== view.currentGame) {
        this.deuceGame = view.currentGame;
        this.deuceRallies = this.rng.int(3, 7);
        this.deciderFavoured = this.rng.chance(0.5) ? "A" : "B";
      }
      const favoured = view.currentGame === 1 ? this.strong : view.currentGame === 2 ? weak : this.deciderFavoured;
      if (A < deuceFloor || B < deuceFloor) {
        if (A === B) return this.rng.chance(0.55) ? favoured : favoured === "A" ? "B" : "A";
        return this.rng.chance(0.8) ? (A < B ? "A" : "B") : A < B ? "B" : "A";
      }
      if (this.deuceRallies > 0 && Math.max(A, B) < rule.capPoints - 1) {
        this.deuceRallies -= 1;
        return A <= B ? "A" : "B";
      }
      return favoured;
    }
    if (this.kind === "CAP" && A >= deuceFloor && B >= deuceFloor && Math.max(A, B) < rule.capPoints - 1) {
      return A <= B ? "A" : "B";
    }
    if (this.kind === "DEUCE" && A >= deuceFloor && B >= deuceFloor && this.deuceRallies > 0) {
      this.deuceRallies -= 1;
      return A <= B ? "A" : "B";
    }
    if (this.kind === "COMEBACK") {
      const decider = view.currentGame === rule.bestOf && rule.bestOf > 1;
      if (!decider) {
        // 前两局各胜一局：第 1 局强方、第 2 局弱方占优。
        const favoured = view.currentGame === 1 ? this.strong : weak;
        return this.rng.chance(0.65) ? favoured : favoured === "A" ? "B" : "A";
      }
      const leader = A === B ? this.strong : A > B ? "A" : "B";
      const trailing = leader === "A" ? "B" : "A";
      const late = Math.max(A, B) >= Math.floor(rule.targetPoints / 2);
      return late ? (this.rng.chance(0.7) ? trailing : leader) : this.rng.chance(0.65) ? weak : this.strong;
    }
    return this.rng.chance(this.pStrong) ? this.strong : weak;
  }

  /** 预期总局数下界，供调度判断（不参与判定）。 */
  describe() {
    return { kind: this.kind, strong: this.strong, pStrong: Math.round(this.pStrong * 100) / 100, ...(this.script ? { script: this.script } : {}) };
  }
}
