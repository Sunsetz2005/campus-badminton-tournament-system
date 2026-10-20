"use client";

import { useEffect } from "react";

const KEY = "officiating:return-path";

/** 记住本机最近查看的赛事比赛列表（含查看方式与筛选），裁判工作台的「返回我的执裁」回到这里。 */
export function RememberOfficiatingList() {
  useEffect(() => {
    try {
      window.sessionStorage.setItem(KEY, `${window.location.pathname}${window.location.search}`);
    } catch {
      // 隐私模式等禁用存储时，返回入口页即可。
    }
  });
  return null;
}

export function officiatingReturnPath() {
  try {
    const value = window.sessionStorage.getItem(KEY);
    return value?.startsWith("/officiating/tournament/") ? value : null;
  } catch {
    return null;
  }
}
