import type { Metadata } from "next";

import { formatZoned } from "@/domain/time/zoned-time";
import { InviteRegistrationForm } from "@/features/management/invite-registration-form";
import styles from "@/features/management/management.module.css";
import { resolveInvite } from "@/server/services/registration-invite-service";

export const dynamic = "force-dynamic";

// 链接里带着邀请令牌：禁止搜索引擎收录，也不把完整地址通过 Referer 带给外站。
export const metadata: Metadata = {
  title: "赛事报名｜羽赛台",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function InviteRegistrationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const availability = await resolveInvite(token);

  if (availability.state === "INVALID") {
    return (
      <section className={`narrow-page ${styles.page}`}>
        <div className={styles.heading}>
          <p className="eyebrow">赛事报名</p>
          <h1>报名链接无效或已失效</h1>
          <p>链接可能已过期、已被停用或名额已满。请联系赛事组织方获取新的报名链接。</p>
        </div>
      </section>
    );
  }

  const { tournament, competitions, state } = availability;
  const window = [
    tournament.registrationOpensAt ? `开始 ${formatZoned(tournament.registrationOpensAt, tournament.timezone)}` : null,
    tournament.registrationClosesAt ? `截止 ${formatZoned(tournament.registrationClosesAt, tournament.timezone)}` : null,
  ].filter(Boolean).join("，");

  return (
    <section className={`narrow-page ${styles.page}`}>
      <div className={styles.heading}>
        <p className="eyebrow">赛事报名 · {availability.invite.label}</p>
        <h1>{tournament.name}</h1>
        {tournament.subtitle ? <p>{tournament.subtitle}</p> : null}
        {tournament.venue ? <p>场馆：{tournament.venue}</p> : null}
        {window ? <p>报名时间：{window}</p> : null}
      </div>

      {tournament.regulations ? (
        <details className={styles.section}>
          <summary><strong>规程说明</strong></summary>
          <p style={{ whiteSpace: "pre-wrap", margin: 0, lineHeight: 1.7 }}>{tournament.regulations}</p>
        </details>
      ) : null}

      {state === "OPEN" ? (
        <InviteRegistrationForm competitions={competitions} token={token} />
      ) : (
        <p className={styles.info} role="status">
          {state === "NOT_YET_OPEN" ? "报名尚未开始，请在报名时间内再打开本链接。" : "报名已截止。如需补报，请联系赛事组织方。"}
        </p>
      )}
    </section>
  );
}
