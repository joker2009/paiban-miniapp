const { db, _, COLLECTIONS, safeCount } = require('./cloud');

/** 草稿是否可发布：无待校对单元格、无未匹配员工行、至少一个已确认单元格 */
async function computeBlockers(job) {
  const pending = await safeCount(
    db.collection(COLLECTIONS.draftCells).where({ jobId: job._id, status: 'NEEDS_REVIEW' })
  );
  const total = await safeCount(
    db
      .collection(COLLECTIONS.draftCells)
      .where({ jobId: job._id, status: _.in(['MANUAL', 'MATCHED']) })
  );
  const unmatched = (job.unmatchedRows || []).length;
  return { pending: pending.total, confirmed: total.total, unmatched };
}

/** 校对后刷新任务状态（不触碰 PUBLISHED / RECOGNIZING） */
async function refreshJobReviewStatus(jobId) {
  const doc = await db.collection(COLLECTIONS.importJobs).doc(jobId).get();
  const job = doc.data;
  if (!job || job.status === 'PUBLISHED' || job.status === 'RECOGNIZING') {
    return { status: job ? job.status : null, blockers: 0 };
  }
  const b = await computeBlockers(job);
  const blockers = b.pending + b.unmatched;
  const status = job.status === 'FAILED'
    ? 'FAILED'
    : blockers > 0
      ? 'NEEDS_REVIEW'
      : b.confirmed > 0
        ? 'READY'
        : 'NEEDS_REVIEW';
  await db.collection(COLLECTIONS.importJobs).doc(jobId).update({
    data: { status, updatedAt: new Date() },
  });
  return { status, blockers, confirmed: b.confirmed };
}

module.exports = { computeBlockers, refreshJobReviewStatus };
