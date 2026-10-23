/**
 * 可复现随机：一个总种子按名字派生互不影响的子流（splitmix64 → xoshiro128**）。
 * 「报名名单」「抽签输入」「每场走向」「注入点」各用自己的子流，改动一处不会让其他流的序列漂移。
 */

function fnv1a(text: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function splitmix32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

export class Rng {
  private s: Uint32Array;

  constructor(readonly seed: number, readonly label = "root") {
    const mix = splitmix32(seed ^ fnv1a(label));
    this.s = new Uint32Array([mix(), mix(), mix(), mix()]);
    if (this.s.every((value) => value === 0)) this.s[0] = 1;
  }

  /** 按名字派生独立子流；同一父流、同一名字总是得到同一序列。 */
  fork(name: string) {
    return new Rng(this.seed, `${this.label}/${name}`);
  }

  private nextUint32() {
    const s = this.s;
    const result = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
    const t = (s[1] << 9) >>> 0;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 11);
    return result;
  }

  /** [0, 1) */
  next() {
    return this.nextUint32() / 0x100000000;
  }

  int(min: number, max: number) {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(probability: number) {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (!items.length) throw new Error(`${this.label}: 不能从空列表中抽取。`);
    return items[Math.floor(this.next() * items.length)];
  }

  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const other = Math.floor(this.next() * (index + 1));
      [copy[index], copy[other]] = [copy[other], copy[index]];
    }
    return copy;
  }

  /** 对数正态：中位数 median，离散度 sigma。用于回合间隔等长尾时长。 */
  logNormal(median: number, sigma: number) {
    const u1 = Math.max(this.next(), 1e-12);
    const u2 = this.next();
    const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return median * Math.exp(sigma * normal);
  }

  /** 32 位十六进制标识，供 commandId 以外需要「随机但可复现」的地方使用。 */
  hex(bytes = 16) {
    let text = "";
    while (text.length < bytes * 2) text += this.nextUint32().toString(16).padStart(8, "0");
    return text.slice(0, bytes * 2);
  }

  /** 可复现的 UUID v4 形状字符串（deviceSessionId 等）。 */
  uuid() {
    const hex = this.hex(16).split("");
    hex[12] = "4";
    hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
    const text = hex.join("");
    return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
  }
}

function rotl(value: number, shift: number) {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}
