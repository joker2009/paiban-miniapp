const crypto = require('crypto');
const { db, _, COLLECTIONS, getAll } = require('../lib/cloud');
const { getIdentity, requireAdmin } = require('../lib/auth');
const { ERR } = require('../lib/errors');
const { str, int, optStr } = require('../lib/validate');
const { composeISO, validateShiftTimes } = require('../lib/date');
const { audit } = require('../lib/audit');

function pointerId(teamId, weekStart) {
  return `${teamId}_${weekStart}`;
}

async function loadJobForAdmin(payload) {
  const jobId = str(payload.jobId, 'jobId', { min: 1, max: 64 });
  const doc = await db.collection(COLLECTIONS.importJobs).doc(jobId).get().catch(() => null);
  if (!doc || !doc.data) throw ERR.NOT_FOUND('任务不存在');
  const identity = await getIdentity();
  requireAdmin(identity, doc.data.teamId);
  return { identity, job: doc.data, jobId };
}

async function getPointer(teamId, weekStart) {
  const doc = await db.collection(COLLECTIONS.weekPointers).doc(pointerId(teamId, weekStart)).get().catch(() => null);
  return doc && doc.data ? doc.data : null;
}

/** 汇总草稿中已确认的单元格（员工 + 日期 → 班次/清除） */
async function buildDraftMap(jobId) {
  const cells = await getAll(db.collection(COLLECTIONS.draftCells).where({ jobId }));
  // OCR 精确匹配（MATCHED）与人工确认（MANUAL）都视为已确认，待校对项不参与发布
  const confirmed = cells.filter(
    (c) => (c.status === 'MANUAL' || c.status === 'MATCHED') && c.employeeId && c.workDate
  );
  const map = {};
  const issues = [];
  for (const c of cells) {
    if ((c.status === 'MANUAL' || c.status === 'MATCHED') && (!c.employeeId || !c.workDate)) {
      issues.push({ cellId: c._id, reason: '存在缺少员工或日期的已确认单元格，请修正后重试' });
    }
  }
  for (const c of confirmed) {
    const key = `${c.employeeId}|${c.workDate}`;
    if (map[key]) {
      issues.push({ cellId: c._id, reason: '同一员工同一天存在多条已确认记录（请保留一条）' });
      continue;
    }
    map[key] = {
      cellId: c._id,
      employeeId: c.employeeId,
      workDate: c.workDate,
      shiftCode: c.cleared ? null : c.shiftCode,
      cleared: !!c.cleared,
    };
  }
  return { cells, confirmed, map, issues };
}

async function currentShifts(pointer) {
  if (!pointer || !pointer.releaseId) return [];
  return getAll(db.collection(COLLECTIONS.publishedShifts).where({ releaseId: pointer.releaseId }));
}

function computeDiff(draftMap, shifts) {
  const current = {};
  for (const s of shifts) current[`${s.employeeId}|${s.workDate}`] = s;

  let added = 0;
  let modified = 0;
  let removed = 0;
  let unchanged = 0;

  for (const key of Object.keys(draftMap)) {
    const d = draftMap[key];
    const old = current[key];
    if (!old) {
      if (!d.cleared) added += 1;
      // 清除一个不存在的班次不算变更
    } else if (d.cleared) {
      removed += 1;
    } else if (old.shiftCode !== d.shiftCode) {
      modified += 1;
    } else {
      unchanged += 1;
    }
  }
  for (const key of Object.keys(current)) {
    if (!draftMap[key]) unchanged += 1; // 未纳入本次修改，沿用旧版本
  }
  return { added, modified, removed, unchanged, current };
}

async function collectBlockers(job, draftInfo, shiftMap) {
  const blockers = [];
  const pending = draftInfo.cells.filter((c) => c.status === 'NEEDS_REVIEW');
  for (const c of pending) {
    blockers.push({
      cellId: c._id,
      reason: `第 ${(c.pageIndex || 0) + 1} 页 ${c.workDate || '日期未知'} ${c.employeeName || c.employeeNo || '未匹配员工'} 待校对`,
    });
  }
  for (const row of job.unmatchedRows || []) {
    blockers.push({ reason: `未匹配员工行 ${row.employeeNo || '（缺工号）'} ${row.employeeName || ''}`.trim() });
  }
  for (const issue of draftInfo.issues) blockers.push(issue);

  const weekEnd = addDaysStr(job.weekStart, 6);
  for (const key of Object.keys(draftInfo.map)) {
    const d = draftInfo.map[key];
    if (d.cleared) continue;
    const shift = shiftMap[d.shiftCode];
    if (!shift) {
      blockers.push({ cellId: d.cellId, reason: `班次 ${d.shiftCode} 不在字典中` });
      continue;
    }
    if (shift.enabled === false) {
      blockers.push({ cellId: d.cellId, reason: `班次 ${shift.label} 已停用` });
    }
    if (d.workDate < job.weekStart || d.workDate > weekEnd) {
      blockers.push({ cellId: d.cellId, reason: `日期 ${d.workDate} 不在本周范围内` });
    }
    if (shift.category === 'WORK' && (!shift.startLocal || !shift.endLocal)) {
      blockers.push({ cellId: d.cellId, reason: `班次 ${shift.label} 未配置起止时间` });
    } else if (shift.startLocal && shift.endLocal) {
      const err = validateShiftTimes(shift.startLocal, shift.endLocal, shift.endDayOffset || 0);
      if (err) blockers.push({ cellId: d.cellId, reason: `班次 ${shift.label}：${err}` });
    }
  }
  return blockers;
}

function addDaysStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

async function loadShiftMap(teamId) {
  const res = await db.collection(COLLECTIONS.shiftTypes).where({ teamId }).limit(200).get();
  const map = {};
  for (const s of res.data) map[s.code] = s;
  return map;
}

function assertReviewable(job) {
  if (job.status === 'PUBLISHED') throw ERR.CONFLICT('该任务已发布');
  if (job.status !== 'NEEDS_REVIEW' && job.status !== 'READY') {
    throw ERR.CONFLICT('任务尚未完成识别，暂时不能预览或发布');
  }
}

async function preview(payload) {
  const { job, jobId } = await loadJobForAdmin(payload);
  assertReviewable(job);
  const revision = int(payload.revision, 'revision', { min: 1, max: 1e9 });
  if (revision !== job.revision) throw ERR.DRAFT_CONFLICT();

  const shiftMap = await loadShiftMap(job.teamId);
  const draftInfo = await buildDraftMap(jobId);
  const pointer = await getPointer(job.teamId, job.weekStart);
  const baseVersion = pointer ? pointer.version : 0;
  const shifts = await currentShifts(pointer);
  const diff = computeDiff(draftInfo.map, shifts);
  const blockers = await collectBlockers(job, draftInfo, shiftMap);

  const noChange = diff.added + diff.modified + diff.removed === 0;
  return {
    baseVersion,
    added: diff.added,
    modified: diff.modified,
    removed: diff.removed,
    unchanged: diff.unchanged,
    blockers,
    canPublish: blockers.length === 0 && !noChange && diff.unchanged + diff.added + diff.modified + diff.removed > 0,
  };
}

async function writePublishedShifts(releaseId, rows) {
  const chunk = 20;
  for (let i = 0; i < rows.length; i += chunk) {
    await Promise.all(
      rows.slice(i, i + chunk).map((r) => {
        const id = `${releaseId}_${r.employeeId}_${r.workDate}`;
        return db
          .collection(COLLECTIONS.publishedShifts)
          .add({ data: { _id: id, ...r } })
          .catch(async (e) => {
            // 重复写同一版本视为幂等
            if (String(e.errMsg || e.message || '').includes('duplicate')) return;
            throw e;
          });
      })
    );
  }
}

async function publish(payload) {
  const { identity, job, jobId } = await loadJobForAdmin(payload);
  const revision = int(payload.revision, 'revision', { min: 1, max: 1e9 });
  if (revision !== job.revision) throw ERR.DRAFT_CONFLICT();
  const baseVersion = int(payload.baseVersion, 'baseVersion', { min: 0, max: 1e9 });
  const requestId = str(payload.requestId, 'requestId', { min: 8, max: 128 });
  const note = optStr(payload.note, '变更说明', { max: 200 }) || '';

  const idemId = `${job.teamId}_${requestId}`;
  const idem = await db.collection(COLLECTIONS.idempotency).doc(idemId).get().catch(() => null);
  if (idem && idem.data) {
    return { releaseId: idem.data.releaseId, version: idem.data.version, idempotent: true };
  }

  assertReviewable(job);

  const shiftMap = await loadShiftMap(job.teamId);
  const draftInfo = await buildDraftMap(jobId);
  const blockers = await collectBlockers(job, draftInfo, shiftMap);
  if (blockers.length > 0) {
    throw ERR.REVIEW_REQUIRED(`存在 ${blockers.length} 个阻断项，请先处理`);
  }

  const pointer = await getPointer(job.teamId, job.weekStart);
  const currentVersion = pointer ? pointer.version : 0;
  if (currentVersion !== baseVersion) throw ERR.VERSION_CONFLICT();

  const newVersion = currentVersion + 1;
  const releaseId = `rel_${job.teamId}_${job.weekStart}_v${newVersion}_${crypto.randomBytes(4).toString('hex')}`;
  const now = new Date();

  // 1) 计算新快照
  const byKey = {};
  for (const key of Object.keys(draftInfo.map)) {
    const d = draftInfo.map[key];
    if (d.cleared) continue;
    const shift = shiftMap[d.shiftCode];
    byKey[key] = {
      employeeId: d.employeeId,
      workDate: d.workDate,
      shiftCode: shift.code,
      label: shift.label,
      category: shift.category,
      startAt: shift.startLocal ? composeISO(d.workDate, shift.startLocal, 0) : null,
      endAt: shift.endLocal ? composeISO(d.workDate, shift.endLocal, shift.endDayOffset || 0) : null,
      reminderEnabled: (shift.category === 'WORK' || shift.category === 'STUDY') && shift.reminderEnabled === true,
      startLocal: shift.startLocal || null,
      endLocal: shift.endLocal || null,
      endDayOffset: shift.endDayOffset || 0,
    };
  }

  // 未纳入本次修改的旧班次沿用
  const oldShifts = await currentShifts(pointer);
  for (const s of oldShifts) {
    const key = `${s.employeeId}|${s.workDate}`;
    if (byKey[key]) continue;
    byKey[key] = {
      employeeId: s.employeeId,
      workDate: s.workDate,
      shiftCode: s.shiftCode,
      label: s.label,
      category: s.category,
      startAt: s.startAt,
      endAt: s.endAt,
      reminderEnabled: !!s.reminderEnabled,
      startLocal: s.startLocal || null,
      endLocal: s.endLocal || null,
      endDayOffset: s.endDayOffset || 0,
    };
  }

  const rows = Object.keys(byKey).map((key) => ({
    releaseId,
    teamId: job.teamId,
    orgId: job.orgId || null,
    ...byKey[key],
    createdAt: now,
  }));

  // 2) 先写完整快照，校验数量
  await writePublishedShifts(releaseId, rows);
  const written = await db
    .collection(COLLECTIONS.publishedShifts)
    .where({ releaseId })
    .count();
  if (written.total !== rows.length) {
    console.error('[release] snapshot incomplete', releaseId, written.total, rows.length);
    throw ERR.INTERNAL('发布快照不完整，请重试');
  }

  // 3) 差异摘要
  const diff = computeDiff(draftInfo.map, oldShifts);
  const summary = {
    added: diff.added,
    modified: diff.modified,
    removed: diff.removed,
    unchanged: diff.unchanged,
  };

  await db.collection(COLLECTIONS.releaseVersions).add({
    data: {
      _id: releaseId,
      teamId: job.teamId,
      orgId: job.orgId || null,
      weekStart: job.weekStart,
      version: newVersion,
      baseVersion,
      jobId,
      operatorOpenid: identity.openid,
      summary,
      note,
      shiftCount: rows.length,
      publishedAt: now,
      createdAt: now,
    },
  });

  // 4) 事务切换版本指针 + 幂等记录
  const tx = await db.startTransaction();
  try {
    let curPointer = null;
    try {
      const p = await tx.collection(COLLECTIONS.weekPointers).doc(pointerId(job.teamId, job.weekStart)).get();
      curPointer = p.data;
    } catch (ignore) {
      curPointer = null;
    }
    const curVersion = curPointer ? curPointer.version : 0;
    if (curVersion !== baseVersion) {
      await tx.rollback();
      throw ERR.VERSION_CONFLICT();
    }

    const pointerPayload = {
      teamId: job.teamId,
      weekStart: job.weekStart,
      releaseId,
      version: newVersion,
      publishedAt: now,
      updatedAt: now,
    };
    if (curPointer) {
      await tx.collection(COLLECTIONS.weekPointers).doc(pointerId(job.teamId, job.weekStart)).update({
        data: pointerPayload,
      });
    } else {
      await tx.collection(COLLECTIONS.weekPointers).add({
        data: { _id: pointerId(job.teamId, job.weekStart), ...pointerPayload },
      });
    }

    await tx.collection(COLLECTIONS.idempotency).add({
      data: { _id: idemId, teamId: job.teamId, releaseId, version: newVersion, createdAt: now },
    });

    await tx.commit();
  } catch (e) {
    try { await tx.rollback(); } catch (ignore) { /* noop */ }
    if (e instanceof Error && e.code === 'VERSION_CONFLICT') throw e;
    console.error('[release] pointer transaction failed', e && e.message);
    throw ERR.VERSION_CONFLICT();
  }

  await db.collection(COLLECTIONS.importJobs).doc(jobId).update({
    data: { status: 'PUBLISHED', releaseId, publishedAt: now, updatedAt: now },
  });

  await audit({
    teamId: job.teamId,
    operatorOpenid: identity.openid,
    action: 'release.publish',
    refId: releaseId,
    summary: `v${newVersion} ${JSON.stringify(summary)}`,
  });

  return { releaseId, version: newVersion };
}

async function listHistory(payload) {
  const teamId = str(payload.teamId, 'teamId', { min: 1, max: 64 });
  const weekStart = str(payload.weekStart, 'weekStart', { min: 10, max: 10 });
  const identity = await getIdentity();
  requireAdmin(identity, teamId);

  const res = await db
    .collection(COLLECTIONS.releaseVersions)
    .where({ teamId, weekStart })
    .orderBy('version', 'desc')
    .limit(20)
    .get();

  return {
    items: res.data.map((r) => ({
      releaseId: r._id,
      version: r.version,
      baseVersion: r.baseVersion,
      publishedAt: new Date(r.publishedAt).toISOString(),
      operatorName: r.operatorOpenid ? '管理员' : '',
      summary: r.summary || { added: 0, modified: 0, removed: 0, unchanged: 0 },
      note: r.note || '',
      shiftCount: r.shiftCount || 0,
    })),
  };
}

module.exports = { preview, publish, listHistory };
