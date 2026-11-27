import {
  getMine,
  getProfile,
  recognize,
  getRecognizeTask,
  saveWeek,
  type RecognizeRow,
  type RecognizeResult,
  type ShiftDef,
} from '../../services/personal';
import { getMe } from '../../services/auth';
import { uploadFile, filePreviewUrl, toastError } from '../../utils/cloud';
import { today, mondayOf, addDays, dateRange, weekday } from '../../utils/date';
import { MAX_IMAGES_PER_JOB, MAX_IMAGE_BYTES } from '../../config/index';

interface PickedFile {
  name: string;
  size: number;
  sizeText: string;
  path: string;
  ext: string;
}

interface RowOption extends RecognizeRow {
  key: string;
  label: string;
  preview: string;
  preferred?: boolean;
}

interface DayRow {
  date: string;
  text: string;
  dayText: string;
}

const REST_RE = /^(休|休息|公休|倒休|调休|OFF|O|×|✕|—|-|\/|／)$/i;
const STUDY_RE = /(学习|培训|STUDY)/i;

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function classify(text: string): 'WORK' | 'OFF' | 'STUDY' {
  const t = text.trim();
  if (REST_RE.test(t)) return 'OFF';
  if (STUDY_RE.test(t)) return 'STUDY';
  return 'WORK';
}

function guessDef(label: string): ShiftDef {
  const category = classify(label);
  if (category === 'OFF') {
    return { label, category, startLocal: null, endLocal: null, endDayOffset: 0, reminderEnabled: false };
  }
  const t = label.replace(/\s+/g, '');
  if (/夜|晚|NIGHT/i.test(t)) {
    return { label, category, startLocal: '20:00', endLocal: '06:00', endDayOffset: 1, reminderEnabled: true };
  }
  if (/中/.test(t)) {
    return { label, category, startLocal: '14:00', endLocal: '22:00', endDayOffset: 0, reminderEnabled: true };
  }
  if (/早|白|日|DAY/i.test(t)) {
    return { label, category, startLocal: '08:00', endLocal: '16:00', endDayOffset: 0, reminderEnabled: true };
  }
  return { label, category, startLocal: '09:00', endLocal: '18:00', endDayOffset: 0, reminderEnabled: true };
}

function weekLabel(weekStart: string): string {
  return `${weekStart.slice(5)} ~ ${addDays(weekStart, 6).slice(5)}`;
}

Page({
  data: {
    openid: '',
    weekStart: '',
    weekText: '',
    step: 'UPLOAD' as 'UPLOAD' | 'PICK' | 'REVIEW',
    files: [] as PickedFile[],
    previewImages: [] as Array<{ fileID: string; url: string }>,
    detectedRangeText: '',
    rows: [] as RowOption[],
    visibleRows: [] as Array<{ index: number; label: string; preview: string; preferred?: boolean }>,
    rowQuery: '',
    profileName: '',
    profileEmployeeNo: '',
    preferredNotice: '',
    selectedIndex: -1,
    selectedName: '',
    days: [] as DayRow[],
    shiftDefs: [] as ShiftDef[],
    busy: false,
    progressText: '',
    errorMsg: '',
    maxCount: MAX_IMAGES_PER_JOB,
  },

  _profileDefs: {} as Record<string, ShiftDef>,
  _detectedDates: [] as string[],

  onLoad() {
    const weekStart = mondayOf(today());
    this.setData({ weekStart, weekText: weekLabel(weekStart) });
    this.initIdentity();
  },

  onShow() {
    // 从设置页返回时刷新姓名
    this.loadProfileName();
  },

  async loadProfileName() {
    try {
      const res = await getProfile();
      const p = res.profile;
      if (p) {
        this.setData({
          profileName: p.employeeName || '',
          profileEmployeeNo: p.employeeNo || '',
        });
      }
    } catch (e) {
      console.warn('[import] load profile failed', e);
    }
  },

  async initIdentity() {
    try {
      const me = await getMe();
      this.setData({ openid: me.openid });
      const profileRes = await getMine(this.data.weekStart, addDays(this.data.weekStart, 6));
      const defs: Record<string, ShiftDef> = {};
      for (const t of (profileRes.profile && profileRes.profile.shiftTypes) || []) {
        defs[t.label] = t;
      }
      this._profileDefs = defs;
      const profile = profileRes.profile;
      if (profile) {
        this.setData({
          profileName: profile.employeeName || '',
          profileEmployeeNo: profile.employeeNo || '',
        });
      }
    } catch (e) {
      // 识别时还会再校验身份
      console.warn('[import] init identity failed', e);
    }
  },

  prevWeek() {
    const ws = addDays(this.data.weekStart, -7);
    this.setData({ weekStart: ws, weekText: weekLabel(ws), files: [], rows: [], step: 'UPLOAD' });
    this.resetJob();
  },

  nextWeek() {
    const ws = addDays(this.data.weekStart, 7);
    this.setData({ weekStart: ws, weekText: weekLabel(ws), files: [], rows: [], step: 'UPLOAD' });
    this.resetJob();
  },

  resetJob() {
    this.setData({ rows: [], selectedIndex: -1, days: [], shiftDefs: [], errorMsg: '' });
  },

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
        this.addFiles(res.tempFiles.map((f, i) => this.toPicked(f.path, f.size, f.name, i)));
      },
      fail: (err) => {
        if (String(err.errMsg).indexOf('cancel') < 0) {
          wx.showToast({ title: '选图失败，请重试', icon: 'none' });
        }
      },
    });
  },

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
        this.addFiles(res.tempFiles.map((f, i) => this.toPicked(f.tempFilePath, f.size, '', i)));
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
        wx.showToast({ title: `${f.name} 超过 10MB`, icon: 'none' });
        continue;
      }
      if (this.data.files.length + accepted.length >= MAX_IMAGES_PER_JOB) break;
      accepted.push(f);
    }
    if (accepted.length === 0) return;
    this.setData({ files: this.data.files.concat(accepted), step: 'UPLOAD' });
  },

  removeFile(e: WechatMiniprogram.TouchEvent) {
    const idx = Number(e.currentTarget.dataset.index);
    const files = this.data.files.slice();
    files.splice(idx, 1);
    this.setData({ files });
  },

  async startRecognize() {
    if (this.data.busy) return;
    const { files, weekStart, openid } = this.data;
    if (!openid) {
      wx.showToast({ title: '正在获取身份，请稍后重试', icon: 'none' });
      this.initIdentity();
      return;
    }
    if (files.length === 0) {
      wx.showToast({ title: '请先选择排班图', icon: 'none' });
      return;
    }

    this.setData({
      busy: true,
      errorMsg: '',
      progressText: '准备上传…',
      previewImages: [],
      detectedRangeText: '',
    });
    this._detectedDates = [];
    try {
      const merged = new Map<string, RowOption>();
      const detected = new Set<string>();

      for (let i = 0; i < files.length; i += 1) {
        const f = files[i];
        this.setData({ progressText: `上传第 ${i + 1}/${files.length} 张…` });
        const cloudPath = `imports/personal/${openid}/${Date.now()}-${i}-${Math.random()
          .toString(36)
          .slice(2, 6)}.${f.ext}`;
        const fileID = await uploadFile(cloudPath, f.path);

        // 原图预览：识别前就加载，方便核对
        try {
          const url = await filePreviewUrl(fileID);
          this.setData({
            previewImages: this.data.previewImages.concat([{ fileID, url }]),
          });
        } catch (e) {
          console.warn('[import] preview failed', e);
        }

        this.setData({ progressText: `识别第 ${i + 1}/${files.length} 张…（约 20-60 秒）` });
        const { taskId } = await recognize(fileID, weekStart);
        const res = await this.waitTask(taskId);

        for (const d of res.dates || []) detected.add(d);

        for (const row of res.rows) {
          for (const c of row.cells || []) if (c.date) detected.add(c.date);
          const key = row.employeeNo ? `no:${row.employeeNo}` : `name:${row.name}`;
          const preview = (row.cells || [])
            .map((c) => c.text)
            .filter(Boolean)
            .join(' ');
          const existing = merged.get(key);
          if (!existing) {
            merged.set(key, {
              ...row,
              key,
              label: `${row.name || '未识别姓名'}${row.employeeNo ? ` · ${row.employeeNo}` : ''}`,
              preview: preview || '（全部空白）',
            });
          } else {
            // 多图合并：只补空白日期，已有内容不覆盖
            const byDate: Record<string, string> = {};
            for (const c of existing.cells) if (c.date) byDate[c.date] = c.text;
            for (const c of row.cells) {
              if (c.date && !byDate[c.date] && c.text) byDate[c.date] = c.text;
            }
            existing.cells = Object.keys(byDate).map((date) => ({ date, text: byDate[date], confidence: null }));
            existing.preview = existing.cells.map((c) => c.text).filter(Boolean).join(' ') || '（全部空白）';
          }
        }
      }

      const baseRows = Array.from(merged.values());
      if (baseRows.length === 0) {
        this.setData({ busy: false, progressText: '', errorMsg: '没有识别到员工行，请换一张更清晰的图片' });
        return;
      }

      // 优先匹配设置里的姓名/工号
      const pname = this.data.profileName.trim();
      const pno = this.data.profileEmployeeNo.trim();
      const rows: RowOption[] = baseRows
        .map((r) => ({
          ...r,
          preferred: !!((pno && r.employeeNo === pno) || (pname && r.name === pname)),
        }))
        .sort(
          (a, b) => (b.preferred ? 1 : 0) - (a.preferred ? 1 : 0) || a.label.localeCompare(b.label)
        );

      const matched = rows.map((r, i) => (r.preferred ? i : -1)).filter((i) => i >= 0);
      let preferredNotice = '';
      if (pname || pno) {
        if (matched.length === 1) preferredNotice = `已按设置优先匹配：${rows[matched[0]].label}`;
        else if (matched.length > 1) preferredNotice = `找到 ${matched.length} 个匹配，请选择`;
        else preferredNotice = `未在名单中找到「${pname || pno}」，请手动选择`;
      }

      this._detectedDates = Array.from(detected).sort();
      const detectedRangeText = this._detectedDates.length
        ? `${this._detectedDates[0]} ~ ${this._detectedDates[this._detectedDates.length - 1]}`
        : '';

      this.setData({
        busy: false,
        progressText: '',
        rows,
        visibleRows: rows.map((r, i) => ({
          index: i,
          label: r.label,
          preview: r.preview,
          preferred: !!r.preferred,
        })),
        rowQuery: '',
        preferredNotice,
        detectedRangeText,
        step: 'PICK',
      });

      if (matched.length === 1) {
        this.selectRowByIndex(matched[0]);
      }
    } catch (e: any) {
      this.setData({ busy: false, progressText: '' });
      toastError(e, '识别失败');
    }
  },

  async waitTask(taskId: string): Promise<RecognizeResult> {
    const maxPolls = 90; // 约 3 分钟
    for (let i = 0; i < maxPolls; i += 1) {
      const task = await getRecognizeTask(taskId);
      if (task.status === 'DONE') {
        return {
          weekStart: task.weekStart,
          dates: task.dates || [],
          rows: task.rows || [],
          notes: task.notes || '',
        };
      }
      if (task.status === 'FAILED') {
        throw new Error(task.error || '识别失败，请重试');
      }
      this.setData({ progressText: `识别中…已等待 ${(i + 1) * 2} 秒` });
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error('识别超时，请重试或换一张更清晰的图');
  },

  onRowQuery(e: WechatMiniprogram.Input) {
    const q = e.detail.value.trim().toLowerCase();
    const rows = this.data.rows;
    const visibleRows = rows
      .map((r, i) => ({
        index: i,
        label: r.label,
        preview: r.preview,
        preferred: !!r.preferred,
      }))
      .filter((r) => !q || r.label.toLowerCase().indexOf(q) >= 0);
    this.setData({ rowQuery: e.detail.value, visibleRows });
  },

  pickRow(e: WechatMiniprogram.TouchEvent) {
    this.selectRowByIndex(Number(e.currentTarget.dataset.index));
  },

  selectRowByIndex(index: number) {
    const row = this.data.rows[index];
    if (!row) return;

    // 以图片识别出的日期为准；没有识别到日期时才回退到所选周
    const dates = this._detectedDates.length > 0
      ? this._detectedDates.slice()
      : dateRange(this.data.weekStart, addDays(this.data.weekStart, 6));
    const byDate: Record<string, string> = {};
    row.cells.forEach((c, i) => {
      const date = c.date || dates[i];
      if (date) byDate[date] = c.text || '';
    });

    const days: DayRow[] = dates.map((date) => ({
      date,
      text: byDate[date] || '',
      dayText: `${date.slice(5)} 周${['', '一', '二', '三', '四', '五', '六', '日'][weekday(date)]}`,
    }));

    this.setData({
      selectedIndex: index,
      selectedName: row.label,
      days,
      step: 'REVIEW',
    });
    this.rebuildDefs(days);
  },

  rebuildDefs(days: DayRow[]) {
    const labels: string[] = [];
    for (const d of days) {
      const t = d.text.trim();
      if (t && labels.indexOf(t) < 0) labels.push(t);
    }
    const existing: Record<string, ShiftDef> = {};
    for (const def of this.data.shiftDefs) existing[def.label] = def;
    const defs = labels.map((label) => {
      const base = existing[label] || this._profileDefs[label] || guessDef(label);
      const category = classify(label);
      return { ...base, label, category };
    });
    this.setData({ shiftDefs: defs });
  },

  onDayInput(e: WechatMiniprogram.Input) {
    const idx = Number(e.currentTarget.dataset.index);
    const days = this.data.days.slice();
    if (!days[idx]) return;
    days[idx] = { ...days[idx], text: e.detail.value };
    this.setData({ days });
    this.rebuildDefs(days);
  },

  onDefTime(e: WechatMiniprogram.PickerChange) {
    const idx = Number(e.currentTarget.dataset.index);
    const field = String(e.currentTarget.dataset.field) as 'startLocal' | 'endLocal';
    const defs = this.data.shiftDefs.slice();
    if (!defs[idx]) return;
    defs[idx] = { ...defs[idx], [field]: e.detail.value };
    this.setData({ shiftDefs: defs });
  },

  onDefOffset(e: WechatMiniprogram.SwitchChange) {
    const idx = Number(e.currentTarget.dataset.index);
    const defs = this.data.shiftDefs.slice();
    if (!defs[idx]) return;
    defs[idx] = { ...defs[idx], endDayOffset: e.detail.value ? 1 : 0 };
    this.setData({ shiftDefs: defs });
  },

  onDefReminder(e: WechatMiniprogram.SwitchChange) {
    const idx = Number(e.currentTarget.dataset.index);
    const defs = this.data.shiftDefs.slice();
    if (!defs[idx]) return;
    defs[idx] = { ...defs[idx], reminderEnabled: e.detail.value };
    this.setData({ shiftDefs: defs });
  },

  async save() {
    if (this.data.busy) return;
    const { days, shiftDefs, weekStart } = this.data;
    const defMap: Record<string, ShiftDef> = {};
    for (const d of shiftDefs) defMap[d.label] = d;

    const shifts: any[] = [];
    for (const day of days) {
      const label = day.text.trim();
      if (!label) continue;
      const def = defMap[label];
      const category = classify(label);
      if (category !== 'OFF' && (!def || !def.startLocal || !def.endLocal)) {
        wx.showToast({ title: `请设置「${label}」的起止时间`, icon: 'none' });
        return;
      }
      shifts.push({
        workDate: day.date,
        label,
        category,
        startLocal: category === 'OFF' ? null : def.startLocal,
        endLocal: category === 'OFF' ? null : def.endLocal,
        endDayOffset: category === 'OFF' ? 0 : def.endDayOffset,
        reminderEnabled: category === 'OFF' ? false : def.reminderEnabled,
      });
    }

    if (shifts.length === 0) {
      wx.showToast({ title: '本周没有可保存的班次', icon: 'none' });
      return;
    }

    const row = this.data.rows[this.data.selectedIndex];
    const firstDate = days.find((d) => d.text.trim()) || days[0];
    const saveWeekStart = firstDate ? mondayOf(firstDate.date) : weekStart;

    this.setData({ busy: true });
    try {
      await saveWeek({
        weekStart: saveWeekStart,
        employeeName: (row && row.name) || this.data.profileName || '我',
        employeeNo: (row && row.employeeNo) || this.data.profileEmployeeNo || undefined,
        dates: days.map((d) => d.date),
        shifts,
        shiftTypes: shiftDefs,
      });
      wx.showToast({ title: '已保存', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 500);
    } catch (e) {
      toastError(e, '保存失败');
    } finally {
      this.setData({ busy: false });
    }
  },

  previewOriginal(e: WechatMiniprogram.TouchEvent) {
    const urls = this.data.previewImages.map((i) => i.url).filter(Boolean);
    if (urls.length === 0) {
      wx.showToast({ title: '原图预览不可用', icon: 'none' });
      return;
    }
    const idx = Number(e.currentTarget.dataset.index || 0);
    wx.previewImage({ urls, current: urls[idx] || urls[0] });
  },

  backToUpload() {
    this.setData({ step: 'UPLOAD', rows: [], selectedIndex: -1, days: [], shiftDefs: [] });
  },

  backToPick() {
    this.setData({ step: 'PICK' });
  },
});
