import Link from "next/link";

/**
 * 公开端统一 404。
 *
 * 赛事不存在、赛事仍是草稿、比赛编号不存在、比赛尚未进入逐场发布边界，
 * 以及比赛不属于该赛事，全部收敛到同一个页面和同一段文案——区分文案会泄露
 * 「这个赛事/比赛确实存在但你看不到」，正是公开端不该暴露的信息。
 */
export default function PublicNotFound() {
  return (
    <section className="narrow-page">
      <div className="section-heading">
        <p className="eyebrow">公开内容不存在</p>
        <h1>赛事或比赛不存在，或尚未公开</h1>
        <p>该地址无效，或相关内容尚未发布。页面没有读取草稿赛事、其他赛事或受保护数据。</p>
      </div>
      <Link className="button secondary" href="/">返回全部赛事</Link>
    </section>
  );
}
