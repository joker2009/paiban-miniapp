export type Role = 'ADMIN' | 'EMPLOYEE' | 'NONE';

export interface MeInfo {
  openid: string;
  roles: Role[];
  employee: {
    employeeId: string;
    employeeNo: string;
    name: string;
    teamId: string;
    teamName: string;
    status: 'ACTIVE' | 'DISABLED';
  } | null;
  adminTeams: Array<{ teamId: string; teamName: string }>;
}

export interface ShiftType {
  _id: string;
  teamId: string;
  code: string;
  label: string;
  aliases: string[];
  category: 'WORK' | 'OFF' | 'STUDY';
  startLocal: string | null;
  endLocal: string | null;
  endDayOffset: 0 | 1;
  reminderEnabled: boolean;
  revision: number;
  enabled: boolean;
}

export interface Employee {
  _id: string;
  employeeNo: string;
  name: string;
  status: 'ACTIVE' | 'DISABLED';
  bound: boolean;
}

export interface MyShift {
  workDate: string;
  shiftCode: string;
  label: string;
  category: 'WORK' | 'OFF' | 'STUDY';
  status: 'WORKING' | 'OFF' | 'STUDY';
  startAt: string | null;
  endAt: string | null;
  reminderEnabled: boolean;
  releaseVersion: number;
  publishedAt: string;
}

export interface ScheduleMineResult {
  teamId: string;
  teamName: string;
  timezone: string;
  from: string;
  to: string;
  shifts: MyShift[];
  /** 上一次发布之后发生的变更日期（用于“调班标记”） */
  changedDates: string[];
  lastPublishedAt: string | null;
}

export interface ImportImage {
  id: string;
  name: string;
  size: number;
  hash: string;
  fileID: string;
  status: 'UPLOADED' | 'OCR_RUNNING' | 'OCR_DONE' | 'OCR_FAILED';
  error?: string;
}

export interface ImportJob {
  _id: string;
  teamId: string;
  weekStart: string;
  status: ImportJobStatus;
  revision: number;
  images: ImportImage[];
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export type ImportJobStatus =
  | 'UPLOADING'
  | 'PENDING_OCR'
  | 'RECOGNIZING'
  | 'NEEDS_REVIEW'
  | 'READY'
  | 'PUBLISHED'
  | 'FAILED';

export interface DraftCell {
  _id: string;
  jobId: string;
  rowKey: string;
  employeeId: string | null;
  employeeNo: string | null;
  employeeName: string | null;
  workDate: string | null;
  rawText: string;
  shiftCode: string | null;
  cleared: boolean;
  status: 'MATCHED' | 'NEEDS_REVIEW' | 'MANUAL';
  issues: string[];
  pageIndex: number;
  rect: { x: number; y: number; w: number; h: number } | null;
}

export interface ReleasePreview {
  baseVersion: number;
  added: number;
  modified: number;
  removed: number;
  unchanged: number;
  blockers: Array<{ cellId?: string; reason: string }>;
  canPublish: boolean;
}
