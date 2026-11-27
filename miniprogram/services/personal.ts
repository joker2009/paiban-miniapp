import { call } from '../utils/cloud';

export interface ShiftDef {
  label: string;
  category: 'WORK' | 'OFF' | 'STUDY';
  startLocal: string | null;
  endLocal: string | null;
  endDayOffset: number;
  reminderEnabled: boolean;
}

export interface PersonalShift {
  workDate: string;
  label: string;
  category: 'WORK' | 'OFF' | 'STUDY';
  startLocal: string | null;
  endLocal: string | null;
  endDayOffset: number;
  startAt: string | null;
  endAt: string | null;
  reminderEnabled: boolean;
  weekStart: string;
  employeeName?: string;
  employeeNo?: string;
}

export interface UserProfile {
  employeeName?: string;
  employeeNo?: string;
  shiftTypes?: ShiftDef[];
}

export interface RecognizeCell {
  date: string | null;
  text: string;
  confidence: number | null;
}

export interface RecognizeRow {
  employeeNo: string;
  name: string;
  cells: RecognizeCell[];
}

export interface RecognizeResult {
  weekStart: string;
  dates: string[];
  rows: RecognizeRow[];
  notes: string;
}

export function getMine(
  from: string,
  to: string
): Promise<{ openid: string; from: string; to: string; shifts: PersonalShift[]; profile: UserProfile | null }> {
  return call('personal.getMine', { from, to });
}

export function saveWeek(input: {
  weekStart: string;
  employeeName: string;
  employeeNo?: string;
  /** 本次导入覆盖的日期（含被清空的日期） */
  dates?: string[];
  shifts: Array<{
    workDate: string;
    label: string;
    category: 'WORK' | 'OFF' | 'STUDY';
    startLocal?: string | null;
    endLocal?: string | null;
    endDayOffset?: number;
    reminderEnabled?: boolean;
  }>;
  shiftTypes: ShiftDef[];
}): Promise<{ weekStart: string; count: number }> {
  return call('personal.saveWeek', input);
}

export interface RecognizeTask {
  taskId: string;
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED';
  weekStart: string;
  dates: string[] | null;
  rows: RecognizeRow[] | null;
  notes: string;
  error: string | null;
}

/** 创建异步识别任务，返回 taskId */
export function recognize(
  fileID: string,
  weekStart: string
): Promise<{ taskId: string; status: string }> {
  return call('personal.recognize', { fileID, weekStart });
}

/** 轮询识别任务结果 */
export function getRecognizeTask(taskId: string): Promise<RecognizeTask> {
  return call('personal.getRecognizeTask', { taskId });
}

export interface ShiftInput {
  workDate: string;
  label: string;
  category: 'WORK' | 'OFF' | 'STUDY';
  startLocal?: string | null;
  endLocal?: string | null;
  endDayOffset?: number;
  reminderEnabled?: boolean;
}

/** 编辑/新增单条班次 */
export function saveShift(input: ShiftInput): Promise<{ shift: PersonalShift; weekStart: string }> {
  return call('personal.saveShift', input);
}

/** 删除某天班次 */
export function deleteShift(workDate: string): Promise<{ deleted: boolean }> {
  return call('personal.deleteShift', { workDate });
}

export function getProfile(): Promise<{ openid: string; profile: UserProfile | null }> {
  return call('personal.getProfile');
}

export function saveProfile(input: {
  name: string;
  employeeNo?: string;
}): Promise<{ profile: UserProfile }> {
  return call('personal.saveProfile', input);
}
