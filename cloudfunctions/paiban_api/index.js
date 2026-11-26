const crypto = require('crypto');
const { cloud } = require('./lib/cloud');
const { AppError } = require('./lib/errors');

const handlers = {
  'auth.getMe': require('./handlers/auth').getMe,
  'auth.bindInvite': require('./handlers/auth').bindInvite,
  'auth.listBindableEmployees': require('./handlers/auth').listBindableEmployees,
  'auth.bindSelf': require('./handlers/auth').bindSelf,

  'admin.listEmployees': require('./handlers/admin').listEmployees,
  'admin.saveEmployee': require('./handlers/admin').saveEmployee,
  'admin.issueInvite': require('./handlers/admin').issueInvite,
  'admin.revokeInvite': require('./handlers/admin').revokeInvite,
  'admin.listInvites': require('./handlers/admin').listInvites,
  'admin.listShiftTypes': require('./handlers/admin').listShiftTypes,
  'admin.saveShiftType': require('./handlers/admin').saveShiftType,

  'import.createJob': require('./handlers/importJob').createJob,
  'import.submitJob': require('./handlers/importJob').submitJob,
  'import.listJobs': require('./handlers/importJob').listJobs,
  'import.getJob': require('./handlers/importJob').getJob,
  'import.retryFailed': require('./handlers/importJob').retryFailed,
  'import.removeFailedImage': require('./handlers/importJob').removeFailedImage,
  'import.getImagePreview': require('./handlers/importJob').getImagePreview,

  'draft.listCells': require('./handlers/draft').listCells,
  'draft.saveCells': require('./handlers/draft').saveCells,
  'draft.linkRow': require('./handlers/draft').linkRow,

  'release.preview': require('./handlers/release').preview,
  'release.publish': require('./handlers/release').publish,
  'release.listHistory': require('./handlers/release').listHistory,

  'schedule.getMine': require('./handlers/schedule').getMine,
};

exports.main = async (event) => {
  const requestId = `req_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const op = event && event.op;
  const payload = (event && event.payload) || {};

  const handler = handlers[op];
  if (!handler) {
    return { ok: false, code: 'NOT_FOUND', message: '未知操作', requestId };
  }

  try {
    const data = await handler(payload, { requestId, cloud });
    return { ok: true, data, requestId };
  } catch (err) {
    if (err instanceof AppError) {
      if (err.code === 'INTERNAL') console.error(`[api] ${op} internal`, requestId, err);
      return {
        ok: false,
        code: err.code,
        message: err.message,
        requestId,
        ...(err.extra || {}),
      };
    }
    console.error(`[api] ${op} unhandled`, requestId, err && err.stack ? err.stack : err);
    // 不向前端泄露堆栈与内部信息
    return { ok: false, code: 'INTERNAL', message: '服务繁忙，请稍后重试', requestId };
  }
};
