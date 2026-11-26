/** 云开发环境 ID（自有环境或资源方共享环境） */
export const CLOUD_ENV_ID = 'cloud1-d3g9916cz3b402499';

/**
 * true：使用「环境共享」模式，通过 wx.cloud.Cloud 访问资源方小程序的环境；
 * false：使用当前 AppID 自己创建的云开发环境。
 */
export const USE_SHARED_CLOUD = true;

/** 资源方小程序 AppID（环境 cloud1-d3g9916cz3b402499 的所属小程序） */
export const RESOURCE_APPID = 'wxf641bd4dfe019562';

/** 业务云函数名（共享环境里若与资源方函数重名，改这里并重命名函数目录） */
export const API_FUNCTION_NAME = 'paiban_api';

/** 每批最多图片数（服务端会再次校验） */
export const MAX_IMAGES_PER_JOB = 5;
/** 单图大小上限（字节），与云端 OCR 限制保持一致 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 日历提醒提前量（秒），30 分钟 */
export const CALENDAR_ALARM_OFFSET = 1800;

/** 本机添加记录缓存键 */
export const LOCAL_ADD_STORAGE_KEY = 'paiban.localCalendarAdds.v1';

/** 默认查询范围（天） */
export const SCHEDULE_QUERY_DAYS = 14;
/** 服务端允许的最大查询范围（天） */
export const SCHEDULE_MAX_DAYS = 31;
