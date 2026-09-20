"use client";

import { useEffect } from "react";

import { ActionButton } from "@/components/ui/action-button";
import { ResourceState } from "@/components/ui/resource-state";

export default function PublicPreviewError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error("public-preview-render-failed", error);
  }, [error]);

  return (
    <ResourceState
      action={<ActionButton onClick={retry}>重试界面预览</ActionButton>}
      description="界面预览发生了未预期错误。该错误不会被显示成空赛程。"
      eyebrow="预览渲染失败"
      title="无法显示当前页面"
      tone="error"
    />
  );
}
