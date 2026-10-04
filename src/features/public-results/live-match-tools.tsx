"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, useTransition } from "react";

import styles from "./public-results.module.css";

/** 实时比分页的刷新间隔：固定、轻量；页面在后台时暂停，回到前台立即补一次。 */
export const LIVE_REFRESH_MS = 10_000;

function subscribeOnline(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

function formatClock(ms: number) {
  return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
}

/**
 * 只在比赛尚未正式确认、且已开始或即将开始时自动刷新；已确认的比赛不再轮询。
 * 刷新走同一个服务端页面，比分版本与服务端一致；刷新失败时页面保留最后一次成功的内容。
 * 阶段 8：同时显示本页最后一次刷新完成的时间；断网时明确说「显示的是某时刻的数据」，
 * 不让读者把停住的比分当成实时比分。
 */
export function LiveMatchRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);

  // 首次挂载与每次刷新完成（pending 变回假）后，在下一帧记下完成时间。
  useEffect(() => {
    if (pending) return undefined;
    const frame = window.requestAnimationFrame(() => setRefreshedAt(Date.now()));
    return () => window.cancelAnimationFrame(frame);
  }, [pending]);

  useEffect(() => {
    if (!active) return undefined;
    let timer = 0;
    const tick = () => startTransition(() => router.refresh());
    const start = () => {
      window.clearInterval(timer);
      timer = window.setInterval(tick, LIVE_REFRESH_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        tick();
        start();
      } else {
        window.clearInterval(timer);
      }
    };
    start();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", tick);
    };
  }, [active, router]);

  if (!active) return <span>比分已确认，不再自动刷新</span>;
  if (!online) {
    return (
      <span data-freshness="offline" role="status">
        网络已断开 · 显示的是{refreshedAt ? ` ${formatClock(refreshedAt)} ` : "打开页面时"}的数据，恢复后自动更新
      </span>
    );
  }
  return (
    <span aria-live="off" data-freshness="online">
      {pending ? "正在更新…" : `每 ${LIVE_REFRESH_MS / 1000} 秒自动更新`}
      {refreshedAt && !pending ? ` · 页面更新于 ${formatClock(refreshedAt)}` : ""}
    </span>
  );
}

/** 只读分享链接：就是本页的公开地址，不含登录状态、控制令牌或任何裁判写入凭据。 */
const noopSubscribe = () => () => undefined;

export function ShareMatchLink({ path }: { path: string }) {
  // 服务端渲染时只有路径；水合后补上当前站点的来源。
  const origin = useSyncExternalStore(noopSubscribe, () => window.location.origin, () => "");
  const url = `${origin}${path}`;
  const [copied, setCopied] = useState<"idle" | "ok" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied("ok");
    } catch {
      setCopied("failed");
    }
  }

  return (
    <div className={styles.shareBox}>
      <label>
        <span>只读链接</span>
        <input onFocus={(event) => event.currentTarget.select()} readOnly type="url" value={url} />
      </label>
      <button onClick={copy} type="button">
        复制链接
      </button>
      <p role="status">
        {copied === "ok" ? "已复制。" : copied === "failed" ? "浏览器不允许自动复制，请手动选中上面的链接复制。" : "任何人打开都只能查看，不能记分或修改。"}
      </p>
    </div>
  );
}
