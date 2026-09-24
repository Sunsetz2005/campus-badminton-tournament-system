import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { isPublicUiPreviewEnabled } from "@/features/public-results/access";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "公开赛程界面预览｜羽赛台",
  description: "校园羽毛球公开赛程与比赛详情的隔离界面预览",
  robots: { follow: false, index: false },
};

export default function PublicPreviewLayout({ children }: Readonly<{ children: ReactNode }>) {
  if (!isPublicUiPreviewEnabled()) notFound();
  return children;
}
