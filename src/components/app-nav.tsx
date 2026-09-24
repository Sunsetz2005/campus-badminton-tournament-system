"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { authClient } from "@/lib/auth-client";
import type { NavContext } from "@/server/auth/nav-context";

/**
 * 导航只决定「显示什么」，不决定「允许什么」。
 * 权限一律由服务端在页面和 API 内重新校验；直接访问被隐藏的地址仍会被拒绝。
 */
function linksFor(navContext: NavContext) {
  const links: [string, string][] = [["/", "赛事"]];
  if (navContext.canOfficiate) links.push(["/officiating", "我的执裁"]);
  if (navContext.canManageTournaments) links.push(["/management", "赛事管理"]);
  if (navContext.signedIn) links.push(["/settings", "设置"]);
  return links;
}

export function AppNav({ navContext }: { navContext: NavContext }) {
  const pathname = usePathname();
  if (isPublicPreviewPath(pathname)) {
    return <PublicPreviewNav pathname={pathname} />;
  }

  return (
    <AuthenticatedAppNav
      compact={pathname.startsWith("/officiating/")}
      navContext={navContext}
      pathname={pathname}
    />
  );
}

function PublicPreviewNav({ pathname }: { pathname: string }) {
  const scheduleHref = "/public/preview/autumn-campus-2026/schedule";

  return (
    <header className="topbar topbar-preview">
      <Link className="brand" href={scheduleHref}>
        羽赛台
      </Link>
      <div className="preview-nav-area">
        <span className="preview-nav-scroll-hint">导航可横向滚动</span>
        <nav aria-label="公开赛程导航">
          <Link aria-current={pathname.endsWith("/schedule") ? "page" : undefined} href={scheduleHref}>
            每日赛程
          </Link>
          <span aria-disabled="true">对阵与晋级 · 暂未开放</span>
          <span aria-disabled="true">小组排名 · 暂未开放</span>
          <span aria-disabled="true">最终名次 · 暂未开放</span>
          <span aria-disabled="true">成绩册 · 暂未开放</span>
        </nav>
      </div>
      <div className="preview-nav-label">模拟数据 · 界面预览</div>
    </header>
  );
}

function AuthenticatedAppNav({
  compact,
  navContext,
  pathname,
}: {
  compact: boolean;
  navContext: NavContext;
  pathname: string;
}) {
  const router = useRouter();

  async function signOut() {
    await authClient.signOut();
    router.push("/");
    router.refresh();
  }

  return (
    <header className={`topbar ${compact ? "topbar-workbench" : ""}`}>
      <div className="brand-lockup">
        <Link className="brand" href="/">羽赛台</Link>
        {compact ? <span>裁判工作台</span> : null}
      </div>
      <nav aria-label="主导航">
        {compact ? (
          <Link aria-current="page" href="/officiating">返回我的执裁</Link>
        ) : linksFor(navContext).map(([href, label]) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link aria-current={active ? "page" : undefined} href={href} key={href}>
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="session-slot">
        {navContext.signedIn ? (
          <>
            <span>{navContext.userName}</span>
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

export function AppFooter() {
  const pathname = usePathname();
  return (
    <footer className="site-footer">
      {isPublicPreviewPath(pathname)
        ? "模拟数据 · 界面预览 · 未接入正式公开接口"
        : "公开赛程与成绩以赛事组织方正式公告为准"}
    </footer>
  );
}

function isPublicPreviewPath(pathname: string) {
  return pathname === "/public/preview" || pathname.startsWith("/public/preview/");
}
