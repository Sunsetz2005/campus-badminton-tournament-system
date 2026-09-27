/** 登录后跳转只接受站内相对路径；`//host` 与 `/\host` 会被浏览器当作外站地址，必须拒绝。 */
export function safeNextPath(value: string | null | undefined) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  return value;
}
