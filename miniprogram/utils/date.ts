/**
 * 日期工具：全部按 Asia/Shanghai（固定 +08:00）处理。
 * workDate 恒为 `YYYY-MM-DD`，表示班次开始所属日期。
 */

const OFFSET_MS = 8 * 60 * 60 * 1000;

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** 当前上海时间 */
export function shanghaiNow(now: number = Date.now()): { date: string; time: string; dateTime: string } {
  const d = new Date(now + OFFSET_MS);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return { date, time, dateTime: `${date} ${time}` };
}

/** 时间戳 → 上海日期 */
export function tsToDate(ts: number): string {
  return shanghaiNow(ts).date;
}

/** 上海“今天” */
export function today(): string {
  return shanghaiNow().date;
}

/** `YYYY-MM-DD` 合法性 */
export function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function parts(s: string): { y: number; m: number; d: number } {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

function fmt(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** 日期加减天数 */
export function addDays(dateStr: string, days: number): string {
  const { y, m, d } = parts(dateStr);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return fmt(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** 星期（1=周一 … 7=周日） */
export function weekday(dateStr: string): number {
  const { y, m, d } = parts(dateStr);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}

/** 所在周的周一 */
export function mondayOf(dateStr: string): string {
  return addDays(dateStr, 1 - weekday(dateStr));
}

/** 生成 [from, to] 闭区间日期数组 */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from;
  let guard = 0;
  while (cur <= to && guard < 400) {
    out.push(cur);
    cur = addDays(cur, 1);
    guard += 1;
  }
  return out;
}

/** 两个日期相差天数（to - from） */
export function diffDays(from: string, to: string): number {
  const a = parts(from);
  const b = parts(to);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
}

/** 合成上海时区 ISO 字符串：`2026-12-07T20:00:00+08:00` */
export function composeShanghaiISO(dateStr: string, hhmm: string, dayOffset = 0): string {
  const base = addDays(dateStr, dayOffset);
  return `${base}T${hhmm}:00+08:00`;
}

/** ISO（含偏移）→ Unix 秒（微信日历接口要求秒） */
export function isoToUnixSeconds(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

/** 展示用：`12-07 周一` */
export function displayDate(dateStr: string): string {
  const names = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const [, m, d] = dateStr.split('-');
  return `${m}-${d} ${names[weekday(dateStr)]}`;
}

/** 展示用：`12-07 20:00 - 12-08 06:00` */
export function displayRange(startAt: string | null, endAt: string | null): string {
  if (!startAt || !endAt) return '—';
  const s = startAt.slice(5, 16).replace('T', ' ');
  const e = endAt.slice(5, 16).replace('T', ' ');
  return `${s} → ${e}`;
}

/** 当前时间是否落在 [startAt, endAt) 内 */
export function isOngoing(startAt: string | null, endAt: string | null, now = Date.now()): boolean {
  if (!startAt || !endAt) return false;
  const s = new Date(startAt).getTime();
  const e = new Date(endAt).getTime();
  return now >= s && now < e;
}
