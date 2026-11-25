import { getJob, getImagePreview, retryFailed, removeFailedImage } from '../../../services/importJob';
import { listCells, saveCells, linkRow, type UnmatchedRow } from '../../../services/draft';
import { preview, publish } from '../../../services/release';
import { listShiftTypes, listEmployees } from '../../../services/admin';
import { toastError } from '../../../utils/cloud';
import type { ImportJob, DraftCell, ShiftType, Employee, ReleasePreview } from '../../../types/index';

interface CellView {
  _id: string;
  employeeId: string | null;
  dateText: string;
  employeeText: string;
  rawText: string;
  shiftCode: string | null;
  shiftLabel: string;
  status: DraftCell['status'];
  needsReview: boolean;
  issuesText: string;
  workDate: string | null;
}

const JOB_STATUS: Record<string, string> = {
  UPLOADING: '上传中',
  PENDING_OCR: '等待识别',
  RECOGNIZING: '识别中',
  NEEDS_REVIEW: '待校对',
  READY: '可发布',
  PUBLISHED: '已发布',
  FAILED: '处理失败',
};

Page({
  data: {
    jobId: '',
    teamId: '',
    weekStart: '',
    loading: true,
    errorMsg: '',
    job: null as ImportJob | null,
    jobStatusText: '',
    cells: [] as CellView[],
    allCells: [] as CellView[],
    filterKey: 'ISSUE',
    filters: [
      { key: 'ISSUE', label: '待校对' },
      { key: 'ALL', label: '全部' },
      { key: 'DONE', label: '已处理' },
    ],
    issueCount: 0,
    unmatchedRows: [] as UnmatchedRow[],
    employees: [] as Employee[],
    shiftOptions: [] as ShiftType[],
    bgImages: [] as Array<{ id: string; fileID: string }>,
    busy: false,

    shiftModal: { visible: false, cellId: '', employeeText: '', dateText: '', rawText: '', currentLabel: '' },
    previewModal: { visible: false, preview: null as ReleasePreview | null },
  },

  _revision: 0,

  onLoad(options: Record<string, string>) {
    this.setData({
      jobId: options.jobId || '',
      teamId: options.teamId || '',
      weekStart: options.weekStart || '',
    });
  },

  onShow() {
    if (this.data.jobId) this.loadAll(true);
  },

  async loadAll(initial = false) {
    const { jobId, teamId } = this.data;
    if (!jobId) {
      this.setData({ loading: false, errorMsg: '缺少任务参数' });
      return;
    }
    if (initial) this.setData({ loading: true, errorMsg: '' });
    try {
      const [job, shiftsRes] = await Promise.all([
        getJob(jobId),
        listShiftTypes(teamId),
      ]);
      const draft = await listCells(jobId);
      this._revision = draft.revision;

      let employees = this.data.employees;
      if (employees.length === 0) {
        // 关联员工需要完整花名册，按游标取全（上限 500，避免异常数据拖垮页面）
        let cursor: string | undefined;
        do {
          const page = await listEmployees(teamId, cursor);
          employees = employees.concat(page.items);
          cursor = page.nextCursor || undefined;
        } while (cursor && employees.length < 500);
      }

      const shiftMap: Record<string, ShiftType> = {};
      for (const s of shiftsRes.items) shiftMap[s.code] = s;

      const views: CellView[] = draft.cells.map((c) => ({
        _id: c._id,
        employeeId: c.employeeId,
        dateText: c.workDate ? c.workDate.slice(5) : '日期缺失',
        employeeText: c.employeeName
          ? `${c.employeeName} · ${c.employeeNo || ''}`
          : (c.employeeNo ? `工号 ${c.employeeNo}` : '未匹配员工'),
        rawText: c.rawText || '（空白）',
        shiftCode: c.shiftCode,
        shiftLabel: c.cleared ? '未排班' : (c.shiftCode && shiftMap[c.shiftCode] ? shiftMap[c.shiftCode].label : '待确定'),
        status: c.status,
        needsReview: c.status === 'NEEDS_REVIEW',
        issuesText: (c.issues || []).join('；'),
        workDate: c.workDate,
      }));

      const issueCount = views.filter((v) => v.needsReview).length;

      this.setData({
        loading: false,
        job,
        jobStatusText: JOB_STATUS[job.status] || job.status,
        allCells: views,
        shiftOptions: shiftsRes.items.filter((s) => s.enabled),
        unmatchedRows: draft.unmatchedRows,
        employees,
        bgImages: job.images.map((i) => ({ id: i.id, fileID: i.fileID })),
        issueCount,
      });
      this.applyFilter(initial ? 'ISSUE' : this.data.filterKey, views);
    } catch (e: any) {
      this.setData({ loading: false, errorMsg: e?.message || '加载失败' });
    }
  },

  applyFilter(key: string, source?: CellView[]) {
    const all = source || this.data.allCells;
    let cells = all;
    if (key === 'ISSUE') cells = all.filter((c) => c.needsReview);
    if (key === 'DONE') cells = all.filter((c) => !c.needsReview);
    this.setData({ filterKey: key, cells });
  },

  onFilter(e: WechatMiniprogram.TouchEvent) {
    this.applyFilter(String(e.currentTarget.dataset.key));
  },

  openCell(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id);
    const cell = this.data.allCells.find((c) => c._id === id);
    if (!cell) return;
    if (this.data.job?.status === 'PUBLISHED') {
      wx.showToast({ title: '已发布的版本不可直接修改', icon: 'none' });
      return;
    }
    if (!cell.employeeId) {
      wx.showToast({ title: '请先在“未匹配员工”中关联该行', icon: 'none' });
      return;
    }
    this.setData({
      shiftModal: {
        visible: true,
        cellId: id,
        employeeText: cell.employeeText,
        dateText: cell.dateText,
        rawText: cell.rawText,
        currentLabel: cell.shiftLabel,
      },
    });
  },

  closeShiftModal() {
    this.setData({ 'shiftModal.visible': false });
  },

  async pickShift(e: WechatMiniprogram.TouchEvent) {
    const code = String(e.currentTarget.dataset.code);
    await this.patchCell({ cellId: this.data.shiftModal.cellId, shiftCode: code });
  },

  async markCleared() {
    const { jobId } = this.data;
    const cellId = this.data.shiftModal.cellId;
    const confirmed = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: '确认未排班',
        content: '确认该员工当天无排班？这会形成一条显式清除记录。',
        confirmText: '确认清除',
        success: (r) => resolve(r.confirm),
      });
    });
    if (!confirmed) return;
    await this.patchCell({ cellId, cleared: true });
    void jobId;
  },

  async patchCell(patch: { cellId: string; shiftCode?: string; cleared?: boolean }) {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      const res = await saveCells(this.data.jobId, this._revision, [patch]);
      this._revision = res.revision;
      this.setData({ 'shiftModal.visible': false });
      wx.showToast({ title: '已保存', icon: 'success' });
      await this.loadAll(false);
    } catch (e: any) {
      if (e?.code === 'DRAFT_CONFLICT') {
        wx.showToast({ title: '草稿已在别处更新，已刷新', icon: 'none' });
        await this.loadAll(false);
      } else {
        toastError(e);
      }
    } finally {
      this.setData({ busy: false });
    }
  },

  async onLinkRow(e: WechatMiniprogram.PickerChange) {
    const rowKey = String(e.currentTarget.dataset.rowkey);
    const employeeId = this.data.employees[Number(e.detail.value)]?._id;
    if (!rowKey || !employeeId) return;
    this.setData({ busy: true });
    try {
      const res = await linkRow(this.data.jobId, this._revision, rowKey, employeeId);
      this._revision = res.revision;
      wx.showToast({ title: '已关联', icon: 'success' });
      await this.loadAll(false);
    } catch (err: any) {
      if (err?.code === 'DRAFT_CONFLICT') await this.loadAll(false);
      else toastError(err);
    } finally {
      this.setData({ busy: false });
    }
  },

  async previewImage(e: WechatMiniprogram.TouchEvent) {
    const imageId = String(e.currentTarget.dataset.id);
    try {
      wx.showLoading({ title: '加载原图…' });
      const { url } = await getImagePreview(this.data.jobId, imageId);
      wx.hideLoading();
      wx.previewImage({ urls: [url], current: url });
    } catch (err) {
      wx.hideLoading();
      toastError(err, '原图预览失败');
    }
  },

  async retryImage(e: WechatMiniprogram.TouchEvent) {
    const imageId = String(e.currentTarget.dataset.id);
    try {
      await retryFailed(this.data.jobId, imageId);
      wx.showToast({ title: '已重新提交识别', icon: 'success' });
      await this.loadAll(false);
    } catch (err) {
      toastError(err);
    }
  },

  async removeImage(e: WechatMiniprogram.TouchEvent) {
    const imageId = String(e.currentTarget.dataset.id);
    const confirmed = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: '移除这张图片',
        content: '该页的识别结果会一并移除，其余图片的结果保留。移除后请重新核对。',
        confirmText: '移除',
        confirmColor: '#d93025',
        success: (r) => resolve(r.confirm),
      });
    });
    if (!confirmed) return;
    try {
      await removeFailedImage(this.data.jobId, imageId, this._revision);
      wx.showToast({ title: '已移除', icon: 'success' });
      await this.loadAll(false);
    } catch (err) {
      if ((err as any)?.code === 'DRAFT_CONFLICT') await this.loadAll(false);
      else toastError(err);
    }
  },

  async onPreviewRelease() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      const res = await preview(this.data.jobId, this._revision);
      this.setData({ previewModal: { visible: true, preview: res } });
    } catch (e) {
      toastError(e);
    } finally {
      this.setData({ busy: false });
    }
  },

  closePreview() {
    this.setData({ 'previewModal.visible': false });
  },

  async confirmPublish() {
    const p = this.data.previewModal.preview;
    if (!p || !p.canPublish || this.data.busy) return;
    this.setData({ busy: true });
    const requestId = `${this.data.jobId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const res = await publish({
        jobId: this.data.jobId,
        revision: this._revision,
        baseVersion: p.baseVersion,
        requestId,
      });
      this.setData({ 'previewModal.visible': false });
      wx.showModal({
        title: '发布成功',
        content: `已发布 v${res.version}。员工端将只能看到这个完整版本。`,
        showCancel: false,
        success: () => wx.navigateBack(),
      });
    } catch (e: any) {
      if (e?.code === 'VERSION_CONFLICT') {
        wx.showModal({
          title: '版本冲突',
          content: '已有其他管理员发布了新版本。请关闭预览、刷新差异后重新确认。',
          showCancel: false,
          success: () => {
            this.setData({ 'previewModal.visible': false });
            this.loadAll(false);
          },
        });
      } else {
        toastError(e);
      }
    } finally {
      this.setData({ busy: false });
    }
  },

  retry() {
    this.loadAll(true);
  },
});
