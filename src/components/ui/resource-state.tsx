import type { ReactNode } from "react";

export type ResourceStateTone = "loading" | "empty" | "error" | "stale" | "not-found";

export interface ResourceStateProps {
  action?: ReactNode;
  description: string;
  eyebrow?: string;
  title: string;
  tone: ResourceStateTone;
}

export function ResourceState({ action, description, eyebrow, title, tone }: ResourceStateProps) {
  const liveRole = tone === "error" ? "alert" : tone === "loading" ? "status" : undefined;

  return (
    <section
      aria-busy={tone === "loading" || undefined}
      className={`ui-resource-state ui-resource-state-${tone}`}
      role={liveRole}
    >
      <span aria-hidden="true" className="ui-resource-state-mark" />
      <div>
        {eyebrow ? <p className="ui-resource-state-eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        <p>{description}</p>
        {action ? <div className="ui-resource-state-action">{action}</div> : null}
      </div>
    </section>
  );
}
