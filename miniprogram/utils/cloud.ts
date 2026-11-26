/** 云函数统一调用封装：单一入口 api，按 op 路由；支持自有环境与共享环境。 */

import {
  CLOUD_ENV_ID,
  RESOURCE_APPID,
  USE_SHARED_CLOUD,
  API_FUNCTION_NAME,
} from '../config/index';

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

let sharedCloud: any = null;
let initPromise: Promise<void> | null = null;
let localReady = false;

/**
 * 初始化云能力。
 * 共享环境必须等 init 完成后再调用 callFunction/uploadFile。
 */
export function initCloud(): Promise<void> {
  if (!USE_SHARED_CLOUD) {
    if (!localReady) {
      wx.cloud.init({ env: CLOUD_ENV_ID, traceUser: true });
      localReady = true;
    }
    return Promise.resolve();
  }

  if (!RESOURCE_APPID || RESOURCE_APPID.indexOf('REPLACE_') === 0) {
    return Promise.reject(
      new AppError('CLOUD_CONFIG', '未配置资源方 AppID，请检查 config/index.ts')
    );
  }

  if (!sharedCloud) {
    const CloudCtor = (wx.cloud as any).Cloud;
    if (typeof CloudCtor !== 'function') {
      return Promise.reject(new AppError('CLOUD_VERSION', '当前微信版本不支持环境共享'));
    }
    sharedCloud = new CloudCtor({
      resourceAppid: RESOURCE_APPID,
      resourceEnv: CLOUD_ENV_ID,
    });
  }

  if (!initPromise) {
    initPromise = sharedCloud
      .init()
      .catch((e: any) => {
        initPromise = null;
        console.error('[cloud] 共享环境初始化失败', e);
        throw new AppError('CLOUD_INIT', '云环境初始化失败，请稍后重试');
      });
  }
  return initPromise as Promise<void>;
}

function getCloud(): any {
  return USE_SHARED_CLOUD ? sharedCloud : wx.cloud;
}

export async function call<T = any>(op: string, data: Record<string, any> = {}): Promise<T> {
  let res: any;
  try {
    await initCloud();
    res = await getCloud().callFunction({
      name: API_FUNCTION_NAME,
      data: { op, payload: data },
    });
  } catch (e: any) {
    if (e instanceof AppError) throw e;
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

/** 上传文件，返回 fileID（共享环境走资源方存储） */
export async function uploadFile(cloudPath: string, filePath: string): Promise<string> {
  await initCloud();
  const res = await getCloud().uploadFile({ cloudPath, filePath });
  if (!res || !res.fileID) throw new AppError('UPLOAD_FAILED', '文件上传失败');
  return res.fileID;
}

/** 把云存储 fileID 转临时预览地址 */
export async function filePreviewUrl(fileID: string): Promise<string> {
  await initCloud();
  const res = await getCloud().getTempFileURL({ fileList: [fileID] });
  const item = res.fileList?.[0];
  if (!item || !item.tempFileURL) {
    throw new AppError('PREVIEW_FAILED', '图片预览地址获取失败');
  }
  return item.tempFileURL;
}
