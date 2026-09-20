import Link from "next/link";

export default function PublicPreviewNotFound() {
  return (
    <section className="narrow-page">
      <div className="section-heading">
        <p className="eyebrow">界面预览</p>
        <h1>预览不可用</h1>
        <p>预览开关未开启，或赛事与比赛编号不存在。这里不会回退到真实赛事数据。</p>
      </div>
      <Link className="button secondary" href="/public">返回正式公开入口</Link>
    </section>
  );
}
