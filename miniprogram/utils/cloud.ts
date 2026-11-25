/** 云函数统一调用封装：单一入口 api，按 op 路由。 */

export interface CloudError extends Error {
  code: string;
  requestId?: string;
}

export class AppError extends Error {
  code: string;
  requestId?: string;
  constructor(code: string, message: string, requestId?: string) {
    super(message);
    this.code = code;
    this.requestId = requestId;
  }
}

export async function call<T = any>(op: string, data: Record<string, any> = {}): Promise<T> {
  let res: any;
  try {
    res = await wx.cloud.callFunction({
      name: 'api',
      data: { op, payload: data },
    });
  } catch (e: any) {
    console.error(`[cloud] ${op} 调用失败`, e);
    throw new AppError('NETWORK_ERROR', '网络异常，请稍后重试');
  }

  const result = res?.result;
  if (!result || typeof result !== 'object') {
    throw new AppError('BAD_RESPONSE', '服务返回异常');
  }
  if (result.ok === true) {
    return result.data as T;
  }
  throw new AppError(
    result.code || 'UNKNOWN',
    result.message || '操作失败，请稍后重试',
    result.requestId
  );
}

/** 统一展示错误（不暴露内部堆栈） */
export function toastError(e: any, fallback = '操作失败'): void {
  const msg = (e && (e.message as string)) || fallback;
  wx.showToast({ title: msg.slice(0, 30), icon: 'none', duration: 2500 });
}

/** 把云存储 fileID 转临时预览地址 */
export async function filePreviewUrl(fileID: string): Promise<string> {
  const res = await wx.cloud.getTempFileURL({ fileList: [fileID] });
  const item = res.fileList?.[0];
  if (!item || !item.tempFileURL) {
    throw new AppError('PREVIEW_FAILED', '图片预览地址获取失败');
  }
  return item.tempFileURL;
}
