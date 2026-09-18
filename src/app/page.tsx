import Link from "next/link";

import { StatusBadge } from "@/ui/status-badge";

const modules = [
  { title: "赛事管理", text: "赛事、项目和规则快照的阶段 1 数据骨架。", href: "/management", state: "需管理员登录" },
  { title: "我的执裁", text: "只展示本人真实指派；完整记分在后续阶段开发。", href: "/officiating", state: "需裁判登录" },
  { title: "公开查询", text: "只读取服务端公开白名单，不返回账号和审计字段。", href: "/public", state: "公开只读" },
];

export default function HomePage() {
  return (
    <>
      <section className="hero">
        <div>
          <StatusBadge tone="ok">阶段 1 · 工程骨架</StatusBadge>
          <h1>把赛事数据、身份和权限先落稳</h1>
          <p>
            当前版本已经接入 PostgreSQL、真实登录和服务端权限校验。计分规则引擎、完整编排和裁判工作台仍未实现。
          </p>
          <div className="actions">
            <Link className="button" href="/login">本地测试登录</Link>
            <Link className="button secondary" href="/public">查看模拟公开赛事</Link>
          </div>
        </div>
        <aside className="phase-card">
          <span>当前边界</span>
          <strong>可启动、可登录、可验证权限</strong>
          <p>不会把页面骨架称为已完成赛事系统。</p>
        </aside>
      </section>
      <section>
        <div className="section-heading">
          <h2>阶段 1 入口</h2>
          <p>所有入口都明确显示当前实现状态。</p>
        </div>
        <div className="card-grid">
          {modules.map((module) => (
            <article className="card" key={module.href}>
              <StatusBadge>{module.state}</StatusBadge>
              <h3>{module.title}</h3>
              <p>{module.text}</p>
              <Link href={module.href}>进入查看 →</Link>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
