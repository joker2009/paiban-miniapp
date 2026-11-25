import { call } from '../utils/cloud';
import type { ReleasePreview } from '../types/index';

export function preview(jobId: string, revision: number): Promise<ReleasePreview> {
  return call('release.preview', { jobId, revision });
}

export function publish(input: {
  jobId: string;
  revision: number;
  baseVersion: number;
  requestId: string;
  note?: string;
}): Promise<{ releaseId: string; version: number }> {
  return call('release.publish', input);
}

export interface ReleaseHistoryItem {
  releaseId: string;
  version: number;
  baseVersion: number;
  publishedAt: string;
  operatorName: string;
  summary: { added: number; modified: number; removed: number; unchanged: number };
  note: string;
}

export function listHistory(
  teamId: string,
  weekStart: string
): Promise<{ items: ReleaseHistoryItem[] }> {
  return call('release.listHistory', { teamId, weekStart });
}
