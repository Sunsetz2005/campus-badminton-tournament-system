/**
 * R3-005：局域网明文 HTTP 不是安全上下文，crypto.randomUUID 可能不存在。
 *
 * 命令 ID 与设备 ID 都必须来自密码学安全随机源。
 * crypto.getRandomValues 在非安全上下文同样可用，因此可作为受审查的兼容路径；
 * 两者都缺失时必须在进入可写界面前给出明确提示并保持只读，绝不使用 Math.random。
 */

export interface CryptoLike {
  randomUUID?: () => string;
  getRandomValues?: <T extends ArrayBufferView>(array: T) => T;
}

export type CommandIdCapability =
  | { available: true; source: "CRYPTO_RANDOM_UUID" }
  | { available: true; source: "CRYPTO_GET_RANDOM_VALUES"; advisory: string }
  | { available: false; reason: string };

export const INSECURE_CONTEXT_ADVISORY =
  "当前页面不是安全上下文（非 HTTPS 且非 localhost）。本机已改用 crypto.getRandomValues 生成命令 ID 以便本地演示，正式执裁请改用可信 HTTPS 访问。";

export const NO_SECURE_RANDOM_MESSAGE =
  "当前浏览器在此访问方式下没有可用的密码学安全随机源，无法安全生成命令 ID。界面保持只读；请改用 HTTPS 访问或更换浏览器后再执裁。";

export function detectCommandIdCapability(
  cryptoLike: CryptoLike | undefined,
  isSecureContext: boolean,
): CommandIdCapability {
  if (cryptoLike && typeof cryptoLike.randomUUID === "function" && isSecureContext) {
    return { available: true, source: "CRYPTO_RANDOM_UUID" };
  }
  if (cryptoLike && typeof cryptoLike.getRandomValues === "function") {
    return { available: true, source: "CRYPTO_GET_RANDOM_VALUES", advisory: INSECURE_CONTEXT_ADVISORY };
  }
  if (cryptoLike && typeof cryptoLike.randomUUID === "function") {
    return { available: true, source: "CRYPTO_RANDOM_UUID" };
  }
  return { available: false, reason: NO_SECURE_RANDOM_MESSAGE };
}

const HEX = Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(2, "0"));

/** RFC 4122 第 4 版 UUID，随机位全部取自 crypto.getRandomValues。 */
export function randomUuidFromSecureBytes(cryptoLike: CryptoLike): string {
  if (typeof cryptoLike.getRandomValues !== "function") throw new Error(NO_SECURE_RANDOM_MESSAGE);
  const bytes = cryptoLike.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => HEX[byte]);
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

export function createCommandId(cryptoLike: CryptoLike | undefined, isSecureContext: boolean): string {
  const capability = detectCommandIdCapability(cryptoLike, isSecureContext);
  if (!capability.available) throw new Error(capability.reason);
  if (capability.source === "CRYPTO_RANDOM_UUID") return cryptoLike!.randomUUID!();
  return randomUuidFromSecureBytes(cryptoLike!);
}
