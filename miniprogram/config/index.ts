/** 云开发环境 ID，替换为你自己的环境 ID（保持测试/生产分开） */
export const CLOUD_ENV_ID = 'REPLACE_WITH_CLOUD_ENV_ID';

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
