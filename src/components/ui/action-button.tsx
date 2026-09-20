import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ActionButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ActionButtonSize = "sm" | "md" | "lg";

export interface ActionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  loading?: boolean;
  loadingLabel?: string;
  size?: ActionButtonSize;
  variant?: ActionButtonVariant;
}

export function ActionButton({
  children,
  className = "",
  disabled,
  loading = false,
  loadingLabel = "处理中…",
  size = "md",
  type = "button",
  variant = "primary",
  ...props
}: ActionButtonProps) {
  const classes = [
    "ui-action-button",
    `ui-action-button-${variant}`,
    `ui-action-button-${size}`,
    className,
  ].filter(Boolean).join(" ");

  return (
    <button
      {...props}
      aria-busy={loading || undefined}
      className={classes}
      disabled={disabled || loading}
      type={type}
    >
      {loading ? <span aria-hidden="true" className="ui-button-spinner" /> : null}
      <span>{loading ? loadingLabel : children}</span>
    </button>
  );
}
