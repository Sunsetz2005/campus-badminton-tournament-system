import { getPublicTournament } from "@/server/services/public-tournament-service";
import { StatusBadge } from "@/ui/status-badge";

export const dynamic = "force-dynamic";

export default async function PublicPage() {
  const tournament = await getPublicTournament("phase-1-demo");
  return (
    <section>
      <div className="section-heading">
        <p className="eyebrow">服务端公开字段白名单</p>
        <h1>{tournament.name}</h1>
        <p>本页只显示模拟公开编号、对阵、场地、时间和比赛状态，不返回账号、联系方式或审计信息。</p>
      </div>
      <div className="stack">
        {tournament.competitions.map((competition) => (
          <article className="panel" key={competition.code}>
            <div className="panel-title">
              <div><small>{competition.code}</small><h2>{competition.name}</h2></div>
              <StatusBadge>{competition.kind}</StatusBadge>
            </div>
            {competition.stages.flatMap((stage) => stage.matches).map((match) => (
              <div className="match-row" key={match.code}>
                <strong>{match.sideAEntry?.displayName ?? "待定"}</strong>
                <span>对</span>
                <strong>{match.sideBEntry?.displayName ?? "待定"}</strong>
                <span>{match.court?.name ?? "待定场地"}</span>
                <StatusBadge tone={match.lifecycleStatus === "READY" ? "ok" : "neutral"}>{match.lifecycleStatus}</StatusBadge>
              </div>
            ))}
          </article>
        ))}
      </div>
    </section>
  );
}
