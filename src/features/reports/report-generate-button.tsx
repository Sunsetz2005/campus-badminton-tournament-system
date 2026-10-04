"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ActionButton } from "@/components/ui/action-button";
import { sendJson } from "@/features/management/api-client";
import styles from "@/features/management/management.module.css";

interface Created {
  id: string;
  version: number;
  displayName: string;
  supersededVersion: number | null;
}

/**
 * 生成并存档一份导出文件。只有服务端确认存档后才显示成功与下载链接；
 * 失败时原样显示服务端的中文原因（例如榜单需重新发布、数据未变化、文件过大）。
 */
export function ReportGenerateButton({
  slug,
  kind,
  edition,
  label,
  variant = "primary",
}: {
  slug: string;
  kind: "REGISTRATIONS_INTERNAL" | "DATA_WORKBOOK" | "BOOKLET_PDF";
  edition: "DRAFT" | "OFFICIAL" | null;
  label: string;
  variant?: "primary" | "secondary";
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  async function generate() {
    setPending(true);
    setError(null);
    setCreated(null);
    const result = await sendJson<Created>(`/api/admin/tournaments/${slug}/reports`, "POST", { kind, edition });
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setCreated(result.data);
    router.refresh();
  }

  return (
    <div className={styles.form}>
      <div className={styles.actions}>
        <ActionButton loading={pending} loadingLabel="正在生成…" onClick={generate} variant={variant}>
          {label}
        </ActionButton>
      </div>
      {error ? (
        <p className={styles.alert} role="alert">
          {error}
        </p>
      ) : null}
      {created ? (
        <p className={styles.success} role="status">
          已生成第 {created.version} 版
          {created.supersededVersion ? `，第 ${created.supersededVersion} 版正式版已标记为「已被替代」（原文件保留）` : ""}。{" "}
          <a download href={`/api/admin/tournaments/${slug}/reports/${created.id}`}>
            下载 {created.displayName}
          </a>
        </p>
      ) : null}
    </div>
  );
}
