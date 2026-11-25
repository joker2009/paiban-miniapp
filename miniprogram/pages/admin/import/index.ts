import { createJob, uploadImage, submitJob } from '../../../services/importJob';
import { toastError } from '../../../utils/cloud';
import { MAX_IMAGES_PER_JOB, MAX_IMAGE_BYTES } from '../../../config/index';

interface PickedFile {
  name: string;
  size: number;
  sizeText: string;
  path: string;
  ext: string;
}

Page({
  data: {
    teamId: '',
    weekStart: '',
    files: [] as PickedFile[],
    uploading: false,
    progressText: '',
    maxCount: MAX_IMAGES_PER_JOB,
    maxSizeText: '10MB',
  },

  _jobId: '',
  _uploadPrefix: '',
  _filesSignature: '',

  onLoad(options: Record<string, string>) {
    this.setData({
      teamId: options.teamId || '',
      weekStart: options.weekStart || '',
    });
  },

  /** 主入口：从微信聊天选择图片（用户手动选图，不读取聊天记录） */
  chooseFromChat() {
    const remain = MAX_IMAGES_PER_JOB - this.data.files.length;
    if (remain <= 0) {
      wx.showToast({ title: `每批最多 ${MAX_IMAGES_PER_JOB} 张`, icon: 'none' });
      return;
    }
    wx.chooseMessageFile({
      count: remain,
      type: 'image',
      success: (res) => {
        const picked = res.tempFiles.map((f, i) => this.toPicked(f.path, f.size, f.name, i));
        this.addFiles(picked);
      },
      fail: (err) => {
        if (String(err.errMsg).indexOf('cancel') < 0) {
          wx.showToast({ title: '选图失败，请重试', icon: 'none' });
        }
      },
    });
  },

  /** 备用入口：从相册选择 */
  chooseFromAlbum() {
    const remain = MAX_IMAGES_PER_JOB - this.data.files.length;
    if (remain <= 0) {
      wx.showToast({ title: `每批最多 ${MAX_IMAGES_PER_JOB} 张`, icon: 'none' });
      return;
    }
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sourceType: ['album'],
      sizeType: ['original', 'compressed'],
      success: (res) => {
        const picked = res.tempFiles.map((f, i) => this.toPicked(f.tempFilePath, f.size, '', i));
        this.addFiles(picked);
      },
      fail: (err) => {
        if (String(err.errMsg).indexOf('cancel') < 0) {
          wx.showToast({ title: '选图失败，请重试', icon: 'none' });
        }
      },
    });
  },

  toPicked(path: string, size: number, name: string, index: number): PickedFile {
    const m = /\.(jpe?g|png|webp|gif)$/i.exec(name || path);
    const ext = m ? m[1].toLowerCase() : 'jpg';
    return {
      name: name || `排班图${index + 1}.${ext}`,
      size,
      sizeText: `${(size / 1024 / 1024).toFixed(2)}MB`,
      path,
      ext,
    };
  },

  addFiles(picked: PickedFile[]) {
    const accepted: PickedFile[] = [];
    for (const f of picked) {
      if (f.size > MAX_IMAGE_BYTES) {
        wx.showToast({ title: `${f.name} 超过 ${this.data.maxSizeText}`, icon: 'none' });
        continue;
      }
      if (this.data.files.length + accepted.length >= MAX_IMAGES_PER_JOB) {
        wx.showToast({ title: `每批最多 ${MAX_IMAGES_PER_JOB} 张`, icon: 'none' });
        break;
      }
      accepted.push(f);
    }
    if (accepted.length === 0) return;
    this.setData({ files: this.data.files.concat(accepted) });
    this.resetJob();
  },

  removeFile(e: WechatMiniprogram.TouchEvent) {
    const idx = Number(e.currentTarget.dataset.index);
    const files = this.data.files.slice();
    files.splice(idx, 1);
    this.setData({ files });
    this.resetJob();
  },

  moveUp(e: WechatMiniprogram.TouchEvent) {
    const idx = Number(e.currentTarget.dataset.index);
    if (idx <= 0) return;
    const files = this.data.files.slice();
    [files[idx - 1], files[idx]] = [files[idx], files[idx - 1]];
    this.setData({ files });
    this.resetJob();
  },

  moveDown(e: WechatMiniprogram.TouchEvent) {
    const idx = Number(e.currentTarget.dataset.index);
    const files = this.data.files.slice();
    if (idx >= files.length - 1) return;
    [files[idx + 1], files[idx]] = [files[idx], files[idx + 1]];
    this.setData({ files });
    this.resetJob();
  },

  resetJob() {
    this._jobId = '';
    this._uploadPrefix = '';
    this._filesSignature = '';
  },

  signatures(): string {
    return this.data.files.map((f) => `${f.name}:${f.size}`).join('|');
  },

  async onSubmit() {
    if (this.data.uploading) return;
    const { files, teamId, weekStart } = this.data;
    if (!teamId || !weekStart) {
      wx.showToast({ title: '缺少团队或周次参数', icon: 'none' });
      return;
    }
    if (files.length === 0) {
      wx.showToast({ title: '请先选择排班图', icon: 'none' });
      return;
    }

    this.setData({ uploading: true, progressText: '创建导入任务…' });
    try {
      // 复用未提交成功的任务，避免重复建任务
      if (!this._jobId || this._filesSignature !== this.signatures()) {
        const created = await createJob({
          teamId,
          weekStart,
          images: files.map((f) => ({ name: f.name, size: f.size })),
        });
        this._jobId = created.jobId;
        this._uploadPrefix = created.uploadPrefix;
        this._filesSignature = this.signatures();
      }

      const uploaded: Array<{ name: string; size: number; fileID: string }> = [];
      for (let i = 0; i < files.length; i += 1) {
        const f = files[i];
        this.setData({ progressText: `上传第 ${i + 1}/${files.length} 张…` });
        const fileID = await uploadImage(this._uploadPrefix, i, f.path, f.ext);
        uploaded.push({ name: f.name, size: f.size, fileID });
      }

      this.setData({ progressText: '提交识别…' });
      const submitted = await submitJob(this._jobId, uploaded);
      if (submitted.duplicateWarning) {
        wx.showModal({
          title: '疑似重复导入',
          content: submitted.duplicateWarning,
          showCancel: false,
        });
      } else {
        wx.showToast({ title: '已提交识别', icon: 'success' });
      }
      const jobId = this._jobId;
      this.resetJob();
      setTimeout(() => {
        wx.redirectTo({
          url: `/pages/admin/review/index?jobId=${jobId}&teamId=${teamId}&weekStart=${weekStart}`,
        });
      }, 600);
    } catch (e: any) {
      toastError(e, '提交失败，可重试');
      this.setData({ progressText: '' });
    } finally {
      this.setData({ uploading: false });
    }
  },

  onCancel() {
    // 取消选图 / 返回：不创建任务、不上传
    wx.navigateBack();
  },
});
