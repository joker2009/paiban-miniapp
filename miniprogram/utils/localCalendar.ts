import { LOCAL_ADD_STORAGE_KEY, CALENDAR_ALARM_OFFSET } from '../config/index';

/**
 * 本机添加记录：仅证明“在本机发起并成功写入了日历”，不代表日历当前状态。
 * 指纹覆盖标题、起止时刻与提醒提前量，整周重发不会把未变更班次判为已改。
 */

export interface LocalAddRecord {
  key: string;
  employeeId: string;
  workDate: string;
  shiftCode: string;
  title: string;
  startAt: string;
  endAt: string;
  fingerprint: string;
  addedAt: string;
}

interface Store {
  [key: string]: LocalAddRecord;
}

function readStore(): Store {
  try {
    return wx.getStorageSync(LOCAL_ADD_STORAGE_KEY) || {};
  } catch (e) {
    return {};
  }
}

function writeStore(store: Store): void {
  try {
    wx.setStorageSync(LOCAL_ADD_STORAGE_KEY, store);
  } catch (e) {
    console.warn('[localCalendar] 写入本机记录失败', e);
  }
}

export function makeKey(employeeId: string, workDate: string): string {
  return `${employeeId}_${workDate}`;
}

export function fingerprint(title: string, startAt: string, endAt: string, offset = CALENDAR_ALARM_OFFSET): string {
  return `${title}|${startAt}|${endAt}|${offset}`;
}

export function getRecord(employeeId: string, workDate: string): LocalAddRecord | null {
  const store = readStore();
  return store[makeKey(employeeId, workDate)] || null;
}

export function saveRecord(rec: Omit<LocalAddRecord, 'key' | 'addedAt'>): void {
  const store = readStore();
  const key = makeKey(rec.employeeId, rec.workDate);
  store[key] = { ...rec, key, addedAt: new Date().toISOString() };
  writeStore(store);
}

/**
 * 本机旧记录是否已与当前排班不一致：
 * 返回 'STALE'（班次变了）| 'REMOVED'（已被清除）| 'SAME'（一致）
 */
export function localStatus(
  employeeId: string,
  workDate: string,
  current: { title: string; startAt: string; endAt: string } | null
): 'STALE' | 'REMOVED' | 'SAME' | 'NONE' {
  const rec = getRecord(employeeId, workDate);
  if (!rec) return 'NONE';
  if (!current) return 'REMOVED';
  const fp = fingerprint(current.title, current.startAt, current.endAt);
  return rec.fingerprint === fp ? 'SAME' : 'STALE';
}
