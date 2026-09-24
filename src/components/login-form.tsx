"use client";

import { FormEvent, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { authClient } from "@/lib/auth-client";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage("");
    const result = await authClient.signIn.email({ email, password, rememberMe: false });
    if (result.error) {
      setMessage("登录失败，请检查账号、密码或账号状态。");
      setPending(false);
      return;
    }
    const nextPath = searchParams.get("next");
    router.push(nextPath?.startsWith("/") ? nextPath : "/");
    router.refresh();
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <label>
        登录邮箱
        <input autoComplete="username" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} />
      </label>
      <label>
        密码
        <input
          autoComplete="current-password"
          onChange={(event) => setPassword(event.target.value)}
          required
          type="password"
          value={password}
        />
      </label>
      <button className="button" disabled={pending} type="submit">
        {pending ? "正在验证…" : "登录"}
      </button>
      {message ? <p className="form-error" role="alert">{message}</p> : null}
    </form>
  );
}
