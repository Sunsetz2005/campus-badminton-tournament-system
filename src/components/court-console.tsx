import type { MatchState, Side } from "@/domain/rules/match-engine";
import { buildCourtViewModel } from "@/ui/court-view-model";
import { COURT_LENGTH, COURT_LINES, COURT_WIDTH, serviceCourtBox } from "@/ui/court-geometry";

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

/** 按 Diagram A 画正式场线；逻辑发球区只用很淡的底色分区，与正式线有视觉区别。 */
function CourtLines() {
  return (
    <svg
      aria-hidden="true"
      className="court-lines"
      preserveAspectRatio="none"
      viewBox={`0 0 ${COURT_LENGTH} ${COURT_WIDTH}`}
    >
      <rect className="court-surface" x="0" y="0" width={COURT_LENGTH} height={COURT_WIDTH} />
      {["LEFT", "RIGHT"].flatMap((half) =>
        ["TOP", "BOTTOM"].map((row) => {
          const area = serviceCourtBox(half as "LEFT" | "RIGHT", row as "TOP" | "BOTTOM");
          return (
            <rect
              className="court-service-zone"
              height={(area.heightPercent / 100) * COURT_WIDTH}
              key={`${half}-${row}`}
              width={(area.widthPercent / 100) * COURT_LENGTH}
              x={(area.leftPercent / 100) * COURT_LENGTH}
              y={(area.topPercent / 100) * COURT_WIDTH}
            />
          );
        }),
      )}
      <rect className="court-boundary" x="0" y="0" width={COURT_LENGTH} height={COURT_WIDTH} />
      {COURT_LINES.map((line) => (
        <line
          className={line.kind === "net" ? "court-net-line" : "court-line"}
          key={line.id}
          x1={line.x1}
          x2={line.x2}
          y1={line.y1}
          y2={line.y2}
        />
      ))}
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
  const doubles = state.format === "DOUBLES";

  const interactionExplanation = busy
    ? "服务器正在处理或确认上一项操作，全部场地操作暂时锁定。"
    : draft
      ? "当前为开局设置草稿，确认首发与首接前不能计分或更正。"
      : canWrite
        ? "本机具有写入控制；所有操作仍需等待服务器确认后更新。"
        : "当前设备只读，没有有效写入控制。";

  // 「谁发给谁」只来自同一份服务器确认状态；未确认首发或比赛结束时不伪造当前发球者。
  const serviceSentence = draft
    ? "首发与首接尚未确认，暂无当前发球者。"
    : activePlay && state.servingSide !== null
      ? `${playerName(state.serverPlayerId)}（${state.serverCourt === "R" ? "右" : "左"}发球区）发给 ${playerName(state.receiverPlayerId)}（${state.receiverCourt === "R" ? "右" : "左"}发球区）`
      : state.phase === "PAUSED"
        ? "比赛暂停中，恢复后再确认下一球发球。"
        : "当前没有下一球发接发。";

  return (
    <section
      aria-busy={busy}
      aria-describedby="court-interaction-status"
      aria-label="权威比赛场地与比分"
      className="court-console"
    >
      <div className="court-sides-header">
        {view.halves.map((half) => (
          <div
            className={`court-side-tag side-${half.side.toLowerCase()}`}
            data-side-tag={half.side}
            key={half.screenHalf}
          >
            <span className="court-side-mark">
              {half.side} 方 · {half.physicalEnd.replace("END_", "场地端 ")}
            </span>
            <strong>{sideName(half.side)}</strong>
          </div>
        ))}
        <span className={`court-truth ${draft ? "draft" : ""}`}>
          {draft ? "开局设置草稿" : view.physicalEndsConfirmed ? "服务器权威状态" : "场地端待确认"}
        </span>
      </div>

      <div className="badminton-court" data-flipped={String(flipped)} data-testid="badminton-court">
        <CourtLines />
        {view.halves.map((half) => (
          <section
            aria-label={`${half.physicalEnd}，${half.side} 方，${sideName(half.side)}`}
            className={`court-visual-half court-visual-${half.screenHalf.toLowerCase()} side-${half.side.toLowerCase()}`}
            data-physical-end={half.physicalEnd}
            data-side={half.side}
            key={half.screenHalf}
          >
            {half.cells.map((cell) => {
              const area = serviceCourtBox(cell.screenHalf, cell.screenRow);
              const accessibleRole = cell.role === "SERVER"
                ? "，当前发球员"
                : cell.role === "RECEIVER"
                  ? "，当前接发员"
                  : "";
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
                  data-screen-half={cell.screenHalf}
                  data-screen-row={cell.screenRow}
                  data-setup-role={draftRole ?? ""}
                  key={`${cell.screenHalf}-${cell.screenRow}`}
                  style={{
                    left: `${area.leftPercent}%`,
                    top: `${area.topPercent}%`,
                    width: `${area.widthPercent}%`,
                    height: `${area.heightPercent}%`,
                  }}
                >
                  <span className="court-cell-label">{cell.logicalCourt === "R" ? "右发球区" : "左发球区"}</span>
                  {cell.playerId ? (
                    <div className="player-position-card">
                      <strong className="player-name">{playerName(cell.playerId)}</strong>
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
                  ) : (
                    <span className="empty-court-cell">空发球区</span>
                  )}
                </div>
              );
            })}
          </section>
        ))}
        <span aria-hidden="true" className="court-net-label">球网</span>
      </div>

      <div className="court-position-actions">
        <button
          className="court-action-button"
          disabled={!canWrite || busy || !positionCorrectionAllowed}
          onClick={() => onCorrectPosition(view.displayedLeftSide)}
          type="button"
        >
          左侧换位
          <small>{sideName(view.displayedLeftSide)}</small>
        </button>
        <button
          className={`court-action-button ends ${changeEndsPending ? "attention" : ""}`}
          disabled={!canWrite || busy || !endsCorrectionAllowed}
          onClick={onChangeEnds}
          type="button"
        >
          换边
          <small>{changeEndsPending ? "规则待换边" : "记录实际交换场地"}</small>
        </button>
        <button
          className="court-action-button"
          disabled={!canWrite || busy || !positionCorrectionAllowed}
          onClick={() => onCorrectPosition(view.displayedRightSide)}
          type="button"
        >
          右侧换位
          <small>{sideName(view.displayedRightSide)}</small>
        </button>
      </div>

      <div className="court-scoreboard" aria-label="双方名称与当前大比分">
        {view.halves.map((half, index) => (
          <div className={`scoreboard-side side-${half.side.toLowerCase()}`} data-scoreboard-side={half.side} key={half.screenHalf}>
            <span className="scoreboard-team">{sideName(half.side)}</span>
            <strong
              aria-label={`${sideName(half.side)} 当前 ${state.score[half.side]} 分`}
              className="court-score-number"
            >
              {state.score[half.side]}
            </strong>
            {index === 0 ? <span aria-hidden="true" className="scoreboard-colon">:</span> : null}
          </div>
        ))}
      </div>

      <div className="court-score-console" aria-label="双方加分与更正操作">
        {view.halves.map((half) => {
          const plus = (
            <button
              aria-label={`${sideName(half.side)} 赢得一分`}
              className="score-adjust plus"
              disabled={!canWrite || busy || !scoringAllowed}
              key="plus"
              onClick={() => onAddPoint(half.side)}
              type="button"
            >
              <span aria-hidden="true">+1</span>
              <small>{half.screenHalf === "LEFT" ? "左方得分" : "右方得分"}</small>
            </button>
          );
          const minus = (
            <button
              aria-label={`更正 ${sideName(half.side)} 的最近得分`}
              className="score-adjust minus"
              disabled={!canWrite || busy || !activePlay || draft || state.score[half.side] === 0}
              key="minus"
              onClick={() => onSubtractPoint(half.side)}
              type="button"
            >
              <span aria-hidden="true">−1</span>
              <small>更正</small>
            </button>
          );
          return (
            <section
              className={`court-score-side side-${half.side.toLowerCase()} half-${half.screenHalf.toLowerCase()}`}
              data-score-side={half.side}
              key={half.screenHalf}
            >
              {half.screenHalf === "LEFT" ? [plus, minus] : [minus, plus]}
            </section>
          );
        })}
      </div>

      <p className="court-service-sentence" data-testid="court-service-sentence">
        <span>下一次发接发</span>
        <strong>{serviceSentence}</strong>
      </p>
      <p className="court-interaction-status" id="court-interaction-status">{interactionExplanation}</p>

      <details className="court-roster">
        <summary>查看全名与代表队（长姓名不截断）</summary>
        <ul>
          {view.halves.map((half) => (
            <li key={half.screenHalf}>
              <span>{half.side} 方 · {half.screenHalf === "LEFT" ? "画面左" : "画面右"}</span>
              <strong>{sideName(half.side)}</strong>
              <em>
                {state.players[half.side].map((playerId) => playerName(playerId)).join(doubles ? " / " : "")}
              </em>
            </li>
          ))}
        </ul>
      </details>

      <p className="court-caption">
        四个发球区表示规则位置和下一次发接发顺序，不追踪回合中的实际跑位。
      </p>
      <p aria-atomic="true" aria-live="polite" className="visually-hidden">
        当前比分，{sideName("A")} {state.score.A} 分，{sideName("B")} {state.score.B} 分。
      </p>
    </section>
  );
}
