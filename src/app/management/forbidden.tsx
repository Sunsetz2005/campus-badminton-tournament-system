import Link from "next/link";

export default function ManagementForbidden() {
  return (
    <section className="narrow-page">
      <div className="section-heading">
        <p className="eyebrow">服务端赛事范围校验</p>
        <h1>没有赛事管理权限</h1>
        <p>当前账号没有任何赛事的管理员或编排员角色。</p>
      </div>
      <Link className="button secondary" href="/">返回首页</Link>
    </section>
  );
}
