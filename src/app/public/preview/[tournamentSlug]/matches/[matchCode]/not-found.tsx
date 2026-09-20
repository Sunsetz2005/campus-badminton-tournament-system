import Link from "next/link";

import { PUBLIC_PREVIEW_TOURNAMENT } from "@/features/public-preview/fixtures";

export default function PreviewMatchNotFound() {
  return (
    <section className="narrow-page">
      <div className="section-heading">
        <p className="eyebrow">比赛详情不存在</p>
        <h1>找不到这场模拟比赛</h1>
        <p>比赛编号不存在或不属于当前模拟赛事。页面没有尝试读取其他赛事或受保护数据。</p>
      </div>
      <Link className="button secondary" href={`/public/preview/${PUBLIC_PREVIEW_TOURNAMENT.slug}/schedule`}>
        返回模拟赛程
      </Link>
    </section>
  );
}
