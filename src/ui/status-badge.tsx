import type { ReactNode } from "react";

export function StatusBadge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "ok" | "warn" }) {
  return <span className={`status-badge status-${tone}`}>{children}</span>;
}
