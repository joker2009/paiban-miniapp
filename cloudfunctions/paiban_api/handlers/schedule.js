const { db, COLLECTIONS, getAll } = require('../lib/cloud');
const { getIdentity, requireEmployee } = require('../lib/auth');
const { ERR } = require('../lib/errors');
const { str } = require('../lib/validate');
const { today, isValidDate, addDays, mondayOf, diffDays } = require('../lib/date');

const MAX_RANGE_DAYS = 31;

async function getMine(payload) {
  const identity = await getIdentity();
  const employee = requireEmployee(identity);

  const from = payload.from ? str(payload.from, 'from', { min: 10, max: 10 }) : today();
  const to = payload.to ? str(payload.to, 'to', { min: 10, max: 10 }) : addDays(today(), 13);
  if (!isValidDate(from) || !isValidDate(to)) throw ERR.INVALID_ARGUMENT('日期格式不正确');
  if (from > to) throw ERR.INVALID_ARGUMENT('开始日期不能晚于结束日期');
  if (diffDays(from, to) >= MAX_RANGE_DAYS) throw ERR.INVALID_ARGUMENT('查询范围不能超过 31 天');

  const teamDoc = await db.collection(COLLECTIONS.teams).doc(employee.teamId).get().catch(() => null);
  if (!teamDoc || !teamDoc.data) throw ERR.NOT_FOUND('团队不存在');
  const team = teamDoc.data;

  // 覆盖查询范围的周
  const weeks = [];
  let cursor = mondayOf(from);
  const lastMonday = mondayOf(to);
  let guard = 0;
  while (cursor <= lastMonday && guard < 8) {
    weeks.push(cursor);
    cursor = addDays(cursor, 7);
    guard += 1;
  }

  const pointers = {};
  const releaseIds = [];
  let lastPublishedAt = null;

  for (const weekStart of weeks) {
    const pid = `${employee.teamId}_${weekStart}`;
    const doc = await db.collection(COLLECTIONS.weekPointers).doc(pid).get().catch(() => null);
    if (!doc || !doc.data) continue;
    pointers[weekStart] = doc.data;
    releaseIds.push(doc.data.releaseId);
    const pubAt = new Date(doc.data.publishedAt);
    if (!lastPublishedAt || pubAt > lastPublishedAt) lastPublishedAt = pubAt;
  }

  let shifts = [];
  if (releaseIds.length > 0) {
    const all = await getAll(
      db.collection(COLLECTIONS.publishedShifts).where({
        employeeId: employee.employeeId,
        releaseId: db.command.in(releaseIds),
      })
    );
    shifts = all.filter((s) => s.workDate >= from && s.workDate <= to);
  }

  shifts.sort((a, b) => (a.workDate === b.workDate ? (a.startAt < b.startAt ? -1 : 1) : a.workDate < b.workDate ? -1 : 1));

  // 调班标记：与上一版本的本人班次对比
  const changedDates = [];
  for (const weekStart of weeks) {
    const ptr = pointers[weekStart];
    if (!ptr || ptr.version <= 1) continue;
    const prevRes = await db
      .collection(COLLECTIONS.releaseVersions)
      .where({ teamId: employee.teamId, weekStart, version: ptr.version - 1 })
      .limit(1)
      .get();
    const prev = prevRes.data[0];
    if (!prev) continue;
    const prevShifts = await getAll(
      db.collection(COLLECTIONS.publishedShifts).where({
        releaseId: prev._id,
        employeeId: employee.employeeId,
      })
    );
    const cur = {};
    for (const s of shifts) cur[s.workDate] = s.shiftCode;
    const old = {};
    for (const s of prevShifts) old[s.workDate] = s.shiftCode;
    const keys = new Set([...Object.keys(cur), ...Object.keys(old)]);
    for (const k of keys) {
      if (cur[k] !== old[k]) changedDates.push(k);
    }
  }

  return {
    teamId: employee.teamId,
    teamName: team.name,
    timezone: team.timezone || 'Asia/Shanghai',
    from,
    to,
    shifts: shifts.map((s) => ({
      workDate: s.workDate,
      shiftCode: s.shiftCode,
      label: s.label,
      category: s.category,
      status: s.category === 'WORK' ? 'WORKING' : s.category === 'STUDY' ? 'STUDY' : 'OFF',
      startAt: s.startAt,
      endAt: s.endAt,
      reminderEnabled: !!s.reminderEnabled,
      releaseVersion: (pointers[mondayOf(s.workDate)] || {}).version || 0,
      publishedAt: s.createdAt ? new Date(s.createdAt).toISOString() : null,
    })),
    changedDates: Array.from(new Set(changedDates)).sort(),
    lastPublishedAt: lastPublishedAt ? lastPublishedAt.toISOString() : null,
  };
}

module.exports = { getMine };
