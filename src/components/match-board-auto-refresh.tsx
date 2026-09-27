"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

const REFRESH_MS = 15_000;

/**
 * 看板自动刷新。页面在后台标签页时暂停，回到前台立即补一次；
 * 快照时间不放进实时播报区，避免读屏每 15 秒被打断，只在手动刷新完成时播报一次。
 */
export function MatchBoardAutoRefresh({ serverRefreshedAt }: { serverRefreshedAt: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [announcement, setAnnouncement] = useState("");
  const manual = useRef(false);

  function refresh(byUser = false) {
    manual.current = byUser;
    startTransition(() => router.refresh());
  }

  useEffect(() => {
    if (!isPending && manual.current) {
      manual.current = false;
      setAnnouncement(`已刷新，快照时间 ${formatTime(serverRefreshedAt)}`);
    }
  }, [isPending, serverRefreshedAt]);

  useEffect(() => {
    let timer = 0;
    const start = () => {
      window.clearInterval(timer);
      timer = window.setInterval(() => refresh(), REFRESH_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        refresh();
        start();
      } else {
        window.clearInterval(timer);
      }
    };
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // refresh 只依赖稳定的 router，与 startTransition 一样无需重新订阅。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="board-refresh">
      <span className="board-refresh-status">
        <span aria-hidden="true" className={`board-refresh-dot${isPending ? " is-pending" : ""}`} />
        每 15 秒自动刷新 · 快照 <time dateTime={serverRefreshedAt}>{formatTime(serverRefreshedAt)}</time>
      </span>
      <button className="board-refresh-button" disabled={isPending} onClick={() => refresh(true)} type="button">
        {isPending ? "刷新中…" : "立即刷新"}
      </button>
      <span aria-live="polite" className="visually-hidden" role="status">{announcement}</span>
    </div>
  );
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("zh-CN", { hour12: false });
}
