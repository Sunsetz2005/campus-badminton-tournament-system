import { headers } from "next/headers";

import { auth, type AuthSession } from "@/server/auth/auth";

export async function getSessionFromHeaders(requestHeaders: Headers): Promise<AuthSession | null> {
  return auth.api.getSession({ headers: requestHeaders });
}

export async function getPageSession() {
  return getSessionFromHeaders(await headers());
}
