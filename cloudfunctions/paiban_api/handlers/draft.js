const { db, _, COLLECTIONS, getAll, safeGet } = require('../lib/cloud');
const { getIdentity, requireAdmin } = require('../lib/auth');
const { ERR } = require('../lib/errors');
const { str, int, arr } = require('../lib/validate');
const { refreshJobReviewStatus } = require('../lib/jobStatus');
const { audit } = require('../lib/audit');

async function loadJobForAdmin(payload) {
  const jobId = str(payload.jobId, 'jobId', { min: 1, max: 64 });
  const doc = await db.collection(COLLECTIONS.importJobs).doc(jobId).get().catch(() => null);
  if (!doc || !doc.data) throw ERR.NOT_FOUND('任务不存在');
  const identity = await getIdentity();
  requireAdmin(identity, doc.data.teamId);
  return { identity, job: doc.data, jobId };
}

async function listCells(payload) {
  const { job, jobId } = await loadJobForAdmin(payload);
  const cells = await getAll(
    db.collection(COLLECTIONS.draftCells).where({ jobId }).orderBy('workDate', 'asc').orderBy('employeeNo', 'asc')
  );
  return {
    jobId,
    revision: job.revision,
    cells: cells
      .filter((c) => c.status !== 'SUPERSEDED')
      .map((c) => ({
        _id: c._id,
        jobId: c.jobId,
        rowKey: c.rowKey,
        employeeId: c.employeeId,
        employeeNo: c.employeeNo,
        employeeName: c.employeeName,
        workDate: c.workDate,
        rawText: c.rawText,
        shiftCode: c.shiftCode,
        cleared: !!c.cleared,
        status: c.status,
        issues: c.issues || [],
        pageIndex: c.pageIndex,
        rect: c.rect || null,
      })),
    unmatchedRows: job.unmatchedRows || [],
  };
}

async function saveCells(payload) {
  const { identity, job, jobId } = await loadJobForAdmin(payload);
  const revision = int(payload.revision, 'revision', { min: 1, max: 1e9 });
  if (revision !== job.revision) throw ERR.DRAFT_CONFLICT();
  if (job.status === 'PUBLISHED' || job.status === 'RECOGNIZING') {
    throw ERR.CONFLICT('当前任务状态不允许修改草稿');
  }

  const patches = arr(payload.patches, '修改项', { min: 1, max: 200 });
  const shiftRes = await safeGet(
    db.collection(COLLECTIONS.shiftTypes).where({ teamId: job.teamId }).limit(200)
  );
  const shiftMap = {};
  for (const s of shiftRes.data) shiftMap[s.code] = s;

  const now = new Date();
  const touchedRows = new Set();

  for (const p of patches) {
    const cellId = str(p.cellId, 'cellId', { min: 1, max: 64 });
    const doc = await db.collection(COLLECTIONS.draftCells).doc(cellId).get().catch(() => null);
    if (!doc || !doc.data || doc.data.jobId !== jobId) throw ERR.NOT_FOUND('单元格不存在');
    const cell = doc.data;

    if (!cell.workDate) {
      throw ERR.INVALID_ARGUMENT('该单元格缺少排班日期，请先修正日期或重新识别');
    }
    if (!cell.employeeId) {
      throw ERR.INVALID_ARGUMENT('该单元格未匹配员工，请先在“未匹配员工”中关联该行');
    }

    const data = { updatedAt: now };

    if (p.cleared === true) {
      data.cleared = true;
      data.shiftCode = null;
      data.status = 'MANUAL';
      data.issues = [];
    } else if (p.shiftCode != null) {
      const code = str(p.shiftCode, '班次编码', { min: 1, max: 24 });
      if (!shiftMap[code] || shiftMap[code].enabled === false) {
        throw ERR.INVALID_ARGUMENT('班次不存在或已停用');
      }
      data.cleared = false;
      data.shiftCode = code;
      data.shiftLabel = shiftMap[code].label;
      data.status = 'MANUAL';
      data.issues = [];
    } else {
      throw ERR.INVALID_ARGUMENT('每个修改项必须设置班次或确认未排班');
    }

    await db.collection(COLLECTIONS.draftCells).doc(cellId).update({ data });
    touchedRows.add(`${cell.rowKey}|${cell.workDate}`);
  }

  // 多图/重复单元格：同一行同一天一旦人工选定，其余冲突单元格作废
  for (const key of touchedRows) {
    const [rowKey, workDate] = key.split('|');
    if (!workDate) continue;
    const siblings = await safeGet(
      db
        .collection(COLLECTIONS.draftCells)
        .where({ jobId, rowKey, workDate, status: 'NEEDS_REVIEW' })
    );
    for (const s of siblings.data) {
      await db.collection(COLLECTIONS.draftCells).doc(s._id).update({
        data: { status: 'SUPERSEDED', issues: [], updatedAt: now },
      });
    }
  }

  const nextRevision = job.revision + 1;
  await db.collection(COLLECTIONS.importJobs).doc(jobId).update({
    data: { revision: nextRevision, updatedAt: now },
  });

  const result = await refreshJobReviewStatus(jobId);

  await audit({
    teamId: job.teamId,
    operatorOpenid: identity.openid,
    action: 'draft.saveCells',
    refId: jobId,
    summary: `${patches.length} patches`,
  });

  return { revision: nextRevision, blockers: result.blockers || 0 };
}

async function linkRow(payload) {
  const { identity, job, jobId } = await loadJobForAdmin(payload);
  const revision = int(payload.revision, 'revision', { min: 1, max: 1e9 });
  if (revision !== job.revision) throw ERR.DRAFT_CONFLICT();
  if (job.status === 'PUBLISHED' || job.status === 'RECOGNIZING') {
    throw ERR.CONFLICT('当前任务状态不允许修改草稿');
  }

  const rowKey = str(payload.rowKey, 'rowKey', { min: 1, max: 128 });
  const employeeId = str(payload.employeeId, 'employeeId', { min: 1, max: 64 });

  const empDoc = await db.collection(COLLECTIONS.employees).doc(employeeId).get().catch(() => null);
  if (!empDoc || !empDoc.data || empDoc.data.teamId !== job.teamId) {
    throw ERR.NOT_FOUND('员工不属于该团队');
  }
  if (empDoc.data.status !== 'ACTIVE') throw ERR.CONFLICT('员工已停用，不能关联');

  // 同一员工同一天在草稿内只能有一条有效记录
  const cells = await getAll(db.collection(COLLECTIONS.draftCells).where({ jobId, rowKey }));
  if (cells.length === 0) throw ERR.NOT_FOUND('该行没有可关联的单元格');

  const now = new Date();
  for (const c of cells) {
    const resolved = c.cleared || !!c.shiftCode;
    await db.collection(COLLECTIONS.draftCells).doc(c._id).update({
      data: {
        employeeId,
        employeeNo: empDoc.data.employeeNo,
        employeeName: empDoc.data.name,
        status: resolved ? 'MANUAL' : 'NEEDS_REVIEW',
        issues: (c.issues || []).filter((x) => !String(x).includes('未匹配员工')),
        updatedAt: now,
      },
    });
  }

  const unmatchedRows = (job.unmatchedRows || []).filter((r) => r.rowKey !== rowKey);
  const nextRevision = job.revision + 1;
  await db.collection(COLLECTIONS.importJobs).doc(jobId).update({
    data: { unmatchedRows, revision: nextRevision, updatedAt: now },
  });

  const result = await refreshJobReviewStatus(jobId);

  await audit({
    teamId: job.teamId,
    operatorOpenid: identity.openid,
    action: 'draft.linkRow',
    refId: jobId,
    summary: `${rowKey} -> ${empDoc.data.employeeNo}`,
  });

  return { revision: nextRevision, blockers: result.blockers || 0 };
}

module.exports = { listCells, saveCells, linkRow };
