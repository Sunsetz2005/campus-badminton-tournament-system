import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { AppFooter, AppNav } from "@/components/app-nav";
import { RouteTransition } from "@/components/route-transition";
import { getNavContext } from "@/server/auth/nav-context";

import "./globals.css";

export const metadata: Metadata = {
  title: "赛事台｜赛事编排与成绩管理",
  description: "赛事编排、公开赛程、逐局比分、已确认结果与裁判执裁管理；当前支持羽毛球赛事",
  appleWebApp: { title: "赛事台", statusBarStyle: "default" },
};

// 不设 maximumScale / userScalable：浏览器缩放必须保留给低视力用户。
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#1b1040",
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  // 会话在服务端解析，导航因此不会先渲染成登录态再闪回。
  const navContext = await getNavContext();

  return (
    <html data-scroll-behavior="smooth" lang="zh-CN">
      <body>
        <a className="skip-link" href="#main-content">跳到主要内容</a>
        <AppNav navContext={navContext} />
        <main className="page-shell" id="main-content" tabIndex={-1}>
          <RouteTransition>{children}</RouteTransition>
        </main>
        <AppFooter />
      </body>
    </html>
  );
}
