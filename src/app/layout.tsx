import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AppNav } from "@/components/app-nav";

import "./globals.css";

export const metadata: Metadata = {
  title: "校园羽毛球赛事管理系统",
  description: "校园羽毛球赛事编排、权限与裁判管理系统",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <AppNav />
        <main className="page-shell">{children}</main>
        <footer>阶段 1 工程骨架 · 本机与局域网开发演示</footer>
      </body>
    </html>
  );
}
