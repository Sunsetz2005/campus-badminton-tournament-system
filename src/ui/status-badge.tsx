import type { ReactNode } from "react";

export type StatusTone = "neutral" | "info" | "ok" | "warn" | "danger";

export interface StatusBadgeProps {
  children: ReactNode;
  detail?: string;
  tone?: StatusTone;
}

export function StatusBadge({ children, detail, tone = "neutral" }: StatusBadgeProps) {
  return (
    <span className={`status-badge status-${tone}`}>
      <span>{children}</span>
      {detail ? <small>{detail}</small> : null}
    </span>
  );
}
