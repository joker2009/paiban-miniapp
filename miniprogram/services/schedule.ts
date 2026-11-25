import { call } from '../utils/cloud';
import type { ScheduleMineResult } from '../types/index';

export function getMine(from: string, to: string): Promise<ScheduleMineResult> {
  return call('schedule.getMine', { from, to });
}
