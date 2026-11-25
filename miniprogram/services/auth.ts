import { call } from '../utils/cloud';
import type { MeInfo } from '../types/index';

export function getMe(): Promise<MeInfo> {
  return call<MeInfo>('auth.getMe');
}

export function bindInvite(inviteCode: string): Promise<{ employeeId: string; teamId: string }> {
  return call('auth.bindInvite', { inviteCode });
}
