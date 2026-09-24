import { headers } from "next/headers";

import { requireActiveUser } from "@/server/auth/authorization";
import { getSessionFromHeaders } from "@/server/auth/session";

/** API 路由统一入口：从数据库会话重新解析当前用户，不信任请求体里的任何身份字段。 */
export async function requireRequestUser() {
  const session = await getSessionFromHeaders(await headers());
  return requireActiveUser(session);
}
