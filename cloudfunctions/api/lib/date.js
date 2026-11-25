/** 服务端日期工具：统一按 Asia/Shanghai（+08:00）计算。 */

const OFFSET_MS = 8 * 60 * 60 * 1000;

function pad(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

function shanghaiNow(now = Date.now()) {
  const d = new Date(now + OFFSET_MS);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return { date, time, dateTime: `${date} ${time}` };
}

function today() {
  return shanghaiNow().date;
}

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function parts(s) {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

function addDays(dateStr, days) {
  const { y, m, d } = parts(dateStr);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function weekday(dateStr) {
  const { y, m, d } = parts(dateStr);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}

function mondayOf(dateStr) {
  return addDays(dateStr, 1 - weekday(dateStr));
}

function diffDays(from, to) {
  const a = parts(from);
  const b = parts(to);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
}

function dateRange(from, to) {
  const out = [];
  let cur = from;
  let guard = 0;
  while (cur <= to && guard < 400) {
    out.push(cur);
    cur = addDays(cur, 1);
    guard += 1;
  }
  return out;
}

/** `YYYY-MM-DD` + `HH:mm` + 日偏移 → 带 +08:00 的 ISO 字符串 */
function composeISO(dateStr, hhmm, dayOffset = 0) {
  return `${addDays(dateStr, dayOffset)}T${hhmm}:00+08:00`;
}

function isValidHHmm(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

/** 校验班次时间：结束必须晚于开始 */
function validateShiftTimes(startLocal, endLocal, endDayOffset) {
  if (!isValidHHmm(startLocal) || !isValidHHmm(endLocal)) {
    return '起止时间格式不正确';
  }
  if (endDayOffset !== 0 && endDayOffset !== 1) {
    return '结束日偏移只允许 0 或 1';
  }
  const [sh, sm] = startLocal.split(':').map(Number);
  const [eh, em] = endLocal.split(':').map(Number);
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em + endDayOffset * 1440;
  if (endMin <= startMin) {
    return '结束时间必须晚于开始时间（跨日请设置结束日偏移）';
  }
  return null;
}

module.exports = {
  shanghaiNow,
  today,
  isValidDate,
  addDays,
  weekday,
  mondayOf,
  diffDays,
  dateRange,
  composeISO,
  isValidHHmm,
  validateShiftTimes,
};
