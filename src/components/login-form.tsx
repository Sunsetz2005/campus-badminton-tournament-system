"use client";

import { FormEvent, useId, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { authClient } from "@/lib/auth-client";
import { safeNextPath } from "@/lib/safe-next-path";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const errorId = useId();
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage("");
    const identifier = account.trim();
    // 含 @ 按邮箱登录，否则按用户名登录。
    const result = identifier.includes("@")
      ? await authClient.signIn.email({ email: identifier, password, rememberMe: false })
      : await authClient.signIn.username({ username: identifier, password, rememberMe: false });
    if (result.error) {
      setMessage(result.error.status === 429
        ? "尝试过于频繁，请等待约 10 秒后再试。"
        : "登录失败，请检查账号、密码或账号状态。");
      setPending(false);
      return;
    }
    router.push(safeNextPath(searchParams.get("next")));
    router.refresh();
  }

  const invalid = message ? true : undefined;
  const describedBy = message ? errorId : undefined;

  return (
    <form className="auth-form" onSubmit={submit}>
      <label>
        账号
        <input
          aria-describedby={describedBy}
          aria-invalid={invalid}
          autoCapitalize="none"
          autoComplete="username"
          onChange={(event) => setAccount(event.target.value)}
          placeholder="用户名或邮箱"
          required
          spellCheck={false}
          type="text"
          value={account}
        />
      </label>
      <div className="password-field">
        <label htmlFor={`${errorId}-password`}>密码</label>
        <div className="password-input">
          <input
            aria-describedby={describedBy}
            aria-invalid={invalid}
            autoComplete="current-password"
            id={`${errorId}-password`}
            onChange={(event) => setPassword(event.target.value)}
            required
            type={showPassword ? "text" : "password"}
            value={password}
          />
          <button
            aria-controls={`${errorId}-password`}
            className="password-toggle"
            onClick={() => setShowPassword((value) => !value)}
            type="button"
          >
            {showPassword ? "隐藏密码" : "显示密码"}
          </button>
        </div>
      </div>
      {message ? <p className="form-error" id={errorId} role="alert">{message}</p> : null}
      <button aria-busy={pending || undefined} className="button" disabled={pending} type="submit">
        {pending ? <><span aria-hidden="true" className="ui-button-spinner" />正在验证…</> : "登录"}
      </button>
    </form>
  );
}
