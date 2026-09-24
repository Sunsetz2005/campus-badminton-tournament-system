import type { RegistrationSource, RegistrationStatus } from "@/generated/prisma/enums";
import type { StatusTone } from "@/ui/status-badge";

export const registrationStatusLabel: Record<RegistrationStatus, string> = {
  PENDING: "待审核",
  APPROVED: "已通过",
  REJECTED: "已驳回",
  WITHDRAWN: "已撤回",
};

export const registrationStatusTone: Record<RegistrationStatus, StatusTone> = {
  PENDING: "warn",
  APPROVED: "ok",
  REJECTED: "danger",
  WITHDRAWN: "neutral",
};

export const registrationSourceLabel: Record<RegistrationSource, string> = {
  MANUAL: "后台录入",
  IMPORT: "批量导入",
  INVITE: "邀请链接",
};

export const tournamentStatusLabel = { DRAFT: "草稿（未公开）", PUBLISHED: "已发布", ARCHIVED: "已归档" } as const;

export const entryTypeLabel = { SINGLES: "单打", DOUBLES: "双打" } as const;
