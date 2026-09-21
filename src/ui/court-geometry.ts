/**
 * 横向羽毛球场地的几何定义，用于裁判工作台的响应式 SVG 场线。
 *
 * 坐标以厘米为单位放进 viewBox，长边横置：
 * 球场总长 13.40 m、总宽 6.10 m（双打），因此长宽比约 2.2:1，与工程方案的起点比率一致。
 * 这里只描述画线位置，不承担任何计分或轮转规则。
 *
 * 线位依据 BWF《Laws of Badminton》2025-04-26 V5.0(1) 的 Diagram A：
 * - 前发球线距球网 1.98 m；
 * - 双打后发球线距端线 0.76 m；
 * - 单打边线距双打边线 0.46 m；
 * - **中线只存在于发球区内**，即从端线画到前发球线为止，不穿过前场，也不跨越球网。
 */

/** 球场总长（cm），横向即 viewBox 的宽度。 */
export const COURT_LENGTH = 1340;
/** 球场总宽（cm），横向即 viewBox 的高度。 */
export const COURT_WIDTH = 610;

/** 球网所在的横向中点。 */
export const NET_X = COURT_LENGTH / 2;

/** 前发球线：距球网 1.98 m。 */
export const SHORT_SERVICE_OFFSET = 198;
/** 双打后发球线：距端线 0.76 m。 */
export const DOUBLES_LONG_SERVICE_INSET = 76;
/** 单打边线：距双打边线 0.46 m。 */
export const SINGLES_SIDELINE_INSET = 46;

export const LEFT_SHORT_SERVICE_X = NET_X - SHORT_SERVICE_OFFSET;
export const RIGHT_SHORT_SERVICE_X = NET_X + SHORT_SERVICE_OFFSET;
export const LEFT_DOUBLES_LONG_SERVICE_X = DOUBLES_LONG_SERVICE_INSET;
export const RIGHT_DOUBLES_LONG_SERVICE_X = COURT_LENGTH - DOUBLES_LONG_SERVICE_INSET;
export const TOP_SINGLES_SIDELINE_Y = SINGLES_SIDELINE_INSET;
export const BOTTOM_SINGLES_SIDELINE_Y = COURT_WIDTH - SINGLES_SIDELINE_INSET;
export const CENTRE_Y = COURT_WIDTH / 2;

export interface CourtLine {
  readonly id: string;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  /** 正式场线用 `line`；球网是器材而非场线，单独标注。 */
  readonly kind: "line" | "net";
}

/** 正式场线（不含外框，外框用一个 rect 画）。 */
export const COURT_LINES: readonly CourtLine[] = [
  // 单打边线，贯穿全长。
  { id: "singles-sideline-top", x1: 0, y1: TOP_SINGLES_SIDELINE_Y, x2: COURT_LENGTH, y2: TOP_SINGLES_SIDELINE_Y, kind: "line" },
  { id: "singles-sideline-bottom", x1: 0, y1: BOTTOM_SINGLES_SIDELINE_Y, x2: COURT_LENGTH, y2: BOTTOM_SINGLES_SIDELINE_Y, kind: "line" },
  // 前发球线，两侧各一条。
  { id: "short-service-left", x1: LEFT_SHORT_SERVICE_X, y1: 0, x2: LEFT_SHORT_SERVICE_X, y2: COURT_WIDTH, kind: "line" },
  { id: "short-service-right", x1: RIGHT_SHORT_SERVICE_X, y1: 0, x2: RIGHT_SHORT_SERVICE_X, y2: COURT_WIDTH, kind: "line" },
  // 双打后发球线。
  { id: "doubles-long-service-left", x1: LEFT_DOUBLES_LONG_SERVICE_X, y1: 0, x2: LEFT_DOUBLES_LONG_SERVICE_X, y2: COURT_WIDTH, kind: "line" },
  { id: "doubles-long-service-right", x1: RIGHT_DOUBLES_LONG_SERVICE_X, y1: 0, x2: RIGHT_DOUBLES_LONG_SERVICE_X, y2: COURT_WIDTH, kind: "line" },
  // 中线：只从端线画到前发球线，绝不穿过前场或球网。
  { id: "centre-left", x1: 0, y1: CENTRE_Y, x2: LEFT_SHORT_SERVICE_X, y2: CENTRE_Y, kind: "line" },
  { id: "centre-right", x1: RIGHT_SHORT_SERVICE_X, y1: CENTRE_Y, x2: COURT_LENGTH, y2: CENTRE_Y, kind: "line" },
  // 球网（器材，不是场线）。
  { id: "net", x1: NET_X, y1: 0, x2: NET_X, y2: COURT_WIDTH, kind: "net" },
];

export interface ServiceCourtBox {
  readonly screenHalf: "LEFT" | "RIGHT";
  readonly screenRow: "TOP" | "BOTTOM";
  /** 相对场地宽度的百分比，供 DOM 叠层绝对定位。 */
  readonly leftPercent: number;
  readonly topPercent: number;
  readonly widthPercent: number;
  readonly heightPercent: number;
}

function box(screenHalf: "LEFT" | "RIGHT", screenRow: "TOP" | "BOTTOM"): ServiceCourtBox {
  const x1 = screenHalf === "LEFT" ? LEFT_DOUBLES_LONG_SERVICE_X : RIGHT_SHORT_SERVICE_X;
  const x2 = screenHalf === "LEFT" ? LEFT_SHORT_SERVICE_X : RIGHT_DOUBLES_LONG_SERVICE_X;
  const y1 = screenRow === "TOP" ? 0 : CENTRE_Y;
  const y2 = screenRow === "TOP" ? CENTRE_Y : COURT_WIDTH;
  return {
    screenHalf,
    screenRow,
    leftPercent: (x1 / COURT_LENGTH) * 100,
    topPercent: (y1 / COURT_WIDTH) * 100,
    widthPercent: ((x2 - x1) / COURT_LENGTH) * 100,
    heightPercent: ((y2 - y1) / COURT_WIDTH) * 100,
  };
}

/**
 * 四个双打发球区的矩形（横向布局）。
 *
 * 这些方框只用来放置姓名与发接发标记，表示「下一次发接发的逻辑区域」，
 * 不代表运动员必须站在框内，也不追踪回合中的实际跑位。
 */
export const SERVICE_COURT_BOXES: readonly ServiceCourtBox[] = [
  box("LEFT", "TOP"),
  box("LEFT", "BOTTOM"),
  box("RIGHT", "TOP"),
  box("RIGHT", "BOTTOM"),
];

export function serviceCourtBox(screenHalf: "LEFT" | "RIGHT", screenRow: "TOP" | "BOTTOM"): ServiceCourtBox {
  const found = SERVICE_COURT_BOXES.find(
    (candidate) => candidate.screenHalf === screenHalf && candidate.screenRow === screenRow,
  );
  if (!found) throw new Error(`未知发球区 ${screenHalf}/${screenRow}`);
  return found;
}
