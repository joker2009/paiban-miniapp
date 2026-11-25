import { call } from '../utils/cloud';
import type { Employee, ShiftType } from '../types/index';

export function listEmployees(
  teamId: string,
  cursor?: string
): Promise<{ items: Employee[]; nextCursor: string | null }> {
  return call('admin.listEmployees', { teamId, cursor: cursor || null });
}

export function saveEmployee(input: {
  teamId: string;
  employeeId?: string;
  employeeNo: string;
  name: string;
  status?: 'ACTIVE' | 'DISABLED';
}): Promise<{ employeeId: string }> {
  return call('admin.saveEmployee', input);
}

export function issueInvite(employeeId: string): Promise<{ inviteId: string; inviteCode: string; expiresAt: string }> {
  return call('admin.issueInvite', { employeeId });
}

export function revokeInvite(inviteId: string): Promise<void> {
  return call('admin.revokeInvite', { inviteId });
}

export interface InviteInfo {
  inviteId: string;
  employeeId: string;
  employeeName: string;
  expiresAt: string;
}

export function listInvites(teamId: string): Promise<{ items: InviteInfo[] }> {
  return call('admin.listInvites', { teamId });
}

export function listShiftTypes(teamId: string): Promise<{ items: ShiftType[] }> {
  return call('admin.listShiftTypes', { teamId });
}

export function saveShiftType(input: {
  teamId: string;
  shiftTypeId?: string;
  code: string;
  label: string;
  aliases: string[];
  category: 'WORK' | 'OFF' | 'STUDY';
  startLocal: string | null;
  endLocal: string | null;
  endDayOffset: 0 | 1;
  reminderEnabled: boolean;
  enabled: boolean;
  revision?: number;
}): Promise<{ shiftTypeId: string; revision: number }> {
  return call('admin.saveShiftType', input);
}
