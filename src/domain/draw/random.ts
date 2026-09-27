/**
 * 抽签用的可复现随机数。
 *
 * 同一个种子字符串在任何机器上都得到同一串随机数：只用 32 位整数运算，
 * 不读取 `Math.random`、当前时间或任何外部状态。种子本身由服务端用安全随机源生成并随抽签结果保存。
 */

function cyrb128(text: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let index = 0; index < text.length; index += 1) {
    const k = text.charCodeAt(index);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

export interface DrawRandom {
  /** [0, 1) 之间的下一个数。 */
  next(): number;
  /** [0, maxExclusive) 之间的整数。 */
  int(maxExclusive: number): number;
  /** 返回打乱后的新数组，不修改入参。 */
  shuffle<T>(items: readonly T[]): T[];
  pick<T>(items: readonly T[]): T;
}

export function createDrawRandom(seed: string): DrawRandom {
  if (!seed) throw new Error("抽签随机种子不能为空");
  let [a, b, c, d] = cyrb128(seed);
  const next = () => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  // 丢弃前若干个输出，避免相近种子的开头几位相关。
  for (let index = 0; index < 15; index += 1) next();

  const int = (maxExclusive: number) => {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) throw new Error("随机整数上限必须为正整数");
    return Math.floor(next() * maxExclusive);
  };
  return {
    next,
    int,
    shuffle<T>(items: readonly T[]) {
      const copy = [...items];
      for (let index = copy.length - 1; index > 0; index -= 1) {
        const swap = int(index + 1);
        [copy[index], copy[swap]] = [copy[swap], copy[index]];
      }
      return copy;
    },
    pick<T>(items: readonly T[]) {
      if (!items.length) throw new Error("不能从空列表中随机选择");
      return items[int(items.length)];
    },
  };
}
