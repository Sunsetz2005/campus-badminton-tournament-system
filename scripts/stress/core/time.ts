/** 赛事时区下的本地时间文本（接口要的 `YYYY-MM-DD`、`HH:mm`、`YYYY-MM-DDTHH:mm`）。 */
export const TIMEZONE = "Asia/Shanghai";

function parts(date: Date, timeZone = TIMEZONE) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const map = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return { date: `${map.year}-${map.month}-${map.day}`, time: `${map.hour}:${map.minute}` };
}

export function localDate(date: Date, timeZone = TIMEZONE) {
  return parts(date, timeZone).date;
}

export function localDateTime(date: Date, timeZone = TIMEZONE) {
  const value = parts(date, timeZone);
  return `${value.date}T${value.time}`;
}

/** 向上取整到整分钟。 */
export function ceilMinute(date: Date) {
  const ms = 60_000;
  return new Date(Math.ceil(date.getTime() / ms) * ms);
}
