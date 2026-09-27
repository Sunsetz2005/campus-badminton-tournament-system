import Link from "next/link";

import styles from "@/features/management/management.module.css";

type Phase = "PREPARING" | "REGISTRATION_OPEN" | "REGISTRATION_CLOSED" | "RUNNING" | "FINISHED";

const PHASE_ORDER: readonly Phase[] = ["PREPARING", "REGISTRATION_OPEN", "REGISTRATION_CLOSED", "RUNNING", "FINISHED"];

interface Step {
  key: string;
  title: string;
  hint: string;
  href: string;
  /** 这一步通常在哪个赛事阶段进行。 */
  phase: Phase;
}

/**
 * 赛事后台的操作顺序指引。
 *
 * 只按管理员手动推进的赛事阶段标出「当前阶段」与「已过阶段」，
 * 不根据数据猜测某一步是否「已完成」——那需要各业务服务给出权威判断。
 */
export function WorkflowGuide({ slug, phase, pendingRegistrations }: { slug: string; phase: Phase; pendingRegistrations: number }) {
  const base = `/management/${slug}`;
  const steps: Step[] = [
    { key: "setup", title: "赛事设置", hint: "项目、报名窗口、海报与邀请链接", href: base, phase: "PREPARING" },
    { key: "registrations", title: "报名审核", hint: pendingRegistrations ? `还有 ${pendingRegistrations} 份待审核` : "逐份核对并通过或驳回", href: `${base}/registrations`, phase: "REGISTRATION_OPEN" },
    { key: "draw", title: "抽签编排", hint: "分组、签表与对阵", href: `${base}/draw`, phase: "REGISTRATION_CLOSED" },
    { key: "schedule", title: "赛程排班", hint: "场地、时间与裁判指派", href: `${base}/schedule`, phase: "REGISTRATION_CLOSED" },
    { key: "results", title: "成绩名次", hint: "复核结果、确认名次并发布", href: `${base}/results`, phase: "RUNNING" },
  ];
  const current = PHASE_ORDER.indexOf(phase);

  return (
    <nav aria-label="办赛流程" className={styles.workflow}>
      <ol>
        {steps.map((step, index) => {
          const stepPhase = PHASE_ORDER.indexOf(step.phase);
          const state = stepPhase === current || (phase === "FINISHED" && step.phase === "RUNNING")
            ? "current"
            : stepPhase < current ? "past" : "upcoming";
          return (
            <li data-state={state} key={step.key}>
              <Link aria-current={state === "current" ? "step" : undefined} href={step.href}>
                <span aria-hidden="true" className={styles.workflowIndex}>{index + 1}</span>
                <span className={styles.workflowText}>
                  <strong>{step.title}</strong>
                  <small>{step.hint}</small>
                </span>
                {state === "current" ? <span className={styles.workflowNow}>当前阶段</span> : null}
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
