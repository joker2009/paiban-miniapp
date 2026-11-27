import { call } from '../utils/cloud';
import type { MeInfo } from '../types/index';

export function getMe(): Promise<MeInfo> {
  return call<MeInfo>('auth.getMe');
}

export function bindInvite(inviteCode: string): Promise<{ employeeId: string; teamId: string }> {
  return call('auth.bindInvite', { inviteCode });
}

export interface BindableEmployee {
  employeeId: string;
  employeeNo: string;
  name: string;
  teamId: string;
  teamName: string;
  bound: boolean;
  boundToMe: boolean;
}

/** 管理员可绑定的员工（仅其管理团队） */
export function listBindableEmployees(): Promise<{ items: BindableEmployee[] }> {
  return call('auth.listBindableEmployees');
}

/** 管理员直接绑定自己到某条员工记录 */
export function bindSelf(employeeId: string): Promise<{ employeeId: string; teamId: string }> {
  return call('auth.bindSelf', { employeeId });
}

/** 管理员一键创建员工并绑定自己（免邀请码） */
export function createSelfEmployee(input: {
  name: string;
  employeeNo?: string;
}): Promise<{ employeeId: string; teamId: string; employeeNo: string; name: string }> {
  return call('auth.createSelfEmployee', input);
}
