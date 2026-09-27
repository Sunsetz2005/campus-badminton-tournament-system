import { randomBytes } from "node:crypto";

// 去掉易混字符（0/O、1/l/I）；16 位约 94 比特熵，满足 Better Auth 的 12 位下限。
const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ";
export const INITIAL_PASSWORD_LENGTH = 16;

/** 生成一次性初始口令。拒绝采样避免取模偏差；明文只返回给管理员一次，从不入库或写日志。 */
export function generateInitialPassword(length = INITIAL_PASSWORD_LENGTH) {
  const limit = 256 - (256 % ALPHABET.length);
  let password = "";
  while (password.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= limit) continue;
      password += ALPHABET[byte % ALPHABET.length];
      if (password.length === length) break;
    }
  }
  return password;
}
