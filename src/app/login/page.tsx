import { Suspense } from "react";

import { LoginForm } from "@/components/login-form";

export default function LoginPage() {
  return (
    <section className="narrow-page">
      <div className="section-heading">
        <p className="eyebrow">真实数据库会话</p>
        <h1>登录本地演示环境</h1>
        <p>不提供公开注册。示例身份只能通过受保护的本地种子命令创建。</p>
      </div>
      <Suspense fallback={<p>加载登录表单…</p>}>
        <LoginForm />
      </Suspense>
    </section>
  );
}
