import Link from "next/link";

export default function PublicTournamentNotFound() {
  return (
    <section className="narrow-page">
      <div className="section-heading">
        <p className="eyebrow">公开查询</p>
        <h1>暂无已发布赛事</h1>
        <p>模拟赛事不存在或尚未发布，页面没有暴露草稿数据。</p>
      </div>
      <Link className="button secondary" href="/">返回首页</Link>
    </section>
  );
}
