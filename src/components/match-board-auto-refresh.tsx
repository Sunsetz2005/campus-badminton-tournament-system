"use client";

import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";

export function MatchBoardAutoRefresh({ serverRefreshedAt }: { serverRefreshedAt: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function refresh() {
    startTransition(() => router.refresh());
  }

  useEffect(() => {
    const timer = window.setInterval(refresh, 15_000);
    return () => window.clearInterval(timer);
  });

  return (
    <div className="board-refresh" role="status">
      <span>每 15 秒自动刷新 · 服务端快照 {new Date(serverRefreshedAt).toLocaleTimeString("zh-CN", { hour12: false })}</span>
      <button className="button secondary small" disabled={isPending} onClick={refresh} type="button">
        {isPending ? "刷新中…" : "立即刷新"}
      </button>
    </div>
  );
}
