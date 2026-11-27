const { cloud, db, _, COLLECTIONS, safeGet } = require('../lib/cloud');
const { getIdentity } = require('../lib/auth');
const { ERR } = require('../lib/errors');
const { str, arr } = require('../lib/validate');
const {
  today,
  isValidDate,
  weekday,
  addDays,
  mondayOf,
  diffDays,
  composeISO,
  isValidHHmm,
  validateShiftTimes,
} = require('../lib/date');

const MAX_RANGE_DAYS = 62;

function weekStartsCovering(from, to) {
  const weeks = [];
  let cur = mondayOf(from);
  const last = mondayOf(to);
  let guard = 0;
  while (cur <= last && guard < 12) {
    weeks.push(cur);
    cur = addDays(cur, 7);
    guard += 1;
  }
  return weeks;
}

function normalizeCategory(value) {
  if (value === 'OFF') return 'OFF';
  if (value === 'STUDY') return 'STUDY';
  return 'WORK';
}

/** 读取当前微信用户自己的排班与班次时间偏好 */
async function getMine(payload) {
  const identity = await getIdentity();
  const from = payload.from ? str(payload.from, 'from', { min: 10, max: 10 }) : today();
  const to = payload.to ? str(payload.to, 'to', { min: 10, max: 10 }) : addDays(today(), 27);
  if (!isValidDate(from) || !isValidDate(to)) throw ERR.INVALID_ARGUMENT('日期格式不正确');
  if (from > to) throw ERR.INVALID_ARGUMENT('开始日期不能晚于结束日期');
  if (diffDays(from, to) > MAX_RANGE_DAYS) throw ERR.INVALID_ARGUMENT('查询范围不能超过 62 天');

  const weeks = weekStartsCovering(from, to);
  const res = await safeGet(
    db
      .collection(COLLECTIONS.personalSchedules)
      .where({ openid: identity.openid, weekStart: _.in(weeks) })
      .limit(20)
  );
  const profileDoc = await db
    .collection(COLLECTIONS.userProfiles)
    .doc(identity.openid)
    .get()
    .catch(() => null);

  const shifts = [];
  for (const doc of res.data) {
    for (const s of doc.shifts || []) {
      if (s.workDate >= from && s.workDate <= to) {
        shifts.push({
          ...s,
          weekStart: doc.weekStart,
          employeeName: doc.employeeName || '',
          employeeNo: doc.employeeNo || '',
        });
      }
    }
  }
  shifts.sort((a, b) => (a.workDate < b.workDate ? -1 : a.workDate > b.workDate ? 1 : 0));

  return {
    openid: identity.openid,
    from,
    to,
    shifts,
    profile: profileDoc && profileDoc.data ? profileDoc.data : null,
  };
}

/** 保存某一周的个人排班（覆盖该周） */
/** 校验并生成一条班次记录 */
function buildShift(item, defByLabel) {
  const workDate = str(item.workDate, 'workDate', { min: 10, max: 10 });
  const label = str(item.label, '班次', { min: 1, max: 32 });
  if (!isValidDate(workDate)) {
    throw ERR.INVALID_ARGUMENT(`日期 ${workDate} 格式不正确`);
  }

  const category = normalizeCategory(item.category);
  let startLocal = null;
  let endLocal = null;
  let endDayOffset = 0;
  let reminderEnabled = false;
  let startAt = null;
  let endAt = null;

  if (category !== 'OFF') {
    const def = defByLabel.get(label) || {};
    startLocal = item.startLocal || def.startLocal;
    endLocal = item.endLocal || def.endLocal;
    endDayOffset = item.endDayOffset != null ? (item.endDayOffset === 1 ? 1 : 0) : (def.endDayOffset || 0);
    if (!isValidHHmm(startLocal) || !isValidHHmm(endLocal)) {
      throw ERR.INVALID_ARGUMENT(`班次「${label}」缺少起止时间`);
    }
    const timeErr = validateShiftTimes(startLocal, endLocal, endDayOffset);
    if (timeErr) throw ERR.INVALID_ARGUMENT(`班次「${label}」：${timeErr}`);
    startAt = composeISO(workDate, startLocal, 0);
    endAt = composeISO(workDate, endLocal, endDayOffset);
    reminderEnabled = item.reminderEnabled != null
      ? !!item.reminderEnabled
      : def.reminderEnabled !== false;
  }

  return {
    workDate,
    label,
    category,
    startLocal,
    endLocal,
    endDayOffset,
    startAt,
    endAt,
    reminderEnabled,
  };
}

async function saveWeek(payload) {
  const identity = await getIdentity();
  const employeeName = str(payload.employeeName || '我', '姓名', { min: 1, max: 32 });
  const employeeNo = payload.employeeNo ? str(payload.employeeNo, '工号', { min: 1, max: 32 }) : '';
  const items = arr(payload.shifts || [], '班次', { max: 62 });
  // 本次导入覆盖的日期（含被清空的日期），用于删除旧记录
  const scopeDates = Array.isArray(payload.dates)
    ? payload.dates.filter((d) => isValidDate(d))
    : [];

  const shiftTypes = arr(payload.shiftTypes || [], '班次时间', { max: 30 }).map((t) => ({
    label: str(t.label, '班次名称', { min: 1, max: 32 }),
    category: normalizeCategory(t.category),
    startLocal: t.startLocal || null,
    endLocal: t.endLocal || null,
    endDayOffset: t.endDayOffset === 1 ? 1 : 0,
    reminderEnabled: t.reminderEnabled !== false,
  }));
  const defByLabel = new Map(shiftTypes.map((t) => [t.label, t]));

  const now = new Date();
  const seen = new Set();
  const shifts = [];

  for (const item of items) {
    const shift = buildShift(item, defByLabel);
    if (seen.has(shift.workDate)) throw ERR.INVALID_ARGUMENT(`同一天重复：${shift.workDate}`);
    seen.add(shift.workDate);
    shifts.push(shift);
  }

  // 按 workDate 所在周分组；图片日期可能跨周
  const groups = new Map();
  for (const s of shifts) {
    const ws = mondayOf(s.workDate);
    if (!groups.has(ws)) groups.set(ws, []);
    groups.get(ws).push(s);
  }

  const weeks = [];
  for (const [weekStart, groupShifts] of groups) {
    const weekDocId = `${identity.openid}_${weekStart}`;
    const existing = await db
      .collection(COLLECTIONS.personalSchedules)
      .doc(weekDocId)
      .get()
      .catch(() => null);

    let mergedShifts = groupShifts;
    if (existing && existing.data) {
      // 合并：覆盖本次导入涉及的日期；本次该日期为空则删除旧记录
      const map = new Map(((existing.data.shifts) || []).map((s) => [s.workDate, s]));
      const incomingDates = new Set(groupShifts.map((s) => s.workDate));
      for (const d of scopeDates) {
        if (!incomingDates.has(d)) map.delete(d);
      }
      for (const s of groupShifts) map.set(s.workDate, s);
      mergedShifts = Array.from(map.values()).sort((a, b) =>
        a.workDate < b.workDate ? -1 : a.workDate > b.workDate ? 1 : 0
      );
    }

    const weekData = {
      openid: identity.openid,
      weekStart,
      employeeName,
      employeeNo,
      shifts: mergedShifts,
      updatedAt: now,
    };

    if (existing && existing.data) {
      await db.collection(COLLECTIONS.personalSchedules).doc(weekDocId).update({ data: weekData });
    } else {
      await db.collection(COLLECTIONS.personalSchedules).add({
        data: { _id: weekDocId, ...weekData, createdAt: now },
      });
    }
    weeks.push(weekStart);
  }

  const profile = {
    openid: identity.openid,
    employeeName,
    employeeNo,
    shiftTypes,
    updatedAt: now,
  };
  const profileDoc = await db
    .collection(COLLECTIONS.userProfiles)
    .doc(identity.openid)
    .get()
    .catch(() => null);
  if (profileDoc && profileDoc.data) {
    await db.collection(COLLECTIONS.userProfiles).doc(identity.openid).update({ data: profile });
  } else {
    await db.collection(COLLECTIONS.userProfiles).add({
      data: { _id: identity.openid, ...profile, createdAt: now },
    });
  }

  return { weeks, count: shifts.length };
}

/** 读取个人设置（姓名/工号/班次时间偏好） */
async function getProfile() {
  const identity = await getIdentity();
  const doc = await db
    .collection(COLLECTIONS.userProfiles)
    .doc(identity.openid)
    .get()
    .catch(() => null);
  return { openid: identity.openid, profile: doc && doc.data ? doc.data : null };
}

/** 保存姓名/工号，保留已有班次时间偏好 */
async function saveProfile(payload) {
  const identity = await getIdentity();
  const employeeName = str(payload.name, '姓名', { min: 1, max: 32 });
  const employeeNo = payload.employeeNo ? str(payload.employeeNo, '工号', { min: 1, max: 32 }) : '';
  const now = new Date();

  const existing = await db
    .collection(COLLECTIONS.userProfiles)
    .doc(identity.openid)
    .get()
    .catch(() => null);

  const data = {
    openid: identity.openid,
    employeeName,
    employeeNo,
    shiftTypes: (existing && existing.data && existing.data.shiftTypes) || [],
    updatedAt: now,
  };

  if (existing && existing.data) {
    await db.collection(COLLECTIONS.userProfiles).doc(identity.openid).update({ data });
  } else {
    await db.collection(COLLECTIONS.userProfiles).add({
      data: { _id: identity.openid, ...data, createdAt: now },
    });
  }
  return { profile: data };
}

/**
 * 创建识别任务（异步）。OCR 识别可能持续 20–60 秒，
 * 云函数间 callFunction 有 15 秒硬超时，因此不在请求内等待结果。
 */
async function recognize(payload) {
  const identity = await getIdentity();
  const fileID = str(payload.fileID, 'fileID', { min: 10, max: 500 });
  const weekStart = str(payload.weekStart, 'weekStart', { min: 10, max: 10 });
  if (!isValidDate(weekStart) || weekday(weekStart) !== 1) {
    throw ERR.INVALID_ARGUMENT('weekStart 必须是周一');
  }
  if (!fileID.includes(`imports/personal/${identity.openid}/`)) {
    throw ERR.FORBIDDEN('文件不属于当前用户');
  }

  const token = process.env.INTERNAL_TOKEN || '';
  if (!token) {
    throw ERR.OCR_FAILED('OCR 未配置 INTERNAL_TOKEN，请在 paiban_api 和 paiban_ocr 中设置相同的值');
  }

  const now = new Date();
  const added = await db.collection(COLLECTIONS.ocrTasks).add({
    data: {
      openid: identity.openid,
      fileID,
      weekStart,
      status: 'PENDING',
      createdAt: now,
      updatedAt: now,
    },
  });
  const taskId = added._id;

  // 立即唤醒一次；定时触发器会兜底处理未启动的任务
  cloud
    .callFunction({
      name: process.env.OCR_FUNCTION_NAME || 'paiban_ocr',
      data: { action: 'recognizeTask', token, taskId },
    })
    .catch((e) => console.warn('[personal.recognize] wake ocr failed', e && e.message));

  return { taskId, status: 'PENDING' };
}

/** 轮询识别任务 */
async function getRecognizeTask(payload) {
  const identity = await getIdentity();
  const taskId = str(payload.taskId, 'taskId', { min: 1, max: 64 });
  const doc = await db
    .collection(COLLECTIONS.ocrTasks)
    .doc(taskId)
    .get()
    .catch(() => null);
  if (!doc || !doc.data || doc.data.openid !== identity.openid) {
    throw ERR.NOT_FOUND('识别任务不存在');
  }
  const t = doc.data;
  return {
    taskId,
    status: t.status,
    weekStart: t.weekStart,
    dates: t.dates || null,
    rows: t.rows || null,
    notes: t.notes || '',
    error: t.error || null,
  };
}

async function loadProfileData(openid) {
  const doc = await db
    .collection(COLLECTIONS.userProfiles)
    .doc(openid)
    .get()
    .catch(() => null);
  return doc && doc.data ? doc.data : null;
}

/** 编辑/新增单条班次：只改该周文档，不动姓名与班次偏好 */
async function saveShift(payload) {
  const identity = await getIdentity();
  const profile = await loadProfileData(identity.openid);
  const defs = (profile && profile.shiftTypes) || [];
  const defByLabel = new Map(defs.map((t) => [t.label, t]));

  const shift = buildShift(payload, defByLabel);
  const weekStart = mondayOf(shift.workDate);
  const docId = `${identity.openid}_${weekStart}`;
  const existing = await db
    .collection(COLLECTIONS.personalSchedules)
    .doc(docId)
    .get()
    .catch(() => null);

  const map = new Map(((existing && existing.data && existing.data.shifts) || []).map((s) => [s.workDate, s]));
  map.set(shift.workDate, shift);
  const shifts = Array.from(map.values()).sort((a, b) =>
    a.workDate < b.workDate ? -1 : a.workDate > b.workDate ? 1 : 0
  );

  const now = new Date();
  if (existing && existing.data) {
    await db.collection(COLLECTIONS.personalSchedules).doc(docId).update({
      data: { shifts, updatedAt: now },
    });
  } else {
    await db.collection(COLLECTIONS.personalSchedules).add({
      data: {
        _id: docId,
        openid: identity.openid,
        weekStart,
        employeeName: (profile && profile.employeeName) || '',
        employeeNo: (profile && profile.employeeNo) || '',
        shifts,
        createdAt: now,
        updatedAt: now,
      },
    });
  }

  return { shift, weekStart };
}

/** 删除某天的班次 */
async function deleteShift(payload) {
  const identity = await getIdentity();
  const workDate = str(payload.workDate, 'workDate', { min: 10, max: 10 });
  if (!isValidDate(workDate)) throw ERR.INVALID_ARGUMENT('日期格式不正确');

  const weekStart = mondayOf(workDate);
  const docId = `${identity.openid}_${weekStart}`;
  const existing = await db
    .collection(COLLECTIONS.personalSchedules)
    .doc(docId)
    .get()
    .catch(() => null);
  if (!existing || !existing.data) return { deleted: false };

  const shifts = (existing.data.shifts || []).filter((s) => s.workDate !== workDate);
  await db.collection(COLLECTIONS.personalSchedules).doc(docId).update({
    data: { shifts, updatedAt: new Date() },
  });
  return { deleted: true };
}

module.exports = {
  getMine,
  saveWeek,
  recognize,
  getRecognizeTask,
  getProfile,
  saveProfile,
  saveShift,
  deleteShift,
};
