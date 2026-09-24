import { redirect } from "next/navigation";

/**
 * 原「公开查询」页固定读取单一演示赛事，已由首页赛事列表和
 * `/public/[tournamentSlug]/schedule` 取代。这里只保留旧链接的重定向。
 */
export default function LegacyPublicRedirect() {
  redirect("/");
}
