import { call } from '../utils/cloud';
import type { DraftCell } from '../types/index';

export interface UnmatchedRow {
  rowKey: string;
  employeeNo: string;
  employeeName: string;
  cellCount: number;
}

export function listCells(
  jobId: string
): Promise<{ jobId: string; revision: number; cells: DraftCell[]; unmatchedRows: UnmatchedRow[] }> {
  return call('draft.listCells', { jobId });
}

/** 把一整行 OCR 结果关联到花名册员工（应用于该行所有单元格） */
export function linkRow(
  jobId: string,
  revision: number,
  rowKey: string,
  employeeId: string
): Promise<{ revision: number }> {
  return call('draft.linkRow', { jobId, revision, rowKey, employeeId });
}

export interface CellPatch {
  cellId: string;
  /** 设置班次 */
  shiftCode?: string | null;
  /** 显式清除（确认为未排班） */
  cleared?: boolean;
  /** 关联员工（管理员手动修正） */
  employeeId?: string | null;
}

export function saveCells(
  jobId: string,
  revision: number,
  patches: CellPatch[]
): Promise<{ revision: number; blockers: number }> {
  return call('draft.saveCells', { jobId, revision, patches });
}
