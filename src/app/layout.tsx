import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AppFooter, AppNav } from "@/components/app-nav";
import { getNavContext } from "@/server/auth/nav-context";

import "./globals.css";

export const metadata: Metadata = {
  title: "羽赛台｜校园羽毛球赛事编排与成绩管理",
  description: "校园羽毛球赛事的公开赛程、逐局比分、已确认结果与裁判执裁管理",
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  // 会话在服务端解析，导航因此不会先渲染成登录态再闪回。
  const navContext = await getNavContext();

  return (
    <html lang="zh-CN">
      <body>
        <a className="skip-link" href="#main-content">跳到主要内容</a>
        <AppNav navContext={navContext} />
        <main className="page-shell" id="main-content" tabIndex={-1}>{children}</main>
        <AppFooter />
      </body>
    </html>
  );
}
