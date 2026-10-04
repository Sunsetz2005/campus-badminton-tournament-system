import { notFound } from "next/navigation";

import styles from "@/features/public-results/results-view.module.css";
import { AppError } from "@/server/services/errors";
import { listPublicReportFiles, type PublicReportKey } from "@/server/services/public-report-service";

export const dynamic = "force-dynamic";

const FILES: Record<PublicReportKey, { title: string; description: string; format: string }> = {
  booklet: {
    title: "成绩册（PDF）",
    description: "A4 版式：封面与赛事信息、规程摘要、公开参赛名单、分组、对阵、赛程、逐场结果、名次与特殊结果说明。",
    format: "PDF",
  },
  data: {
    title: "赛事数据表（Excel）",
    description: "同一份数据的表格版：参赛名单、分组、对阵、赛程、逐场成绩、名次与特殊结果，便于筛选与统计。",
    format: "Excel（.xlsx）",
  },
};

function sizeText(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${Math.max(1, Math.round(bytes / 1024))} KiB`;
}

/** 公开下载：只提供当前正式版（只含经裁判长复核锁定的结果）；草稿与内部名单不公开。 */
export default async function PublicDownloadsPage({ params }: { params: Promise<{ tournamentSlug: string }> }) {
  const { tournamentSlug } = await params;
  let files;
  try {
    files = await listPublicReportFiles(tournamentSlug);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    throw error;
  }
  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <p className={styles.kicker}>RESULTS BOOK</p>
        <h1>成绩册</h1>
        <p>这里只提供赛事组织方生成的正式版文件，内容只含经裁判长复核锁定的结果；结果更正后会发布新版本，旧版本不再在此提供。</p>
      </header>
      {files.length ? (
        <div className={styles.files}>
          {files.map((file) => {
            const info = FILES[file.key];
            return (
              <article aria-labelledby={`file-${file.key}`} className={styles.file} key={file.key}>
                <h2 id={`file-${file.key}`}>{info.title}</h2>
                <p>{info.description}</p>
                <dl>
                  <dt>版本</dt>
                  <dd>正式版 · 第 {file.version} 版</dd>
                  <dt>数据修订号</dt>
                  <dd>{file.dataRevision}</dd>
                  <dt>格式与大小</dt>
                  <dd>
                    {info.format} · {sizeText(file.byteSize)}
                  </dd>
                  <dt>SHA-256</dt>
                  <dd title={file.sha256}>{file.sha256.slice(0, 16)}…</dd>
                </dl>
                <a className="button" download href={`/api/public/tournaments/${tournamentSlug}/reports/${file.key}`}>
                  下载{info.title.replace(/（.*）/, "")}
                </a>
              </article>
            );
          })}
        </div>
      ) : (
        <p className={styles.empty}>赛事组织方尚未发布正式版成绩册。比赛期间可以先看「对阵与名次」和「每日赛程」。</p>
      )}
    </div>
  );
}
