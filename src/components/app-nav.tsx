"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { authClient } from "@/lib/auth-client";

const links = [
  ["/", "首页"],
  ["/management", "赛事管理"],
  ["/officiating", "我的执裁"],
  ["/public", "公开查询"],
  ["/settings", "设置"],
] as const;

export function AppNav() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();

  async function signOut() {
    await authClient.signOut();
    router.push("/");
    router.refresh();
  }

  return (
    <header className="topbar">
      <Link className="brand" href="/">
        羽赛台
      </Link>
      <nav aria-label="主导航">
        {links.map(([href, label]) => (
          <Link href={href} key={href}>
            {label}
          </Link>
        ))}
      </nav>
      <div className="session-slot">
        {isPending ? (
          <span>检查登录状态…</span>
        ) : session ? (
          <>
            <span>{session.user.name}</span>
            <button className="text-button" onClick={signOut} type="button">
              退出
            </button>
          </>
        ) : (
          <Link className="button small" href="/login">
            登录
          </Link>
        )}
      </div>
    </header>
  );
}
