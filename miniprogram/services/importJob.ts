import { call } from '../utils/cloud';
import type { ImportJob } from '../types/index';

export interface CreateJobInput {
  teamId: string;
  weekStart: string;
  images: Array<{ name: string; size: number }>;
}

export function createJob(input: CreateJobInput): Promise<{ jobId: string; uploadPrefix: string }> {
  return call('import.createJob', input);
}

/** 直接上传到云存储私有路径，返回 fileID */
export async function uploadImage(
  uploadPrefix: string,
  index: number,
  tempFilePath: string,
  ext: string
): Promise<string> {
  const cloudPath = `${uploadPrefix}/${index}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const res = await wx.cloud.uploadFile({ cloudPath, filePath: tempFilePath });
  return res.fileID;
}

export function submitJob(
  jobId: string,
  files: Array<{ name: string; size: number; fileID: string }>
): Promise<{ status: string; duplicateWarning: string | null }> {
  return call('import.submitJob', { jobId, files });
}

export function listJobs(
  teamId: string,
  weekStart: string
): Promise<{ items: ImportJob[] }> {
  return call('import.listJobs', { teamId, weekStart });
}

export function getJob(jobId: string): Promise<ImportJob> {
  return call('import.getJob', { jobId });
}

export function retryFailed(jobId: string, imageId: string): Promise<void> {
  return call('import.retryFailed', { jobId, imageId });
}

export function removeFailedImage(jobId: string, imageId: string, revision: number): Promise<{ revision: number }> {
  return call('import.removeFailedImage', { jobId, imageId, revision });
}

export function getImagePreview(jobId: string, imageId: string): Promise<{ url: string }> {
  return call('import.getImagePreview', { jobId, imageId });
}
