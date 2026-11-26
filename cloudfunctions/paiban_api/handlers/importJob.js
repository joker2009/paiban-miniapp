const crypto = require('crypto');
const { cloud, db, _, COLLECTIONS, getAll, safeGet } = require('../lib/cloud');
const { getIdentity, requireAdmin, assertInTeam } = require('../lib/auth');
const { ERR } = require('../lib/errors');
const { str, arr, int } = require('../lib/validate');
const { isValidDate, weekday, addDays } = require('../lib/date');
const { audit } = require('../lib/audit');

const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES || 10 * 1024 * 1024);
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || '';
const OCR_FUNCTION_NAME = process.env.OCR_FUNCTION_NAME || 'paiban_ocr';

function detectImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: 'png', mime: 'image/png' };
  if (buf.slice(0, 4).toString('ascii') === 'GIF8') return { ext: 'gif', mime: 'image/gif' };
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp' };
  }
  return null;
}

function jobForAdmin(payload) {
  return (async () => {
    const jobId = str(payload.jobId, 'jobId', { min: 1, max: 64 });
    const doc = await db.collection(COLLECTIONS.importJobs).doc(jobId).get().catch(() => null);
    if (!doc || !doc.data) throw ERR.NOT_FOUND('任务不存在');
    const identity = await getIdentity();
    requireAdmin(identity, doc.data.teamId);
    return { identity, job: doc.data, jobId };
  })();
}

async function createJob(payload) {
  const teamId = str(payload.teamId, 'teamId', { min: 1, max: 64 });
  const weekStart = str(payload.weekStart, 'weekStart', { min: 10, max: 10 });
  const identity = await getIdentity();
  requireAdmin(identity, teamId);

  if (!isValidDate(weekStart) || weekday(weekStart) !== 1) {
    throw ERR.INVALID_ARGUMENT('weekStart 必须是周一（YYYY-MM-DD）');
  }
  const images = arr(payload.images, '图片', { min: 1, max: MAX_IMAGES });
  for (const img of images) {
    const size = int(img.size, '图片大小', { min: 1, max: MAX_IMAGE_BYTES });
    if (size > MAX_IMAGE_BYTES) throw ERR.FILE_INVALID('图片超过大小限制');
    str(img.name, '图片名称', { min: 1, max: 120 });
  }

  const teamDoc = await db.collection(COLLECTIONS.teams).doc(teamId).get();
  const added = await db.collection(COLLECTIONS.importJobs).add({
    data: {
      orgId: teamDoc.data.orgId,
      teamId,
      weekStart,
      submitterOpenid: identity.openid,
      status: 'UPLOADING',
      revision: 1,
      images: [],
      unmatchedRows: [],
      duplicateOf: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });

  await audit({
    teamId,
    operatorOpenid: identity.openid,
    action: 'import.createJob',
    refId: added._id,
    summary: `${weekStart} ${images.length} images`,
  });

  return {
    jobId: added._id,
    uploadPrefix: `imports/${teamId}/${added._id}`,
    maxImages: MAX_IMAGES,
    maxImageBytes: MAX_IMAGE_BYTES,
  };
}

async function submitJob(payload) {
  const { identity, job, jobId } = await jobForAdmin(payload);
  if (job.status === 'PUBLISHED') throw ERR.CONFLICT('已发布任务不能重复提交');
  if (job.status === 'RECOGNIZING') throw ERR.CONFLICT('识别进行中，请稍后');

  const files = arr(payload.files, '上传文件', { min: 1, max: MAX_IMAGES });
  const expectedPrefix = `imports/${job.teamId}/${jobId}/`;
  const images = [];
  let duplicateOf = null;

  for (let i = 0; i < files.length; i += 1) {
    const f = files[i];
    const fileID = str(f.fileID, 'fileID', { min: 10, max: 500 });
    const name = str(f.name, '文件名', { min: 1, max: 120 });
    const size = int(f.size, '文件大小', { min: 1, max: MAX_IMAGE_BYTES });

    const pathPart = fileID.includes('/') ? fileID.slice(fileID.indexOf('://') + 3) : fileID;
    if (!pathPart.includes(expectedPrefix)) {
      throw ERR.FILE_INVALID('文件不属于本次任务');
    }

    let buf;
    try {
      const dl = await cloud.downloadFile({ fileID });
      buf = dl.fileContent;
    } catch (e) {
      throw ERR.FILE_INVALID('无法读取上传文件，请重新上传');
    }
    if (!buf || buf.length === 0) throw ERR.FILE_INVALID('上传文件为空');
    if (buf.length > MAX_IMAGE_BYTES) throw ERR.FILE_INVALID('图片超过大小限制');
    const kind = detectImage(buf);
    if (!kind) throw ERR.FILE_INVALID('文件不是有效图片');

    const hash = crypto.createHash('sha256').update(buf).digest('hex');

    if (!duplicateOf) {
      const dup = await safeGet(
        db
          .collection(COLLECTIONS.importJobs)
          .where({ teamId: job.teamId, weekStart: job.weekStart, duplicateOf: null })
          .limit(50)
      );
      const hit = dup.data.find(
        (j) => j._id !== jobId && (j.images || []).some((im) => im.hash === hash)
      );
      if (hit) duplicateOf = hit._id;
    }

    images.push({
      id: `img_${i + 1}`,
      name,
      size: buf.length,
      hash,
      fileID,
      status: 'UPLOADED',
      error: null,
    });
  }

  await db.collection(COLLECTIONS.importJobs).doc(jobId).update({
    data: {
      images,
      duplicateOf,
      status: 'PENDING_OCR',
      error: null,
      updatedAt: new Date(),
      submittedAt: new Date(),
    },
  });

  await audit({
    teamId: job.teamId,
    operatorOpenid: identity.openid,
    action: 'import.submitJob',
    refId: jobId,
    summary: `${images.length} images`,
  });

  // 触发异步识别：定时触发器会兜底，这里只做尽力而为的即时唤醒
  if (INTERNAL_TOKEN) {
    cloud.callFunction({ name: OCR_FUNCTION_NAME, data: { jobId, token: INTERNAL_TOKEN } }).catch((e) => {
      console.warn('[import] wake ocr failed', e && e.message);
    });
  }

  return {
    status: 'PENDING_OCR',
    duplicateWarning: duplicateOf ? '该图片内容与本周已有导入重复，可在校对页放弃本次任务' : null,
  };
}

async function listJobs(payload) {
  const teamId = str(payload.teamId, 'teamId', { min: 1, max: 64 });
  const weekStart = str(payload.weekStart, 'weekStart', { min: 10, max: 10 });
  const identity = await getIdentity();
  requireAdmin(identity, teamId);
  if (!isValidDate(weekStart)) throw ERR.INVALID_ARGUMENT('weekStart 不合法');

  const res = await safeGet(
    db
      .collection(COLLECTIONS.importJobs)
      .where({ teamId, weekStart })
      .orderBy('createdAt', 'desc')
      .limit(50)
  );
  return { items: res.data };
}

async function getJob(payload) {
  const { job } = await jobForAdmin(payload);
  return job;
}

async function retryFailed(payload) {
  const { identity, job, jobId } = await jobForAdmin(payload);
  const imageId = str(payload.imageId, 'imageId', { min: 1, max: 40 });
  if (job.status === 'PUBLISHED') throw ERR.CONFLICT('已发布任务不能重试');
  const images = (job.images || []).map((im) =>
    im.id === imageId && im.status === 'OCR_FAILED'
      ? { ...im, status: 'UPLOADED', error: null }
      : im
  );
  if (!images.some((im) => im.id === imageId && im.status === 'UPLOADED')) {
    throw ERR.CONFLICT('该图片不在失败状态');
  }

  await db.collection(COLLECTIONS.importJobs).doc(jobId).update({
    data: { images, status: 'PENDING_OCR', error: null, updatedAt: new Date() },
  });

  await audit({
    teamId: job.teamId,
    operatorOpenid: identity.openid,
    action: 'import.retryFailed',
    refId: jobId,
    summary: imageId,
  });

  if (INTERNAL_TOKEN) {
    cloud.callFunction({ name: OCR_FUNCTION_NAME, data: { jobId, token: INTERNAL_TOKEN } }).catch(() => {});
  }
  return {};
}

async function removeFailedImage(payload) {
  const { identity, job, jobId } = await jobForAdmin(payload);
  const imageId = str(payload.imageId, 'imageId', { min: 1, max: 40 });
  const revision = int(payload.revision, 'revision', { min: 1, max: 1e9 });
  if (revision !== job.revision) throw ERR.DRAFT_CONFLICT();

  const idx = (job.images || []).findIndex((im) => im.id === imageId);
  if (idx < 0) throw ERR.NOT_FOUND('图片不存在');
  if (job.images[idx].status !== 'OCR_FAILED') throw ERR.CONFLICT('只能移除失败的图片');

  const images = job.images.filter((im) => im.id !== imageId);
  // 移除该页对应的草稿单元格
  const cells = await getAll(db.collection(COLLECTIONS.draftCells).where({ jobId }));
  for (const c of cells) {
    if (c.pageIndex === idx) {
      await db.collection(COLLECTIONS.draftCells).doc(c._id).remove();
    }
  }

  const nextRevision = job.revision + 1;
  const status = images.length === 0 ? 'FAILED' : 'NEEDS_REVIEW';
  await db.collection(COLLECTIONS.importJobs).doc(jobId).update({
    data: {
      images,
      revision: nextRevision,
      status,
      error: images.length === 0 ? '没有可用图片，请重新导入' : null,
      updatedAt: new Date(),
    },
  });

  await audit({
    teamId: job.teamId,
    operatorOpenid: identity.openid,
    action: 'import.removeFailedImage',
    refId: jobId,
    summary: imageId,
  });

  return { revision: nextRevision };
}

async function getImagePreview(payload) {
  const { identity, job, jobId } = await jobForAdmin(payload);
  const imageId = str(payload.imageId, 'imageId', { min: 1, max: 40 });
  const image = (job.images || []).find((im) => im.id === imageId);
  if (!image) throw ERR.NOT_FOUND('图片不存在');

  const res = await cloud.getTempFileURL({ fileList: [image.fileID] });
  const item = res.fileList && res.fileList[0];
  if (!item || !item.tempFileURL) throw ERR.INTERNAL('预览地址获取失败');
  await audit({
    teamId: job.teamId,
    operatorOpenid: identity.openid,
    action: 'import.preview',
    refId: jobId,
    summary: imageId,
  });
  return { url: item.tempFileURL };
}

module.exports = {
  createJob,
  submitJob,
  listJobs,
  getJob,
  retryFailed,
  removeFailedImage,
  getImagePreview,
};
