import type { MatchState, Side } from "@/domain/rules/match-engine";
import { buildCourtViewModel } from "@/ui/court-view-model";

interface CourtConsoleProps {
  state: MatchState;
  flipped: boolean;
  draft?: boolean;
  canWrite: boolean;
  busy: boolean;
  sideName: (side: Side) => string;
  playerName: (playerId: string | null) => string;
  onAddPoint: (side: Side) => void;
  onSubtractPoint: (side: Side) => void;
  onCorrectPosition: (side: Side) => void;
  onChangeEnds: () => void;
}

function ShuttleIcon() {
  return (
    <svg aria-hidden="true" className="shuttle-icon" viewBox="0 0 28 28">
      <path d="M8.1 4.4 20 15.8M12.2 2.8l10.2 10.4M5.9 8.3l10.8 10.2" />
      <path d="m18.2 15.2 4.1-2.4 2.4 4.1-2.4 4.1-4.7.2-2.3-4Z" />
      <path d="M16.8 20.5c-3.5 2.1-6.4 3.1-8.7 3.1-1.9 0-3.3-.7-4.1-2.2" />
    </svg>
  );
}

export function CourtConsole({
  state,
  flipped,
  draft = false,
  canWrite,
  busy,
  sideName,
  playerName,
  onAddPoint,
  onSubtractPoint,
  onCorrectPosition,
  onChangeEnds,
}: CourtConsoleProps) {
  const view = buildCourtViewModel(state, flipped);
  const activePlay = ["IN_PROGRESS", "OBLIGATIONS_PENDING", "PAUSED"].includes(state.phase);
  const scoringAllowed = !draft && state.phase === "IN_PROGRESS";
  const positionCorrectionAllowed = !draft && activePlay;
  const endsCorrectionAllowed = !draft && [
    "IN_PROGRESS",
    "OBLIGATIONS_PENDING",
    "PAUSED",
    "GAME_COMPLETE",
    "AWAITING_NEXT_GAME_SETUP",
  ].includes(state.phase);
  const changeEndsPending = state.pendingObligations.some((item) => item.type === "CHANGE_ENDS");
  const interactionExplanation = busy
    ? "服务器正在处理或确认上一项操作，全部场地操作暂时锁定。"
    : draft
      ? "当前为开局设置草稿，确认首发与首接前不能计分或更正。"
      : canWrite
        ? "本机具有写入控制；所有操作仍需等待服务器确认后更新。"
        : "当前设备只读，没有有效写入控制。";

  return (
    <section aria-busy={busy} aria-describedby="court-interaction-status" aria-label="权威比赛场地与比分" className="court-console">
      <div className="court-heading">
        <div>
          <span className="eyebrow">第 {state.currentGame} 局 · 下一次发球前的规则位置</span>
          <h2>场地与发接发</h2>
        </div>
        <span className={`court-truth ${draft ? "draft" : ""}`}>
          {draft ? "开局设置草稿" : view.physicalEndsConfirmed ? "服务器权威状态" : "场地端待确认"}
        </span>
      </div>

      <div className="badminton-court" data-flipped={String(flipped)} data-testid="badminton-court">
        {view.halves.map((half) => (
          <section
            aria-label={`${half.physicalEnd}，${half.side} 方，${sideName(half.side)}`}
            className={`court-visual-half court-visual-${half.screenHalf.toLowerCase()} side-${half.side.toLowerCase()}`}
            data-physical-end={half.physicalEnd}
            data-side={half.side}
            key={half.screenHalf}
          >
            <header className="court-half-heading">
              <strong>{sideName(half.side)}</strong>
              <span>{half.side} 方 · {half.physicalEnd.replace("END_", "场地端 ")}</span>
            </header>
            <div className="court-service-grid">
              {half.cells.map((cell) => {
                const accessibleRole = cell.role === "SERVER" ? "，当前发球员" : cell.role === "RECEIVER" ? "，当前接发员" : "";
                const draftRole = draft && cell.playerId === state.serverPlayerId
                  ? "DRAFT_SERVER"
                  : draft && cell.playerId === state.receiverPlayerId
                    ? "DRAFT_RECEIVER"
                    : null;
                const displayedRole = cell.role ?? draftRole;
                return (
                  <div
                    aria-label={`${cell.logicalCourt === "R" ? "右" : "左"}发球区，${cell.playerId ? playerName(cell.playerId) : "空区"}${accessibleRole}${draftRole === "DRAFT_SERVER" ? "，拟首发" : draftRole === "DRAFT_RECEIVER" ? "，拟首接" : ""}`}
                    className={`court-cell court-cell-${cell.screenRow.toLowerCase()} ${displayedRole ? `is-${displayedRole.toLowerCase()}` : ""}`}
                    data-logical-court={cell.logicalCourt}
                    data-player-id={cell.playerId ?? ""}
                    data-role={cell.role ?? ""}
                    data-setup-role={draftRole ?? ""}
                    data-screen-half={cell.screenHalf}
                    data-screen-row={cell.screenRow}
                    key={`${cell.screenHalf}-${cell.screenRow}`}
                  >
                    <span className="court-cell-label">{cell.logicalCourt} · {cell.logicalCourt === "R" ? "右发球区" : "左发球区"}</span>
                    {cell.playerId ? (
                      <div className="player-position-card">
                        <span className="player-side-mark">{cell.side} 方</span>
                        <strong>{playerName(cell.playerId)}</strong>
                        {displayedRole ? (
                          <span className={`player-role role-${displayedRole.toLowerCase()}`}>
                            {displayedRole === "SERVER" ? <ShuttleIcon /> : null}
                            {displayedRole === "SERVER"
                              ? "发球"
                              : displayedRole === "RECEIVER"
                                ? "接发"
                                : displayedRole === "DRAFT_SERVER"
                                  ? "拟首发"
                                  : "拟首接"}
                          </span>
                        ) : null}
                      </div>
                    ) : <span className="empty-court-cell">空发球区</span>}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
        <div aria-hidden="true" className="court-net"><span>球网</span></div>
      </div>

      <p className="court-caption">
        四格表示规则发球区和下一次发接发顺序，不追踪回合中的实际跑位。
      </p>
      <p className="court-interaction-status" id="court-interaction-status">{interactionExplanation}</p>

      <div className="court-position-actions">
        <button className="court-action-button" disabled={!canWrite || busy || !positionCorrectionAllowed} onClick={() => onCorrectPosition(view.halves[0].side)} type="button">
          {state.format === "DOUBLES" ? `更正 ${view.halves[0].side} 方换位` : "核对单打站位"}
        </button>
        <button className={`court-action-button ends ${changeEndsPending ? "attention" : ""}`} disabled={!canWrite || busy || !endsCorrectionAllowed} onClick={onChangeEnds} type="button">
          {changeEndsPending ? "确认 / 核对换边" : "更正场地端"}
        </button>
        <button className="court-action-button" disabled={!canWrite || busy || !positionCorrectionAllowed} onClick={() => onCorrectPosition(view.halves[1].side)} type="button">
          {state.format === "DOUBLES" ? `更正 ${view.halves[1].side} 方换位` : "核对单打站位"}
        </button>
      </div>

      <div className="court-score-console" aria-label="比分与逐分操作">
        {view.halves.map((half) => (
          <section className={`court-score-side side-${half.side.toLowerCase()}`} data-score-side={half.side} key={half.screenHalf}>
            <div className="score-side-identity">
              <span>{half.side} 方</span>
              <strong>{sideName(half.side)}</strong>
            </div>
            <div className="score-stepper">
              <button
                aria-label={`更正 ${sideName(half.side)} 的最近得分`}
                className="score-adjust minus"
                disabled={!canWrite || busy || !activePlay || draft || state.score[half.side] === 0}
                onClick={() => onSubtractPoint(half.side)}
                type="button"
              >
                <span aria-hidden="true">−</span><small>更正</small>
              </button>
              <strong aria-label={`${sideName(half.side)} 当前 ${state.score[half.side]} 分`} className="court-score-number">
                {state.score[half.side]}
              </strong>
              <button
                aria-label={`${sideName(half.side)} 赢得一分`}
                className="score-adjust plus"
                disabled={!canWrite || busy || !scoringAllowed}
                onClick={() => onAddPoint(half.side)}
                type="button"
              >
                <span aria-hidden="true">+1</span><small>得分</small>
              </button>
            </div>
          </section>
        ))}
      </div>
      <p aria-atomic="true" aria-live="polite" className="visually-hidden">
        当前比分，{sideName("A")} {state.score.A} 分，{sideName("B")} {state.score.B} 分。
      </p>
    </section>
  );
}
