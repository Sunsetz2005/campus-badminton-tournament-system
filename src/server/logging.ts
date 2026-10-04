// 凭据类与个人信息类字段一律脱敏；日志只应记录路由、错误码、内部 ID 这类排查所需的最少信息。
const redactedKeys = /password|secret|token|authorization|cookie|email|phone|contact|studentid|realname|idcard/i;

export function sanitizeLogFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeLogFields);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, redactedKeys.test(key) ? "[REDACTED]" : sanitizeLogFields(nested)]),
    );
  }
  return value;
}

export function logServerEvent(event: string, fields: Record<string, unknown> = {}) {
  const safeFields = sanitizeLogFields(fields) as Record<string, unknown>;
  console.info(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "info",
      event,
      ...safeFields,
    }),
  );
}
