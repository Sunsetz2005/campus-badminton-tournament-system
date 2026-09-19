import { forbidden } from "next/navigation";

import type { AuthSession } from "@/server/auth/auth";
import { requireActiveUser } from "@/server/auth/authorization";
import { AppError } from "@/server/services/errors";

export async function requireActivePageUser(session: AuthSession) {
  try {
    return await requireActiveUser(session);
  } catch (error) {
    if (error instanceof AppError && error.status === 403) forbidden();
    throw error;
  }
}
