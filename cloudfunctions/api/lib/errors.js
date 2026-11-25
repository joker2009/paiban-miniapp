class AppError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

const ERR = {
  FORBIDDEN: (msg = '无权执行该操作') => new AppError('FORBIDDEN', msg),
  UNAUTHORIZED: (msg = '请先登录') => new AppError('UNAUTHORIZED', msg),
  INVALID_ARGUMENT: (msg = '参数不合法') => new AppError('INVALID_ARGUMENT', msg),
  NOT_FOUND: (msg = '数据不存在') => new AppError('NOT_FOUND', msg),
  INVITE_INVALID: () => new AppError('INVITE_INVALID', '邀请码无效或已过期'),
  FILE_INVALID: (msg = '文件校验失败') => new AppError('FILE_INVALID', msg),
  OCR_FAILED: (msg = '识别失败，可稍后重试') => new AppError('OCR_FAILED', msg),
  REVIEW_REQUIRED: (msg = '存在未解决异常，暂不可发布') => new AppError('REVIEW_REQUIRED', msg),
  DRAFT_CONFLICT: () => new AppError('DRAFT_CONFLICT', '草稿已在别处更新，请刷新后重试'),
  VERSION_CONFLICT: () => new AppError('VERSION_CONFLICT', '已有新版本发布，请刷新差异后重试'),
  CONFLICT: (msg = '数据冲突') => new AppError('CONFLICT', msg),
  INTERNAL: (msg = '服务内部错误') => new AppError('INTERNAL', msg),
};

module.exports = { AppError, ERR };
