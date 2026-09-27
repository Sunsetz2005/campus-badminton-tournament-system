import { redirect } from "next/navigation";

import { prisma } from "@/db/client";
import styles from "@/features/management/management.module.css";
import { ChangePasswordForm } from "@/features/team/change-password-form";
import { requireActivePageUser } from "@/server/auth/page-authorization";
import { getPageSession } from "@/server/auth/session";

export const dynamic = "force-dynamic";

export default async function ChangePasswordPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const session = await getPageSession();
  if (!session) redirect("/login?next=/account/password");
  const user = await requireActivePageUser(session);
  const { mustChangePassword } = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { mustChangePassword: true } });
  const { next } = await searchParams;
  // 只接受站内相对路径，避免开放重定向。
  const target = next?.startsWith("/") && !next.startsWith("//") ? next : "/settings";
  return (
    <section className="narrow-page">
      <div className={styles.heading}>
        <p className="eyebrow">账号安全</p>
        <h1>修改口令</h1>
        {mustChangePassword ? (
          <p className={styles.info}>你正在使用管理员开通时生成的初始口令。请先设置自己的新口令，之后才能提交名单。</p>
        ) : (
          <p>修改后，其他设备上的登录会全部失效。</p>
        )}
      </div>
      <ChangePasswordForm next={target} />
    </section>
  );
}
