/**
 * 压缩时钟。服务器时钟不能加速，压缩只作用于「比赛内容的节奏」：回合间隔、间歇、局间、裁判休息。
 * 租约（2 分钟）、心跳（30 秒）、名单截止、延误阈值（5 分钟）都按真实时间，不经过这里。
 */

export interface ClockProfile {
  name: "C8" | "C3" | "R1" | "C32" | "BURST";
  /** 现实 1 秒在仿真中等待的毫秒数。 */
  msPerRealSecond: number;
  /**
   * 回合间隔中位数（现实秒，含捡球、擦汗等死球时间）与离散度。
   * 校准依据（L1 实测）：两局制约 85 球，取 15 秒时 C8 实际时长中位仅 3.2 分钟、远短于计划 5 分钟，42 场全部提前开赛，
   * 延误统计失去意义。改为 25 秒：现实 85 球 × 25 秒 ≈ 35 分钟 + 间歇/局间 ≈ 40 分钟，与「现实一场 40 分钟」一致。
   */
  rallyMedianSeconds: number;
  rallySigma: number;
  /** 赛程设置：个人项目与团体小场预计时长、换场时间（分钟，服务端最小 5 / 0）。 */
  matchMinutes: number;
  rubberMinutes: number;
  changeoverMinutes: number;
  lineupDeadlineMinutes: number;
}

export const CLOCKS: Record<ClockProfile["name"], ClockProfile> = {
  // 现实 40 分钟 ≈ 仿真 5 分钟。回合 25 秒 × 1/8 ≈ 3.1 秒。
  C8: { name: "C8", msPerRealSecond: 125, rallyMedianSeconds: 25, rallySigma: 0.35, matchMinutes: 5, rubberMinutes: 5, changeoverMinutes: 1, lineupDeadlineMinutes: 2 },
  // 延误档：现实 40 分钟 ≈ 仿真 15 分钟（回合约 9.4 秒），计划时长 15 分钟，让 5 分钟延误阈值与时段的比例接近现实。
  C3: { name: "C3", msPerRealSecond: 375, rallyMedianSeconds: 25, rallySigma: 0.35, matchMinutes: 15, rubberMinutes: 15, changeoverMinutes: 3, lineupDeadlineMinutes: 5 },
  R1: { name: "R1", msPerRealSecond: 1000, rallyMedianSeconds: 25, rallySigma: 0.35, matchMinutes: 40, rubberMinutes: 35, changeoverMinutes: 5, lineupDeadlineMinutes: 15 },
  // 开发冒烟：只用于调通流程，不用于任何判定口径。
  C32: { name: "C32", msPerRealSecond: 30, rallyMedianSeconds: 25, rallySigma: 0.35, matchMinutes: 5, rubberMinutes: 5, changeoverMinutes: 0, lineupDeadlineMinutes: 1 },
  // 容量探测：没有任何等待。
  BURST: { name: "BURST", msPerRealSecond: 0, rallyMedianSeconds: 0, rallySigma: 0, matchMinutes: 5, rubberMinutes: 5, changeoverMinutes: 0, lineupDeadlineMinutes: 0 },
};

export class Clock {
  constructor(readonly profile: ClockProfile) {}

  /** 把现实秒数换成真实等待的毫秒。 */
  ms(realSeconds: number) {
    return Math.max(0, Math.round(realSeconds * this.profile.msPerRealSecond));
  }

  wait(realSeconds: number) {
    return sleep(this.ms(realSeconds));
  }
}

export function sleep(ms: number) {
  return ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
