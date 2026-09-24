/**
 * 赛事时区下的「本地日期时间」与 UTC 时刻互转。
 *
 * 报名截止等时间由组织者按赛事时区填写，不能按浏览器或服务器所在时区解释。
 * 只依赖 `Intl`，不引入时区库。
 */

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export function isValidTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function partsInZone(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function offsetMillis(instant: number, timeZone: string) {
  const p = partsInZone(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * 把 `YYYY-MM-DDTHH:mm`（赛事时区下的墙上时间）换成 UTC 时刻。
 * 格式错误、日期不存在或落在夏令时跳过的时段时返回 null，调用方应当拒绝而不是猜测。
 */
export function zonedLocalToUtc(local: string, timeZone: string): Date | null {
  const match = LOCAL_DATE_TIME.exec(local);
  if (!match || !isValidTimeZone(timeZone)) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(naive);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  if (hour > 23 || minute > 59) return null;

  // 两次迭代足以收敛到正确偏移（处理偏移在该时刻附近变化的情况）。
  let guess = naive - offsetMillis(naive, timeZone);
  guess = naive - offsetMillis(guess, timeZone);
  if (utcToZonedLocal(new Date(guess), timeZone) !== local) return null;
  return new Date(guess);
}

/** UTC 时刻 → 赛事时区的 `YYYY-MM-DDTHH:mm`，用于回填 `<input type="datetime-local">`。 */
export function utcToZonedLocal(instant: Date, timeZone: string) {
  const p = partsInZone(instant.getTime(), timeZone);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** 面向中文读者的赛事时区时间，如「2026-10-01 09:00（Asia/Shanghai）」。 */
export function formatZoned(instant: Date, timeZone: string) {
  return `${utcToZonedLocal(instant, timeZone).replace("T", " ")}（${timeZone}）`;
}
