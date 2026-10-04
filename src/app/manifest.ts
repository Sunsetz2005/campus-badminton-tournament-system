import type { MetadataRoute } from "next";

/**
 * 阶段 8 渐进增强：只提供应用清单与图标，方便「添加到主屏幕」。
 * 刻意不注册 Service Worker——比分、执裁命令与登录状态都不能进入陈旧缓存，
 * 也不能在执裁中被后台更新无提示替换页面。离线不是本版本能力。
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "赛事台｜赛事编排与成绩管理",
    short_name: "赛事台",
    description: "公开赛程、比分与裁判执裁；当前支持羽毛球赛事",
    lang: "zh-CN",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f5f7f6",
    theme_color: "#1b1040",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
