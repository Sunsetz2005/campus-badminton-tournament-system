/**
 * 登录后跳转只接受站内相对路径。
 *
 * - `//host` 与 `/\\host` 会被浏览器当作外站地址；
 * - 浏览器解析地址时会丢弃制表符与换行，`/\t/host` 实际等于 `//host`，所以含控制字符的一律拒绝；
 * - 反斜杠在地址里等同于正斜杠，路径部分出现即拒绝；
 * - 最后按浏览器的规则实际解析一次，来源变了就拒绝，作为兜底。
 */
const PROBE_ORIGIN = "http://next-path.invalid";

export function safeNextPath(value: string | null | undefined) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return "/";
  try {
    if (new URL(value, PROBE_ORIGIN).origin !== PROBE_ORIGIN) return "/";
  } catch {
    return "/";
  }
  return value;
}
