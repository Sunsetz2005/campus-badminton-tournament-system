const redactedKeys = /password|secret|token|authorization|cookie/i;

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, redactedKeys.test(key) ? "[REDACTED]" : sanitize(nested)]),
    );
  }
  return value;
}

export function logServerEvent(event: string, fields: Record<string, unknown> = {}) {
  const safeFields = sanitize(fields) as Record<string, unknown>;
  console.info(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "info",
      event,
      ...safeFields,
    }),
  );
}
