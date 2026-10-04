"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * 阶段 8：执裁时尽量保持屏幕常亮（Screen Wake Lock API）。
 *
 * 这是渐进增强：它只需要安全上下文（HTTPS 或 localhost），手机经局域网明文 HTTP 访问时
 * 浏览器不提供；系统低电量模式、切到后台也会让浏览器自动释放。任何不可用的情况都只给出
 * 人工替代提示，绝不影响记分本身。
 */
export type WakeLockStatus = "INACTIVE" | "ACTIVE" | "UNSUPPORTED" | "INSECURE_CONTEXT" | "DENIED";

interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
}

interface WakeLockNavigator {
  wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> };
}

export function wakeLockAvailability(env: { isSecureContext: boolean; hasWakeLock: boolean }): WakeLockStatus | null {
  if (!env.isSecureContext) return "INSECURE_CONTEXT";
  if (!env.hasWakeLock) return "UNSUPPORTED";
  return null;
}

export function describeWakeLock(status: WakeLockStatus): { label: string; hint: string | null } {
  switch (status) {
    case "ACTIVE":
      return { label: "已开启", hint: null };
    case "INACTIVE":
      return { label: "未开启", hint: null };
    case "INSECURE_CONTEXT":
      return {
        label: "不可用",
        hint: "当前不是 HTTPS 访问，浏览器不提供屏幕常亮。执裁期间请在手机设置里把「自动锁定」暂时改为「永不」，赛后改回。",
      };
    case "UNSUPPORTED":
      return {
        label: "不可用",
        hint: "此浏览器不支持屏幕常亮。执裁期间请在手机设置里把「自动锁定」暂时改为「永不」，赛后改回。",
      };
    case "DENIED":
      return {
        label: "被系统拒绝",
        hint: "系统拒绝了屏幕常亮（常见于低电量模式）。请接上电源或在设置里暂时关闭自动锁屏。",
      };
  }
}

const noopSubscribe = () => () => undefined;

function clientAvailability(): WakeLockStatus | null {
  const nav = navigator as Navigator & WakeLockNavigator;
  return wakeLockAvailability({
    isSecureContext: window.isSecureContext,
    hasWakeLock: typeof nav.wakeLock?.request === "function",
  });
}

/** `active` 为真时（本机持有控制权）申请常亮；回到前台时自动重新申请。 */
export function useScreenWakeLock(active: boolean): WakeLockStatus {
  const [acquired, setAcquired] = useState<"ACTIVE" | "INACTIVE" | "DENIED">("INACTIVE");
  // 能力在浏览器里判定一次；服务端渲染时视为未知（先显示未开启）。
  const unavailable = useSyncExternalStore(noopSubscribe, clientAvailability, () => null);

  useEffect(() => {
    if (!active || unavailable) return undefined;
    const nav = navigator as Navigator & WakeLockNavigator;
    let sentinel: WakeLockSentinelLike | null = null;
    let disposed = false;
    const acquire = async () => {
      if (document.visibilityState !== "visible" || (sentinel && !sentinel.released)) return;
      try {
        const next = await nav.wakeLock!.request("screen");
        if (disposed) {
          void next.release().catch(() => undefined);
          return;
        }
        sentinel = next;
        setAcquired("ACTIVE");
        next.addEventListener("release", () => {
          if (!disposed) setAcquired("INACTIVE");
        });
      } catch {
        if (!disposed) setAcquired("DENIED");
      }
    };
    const onVisibility = () => void acquire();
    void acquire();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (sentinel && !sentinel.released) void sentinel.release().catch(() => undefined);
    };
  }, [active, unavailable]);

  if (!active) return "INACTIVE";
  return unavailable ?? acquired;
}
