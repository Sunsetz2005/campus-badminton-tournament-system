import Link from "next/link";

export default function Forbidden() {
  return (
    <section className="narrow-page">
      <div className="section-heading">
        <p className="eyebrow">服务端权限校验</p>
        <h1>没有访问权限</h1>
        <p>当前账号不能访问此页面，或账号已停用。</p>
      </div>
      <Link className="button secondary" href="/">返回首页</Link>
    </section>
  );
}
