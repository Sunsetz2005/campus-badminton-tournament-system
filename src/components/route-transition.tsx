"use client";

import { usePathname } from "next/navigation";
import { ViewTransition, type ReactNode } from "react";

/**
 * 页面切换动效。以路径为 key：只有真正换页时旧页淡出、新页上浮淡入；
 * 同一路径下的 router.refresh()（如看板每 15 秒刷新）与查询参数变化不触发动画。
 * 浏览器不支持 View Transitions 或用户要求减少动态效果时，内容直接切换。
 */
export function RouteTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <ViewTransition default="none" enter="route-in" exit="route-out" key={pathname}>
      <div className="route-view">{children}</div>
    </ViewTransition>
  );
}
