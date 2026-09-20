import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AppFooter, AppNav } from "@/components/app-nav";

import "./globals.css";

export const metadata: Metadata = {
  title: "校园羽毛球赛事管理系统",
  description: "校园羽毛球赛事编排、权限与裁判管理系统",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <a className="skip-link" href="#main-content">跳到主要内容</a>
        <AppNav />
        <main className="page-shell" id="main-content" tabIndex={-1}>{children}</main>
        <AppFooter />
      </body>
    </html>
  );
}
