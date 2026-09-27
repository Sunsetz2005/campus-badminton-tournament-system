import { Suspense } from "react";

import { LoginForm } from "@/components/login-form";

export default function LoginPage() {
  return (
    <section className="narrow-page login-page">
      <div className="section-heading">
        <p className="eyebrow">工作人员登录</p>
        <h1>登录羽赛台</h1>
        <p>管理员、裁判与学院领队使用赛事方分配的账号登录。本平台不开放公开注册；忘记口令请联系赛事管理员重置。</p>
      </div>
      <Suspense fallback={<p>加载登录表单…</p>}>
        <LoginForm />
      </Suspense>
    </section>
  );
}
