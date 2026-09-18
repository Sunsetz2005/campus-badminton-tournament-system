"use client";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <section className="narrow-page">
      <div className="section-heading">
        <p className="eyebrow">请求未完成</p>
        <h1>无法显示此页面</h1>
        <p>可能是权限不足或服务暂时不可用。系统没有把失败操作显示为成功。</p>
      </div>
      <button className="button" onClick={reset} type="button">重试</button>
    </section>
  );
}
