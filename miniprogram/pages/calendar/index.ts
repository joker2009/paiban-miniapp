import { getMine, saveShift, deleteShift, type PersonalShift } from '../../services/personal';
import {
  today,
  mondayOf,
  addDays,
  dateRange,
  displayRange,
  weekday,
} from '../../utils/date';
import { getRecord, saveRecord, fingerprint } from '../../utils/localCalendar';
import { CALENDAR_ALARM_OFFSET } from '../../config/index';
import { toastError } from '../../utils/cloud';

interface ShiftView extends PersonalShift {
  timeText: string;
  title: string;
  canAdd: boolean;
  localAdded: boolean;
}

interface DayView {
  date: string;
  day: number;
  inMonth: boolean;
  isToday: boolean;
  labels: string;
  hasShift: boolean;
  shiftCount: number;
}

interface WeekView {
  weekStart: string;
  days: DayView[];
}

const DAY_NAMES = ['一', '二', '三', '四', '五', '六', '日'];
const WEEKDAY_TEXT = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function monthBounds(monthKey: string): { first: string; last: string } {
  const [y, m] = monthKey.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { first: `${monthKey}-01`, last: `${monthKey}-${pad(lastDay)}` };
}

function shiftTitle(s: PersonalShift): string {
  if (s.category === 'STUDY') return `学习 · ${s.label}`;
  if (s.category === 'OFF') return s.label;
  return `上班 · ${s.label}`;
}

Page({
  data: {
    loading: true,
    errorMsg: '',
    openid: '',
    employeeName: '',
    monthKey: '',
    monthLabel: '',
    dayNames: DAY_NAMES,
    weeks: [] as WeekView[],
    hasAnyShift: false,

    selectedVisible: false,
    selectedDate: '',
    selectedDateText: '',
    selectedWeekStart: '',
    selectedShifts: [] as ShiftView[],
    selectedWeekCount: 0,
    batchBusy: false,
    batchVisible: false,
    batchProgress: '',
    weekCount: 0,
    monthCount: 0,
    animClass: '',

    editVisible: false,
    editIsNew: false,
    editSaving: false,
    categories: ['工作', '休息', '学习'],
    edit: {
      workDate: '',
      label: '',
      categoryIndex: 0,
      startLocal: '09:00',
      endLocal: '18:00',
      endDayOffset: 0,
      reminderEnabled: true,
    },
  },

  _byDate: {} as Record<string, ShiftView[]>,
  _touchX: 0,
  _touchY: 0,
  _switchDir: '' as 'prev' | 'next' | '',
  _switching: false,
  _animTimer: 0,

  onShow() {
    if (!this.data.monthKey) {
      const t = today();
      this.setData({ monthKey: t.slice(0, 7) });
    }
    this.load();
  },

  async onPullDownRefresh() {
    await this.load();
    wx.stopPullDownRefresh();
  },

  async load() {
    // 切月时保留旧网格，避免闪一下「加载中」
    if (this.data.weeks.length === 0) {
      this.setData({ loading: true, errorMsg: '' });
    }
    try {
      const { first, last } = monthBounds(this.data.monthKey);
      const from = mondayOf(first);
      const to = addDays(mondayOf(last), 6);
      const res = await getMine(from, to);

      const openid = res.openid;
      const byDate: Record<string, ShiftView[]> = {};
      for (const s of res.shifts) {
        const rec = openid ? getRecord(openid, s.workDate) : null;
        const title = shiftTitle(s);
        const fp = s.startAt && s.endAt ? fingerprint(title, s.startAt, s.endAt) : '';
        const view: ShiftView = {
          ...s,
          title,
          timeText: s.category === 'OFF' ? '休息' : displayRange(s.startAt, s.endAt),
          canAdd: s.category !== 'OFF' && !!s.startAt && !!s.endAt,
          localAdded: !!rec && rec.fingerprint === fp,
        };
        if (!byDate[s.workDate]) byDate[s.workDate] = [];
        byDate[s.workDate].push(view);
      }
      this._byDate = byDate;

      const weeks: WeekView[] = [];
      let cursor = mondayOf(first);
      while (cursor <= to) {
        const days: DayView[] = dateRange(cursor, addDays(cursor, 6)).map((date) => {
          const shifts = byDate[date] || [];
          return {
            date,
            day: Number(date.slice(8)),
            inMonth: date.slice(0, 7) === this.data.monthKey,
            isToday: date === today(),
            labels: shifts.map((x) => x.label).join(' '),
            hasShift: shifts.length > 0,
            shiftCount: shifts.length,
          };
        });
        weeks.push({ weekStart: cursor, days });
        cursor = addDays(cursor, 7);
      }

      const [y, m] = this.data.monthKey.split('-');
      this.setData({
        loading: false,
        openid,
        employeeName: (res.profile && res.profile.employeeName) || '',
        monthLabel: `${y} 年 ${Number(m)} 月`,
        weeks,
        hasAnyShift: res.shifts.length > 0,
      });

      // 切换月份时播放进入动效
      if (this._switchDir) {
        const animClass = this._switchDir === 'next' ? 'slide-next' : 'slide-prev';
        this._switchDir = '';
        this.setData({ animClass: '' });
        wx.nextTick(() => {
          this.setData({ animClass });
          clearTimeout(this._animTimer);
          this._animTimer = setTimeout(() => {
            this.setData({ animClass: '' });
          }, 320) as unknown as number;
        });
      }
    } catch (e: any) {
      this.setData({ loading: false, errorMsg: e?.message || '加载失败，请下拉重试' });
    }
  },

  prevMonth() {
    this.switchMonth('prev');
  },

  nextMonth() {
    this.switchMonth('next');
  },

  switchMonth(dir: 'prev' | 'next') {
    if (this._switching) return;
    this._switching = true;
    this._switchDir = dir;

    const [y, m] = this.data.monthKey.split('-').map(Number);
    const d = dir === 'prev' ? new Date(Date.UTC(y, m - 2, 1)) : new Date(Date.UTC(y, m, 1));
    this.setData({ monthKey: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}` });
    this.load();

    // 防止快速连续切换导致动画叠加
    setTimeout(() => {
      this._switching = false;
    }, 300);
  },

  goImport() {
    wx.navigateTo({ url: '/pages/import/index' });
  },

  goSettings() {
    wx.navigateTo({ url: '/pages/settings/index' });
  },

  onTouchStart(e: WechatMiniprogram.TouchEvent) {
    const t = e.touches && e.touches[0];
    if (!t) return;
    this._touchX = t.clientX;
    this._touchY = t.clientY;
  },

  onTouchEnd(e: WechatMiniprogram.TouchEvent) {
    const t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - this._touchX;
    const dy = t.clientY - this._touchY;
    // 只处理明显的横向滑动，避免影响页面纵向滚动
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    // 右滑看上一月，左滑看下一月
    if (dx > 0) this.switchMonth('prev');
    else this.switchMonth('next');
  },

  openDay(e: WechatMiniprogram.TouchEvent) {
    this.openDayByDate(String(e.currentTarget.dataset.date));
  },

  openDayByDate(date: string) {
    const shifts = this._byDate[date] || [];
    const weekStart = mondayOf(date);
    const weekShifts = dateRange(weekStart, addDays(weekStart, 6))
      .flatMap((d) => this._byDate[d] || [])
      .filter((s) => s.canAdd && !s.localAdded);

    this.setData({
      selectedVisible: true,
      selectedDate: date,
      selectedDateText: `${date} ${WEEKDAY_TEXT[weekday(date)]}`,
      selectedWeekStart: weekStart,
      selectedShifts: shifts,
      selectedWeekCount: weekShifts.length,
    });
  },

  closeDay() {
    this.setData({ selectedVisible: false });
  },

  openEdit(e: WechatMiniprogram.TouchEvent) {
    const idx = Number(e.currentTarget.dataset.index);
    const shift = this.data.selectedShifts[idx];
    if (!shift) return;
    this.setData({
      selectedVisible: false,
      editVisible: true,
      editIsNew: false,
      edit: {
        workDate: shift.workDate,
        label: shift.label,
        categoryIndex: shift.category === 'OFF' ? 1 : shift.category === 'STUDY' ? 2 : 0,
        startLocal: shift.startLocal || '09:00',
        endLocal: shift.endLocal || '18:00',
        endDayOffset: shift.endDayOffset || 0,
        reminderEnabled: !!shift.reminderEnabled,
      },
    });
  },

  openCreate() {
    const date = this.data.selectedDate;
    if (!date) return;
    this.setData({
      selectedVisible: false,
      editVisible: true,
      editIsNew: true,
      edit: {
        workDate: date,
        label: '',
        categoryIndex: 0,
        startLocal: '09:00',
        endLocal: '18:00',
        endDayOffset: 0,
        reminderEnabled: true,
      },
    });
  },

  closeEdit() {
    this.setData({ editVisible: false });
  },

  onEditField(e: WechatMiniprogram.Input) {
    this.setData({ 'edit.label': e.detail.value });
  },

  onEditCategory(e: WechatMiniprogram.PickerChange) {
    const idx = Number(e.detail.value);
    this.setData({
      'edit.categoryIndex': idx,
      'edit.reminderEnabled': idx === 1 ? false : this.data.edit.reminderEnabled,
    });
  },

  onEditTime(e: WechatMiniprogram.PickerChange) {
    const field = String(e.currentTarget.dataset.field) as 'startLocal' | 'endLocal';
    this.setData({ [`edit.${field}`]: e.detail.value });
  },

  onEditOffset(e: WechatMiniprogram.SwitchChange) {
    this.setData({ 'edit.endDayOffset': e.detail.value ? 1 : 0 });
  },

  onEditReminder(e: WechatMiniprogram.SwitchChange) {
    this.setData({ 'edit.reminderEnabled': e.detail.value });
  },

  async saveEdit() {
    const form = this.data.edit;
    const label = form.label.trim();
    if (!label) {
      wx.showToast({ title: '请输入班次名称', icon: 'none' });
      return;
    }
    if (this.data.editSaving) return;

    const category = form.categoryIndex === 1 ? 'OFF' : form.categoryIndex === 2 ? 'STUDY' : 'WORK';
    this.setData({ editSaving: true });
    try {
      await saveShift({
        workDate: form.workDate,
        label,
        category,
        startLocal: category === 'OFF' ? null : form.startLocal,
        endLocal: category === 'OFF' ? null : form.endLocal,
        endDayOffset: category === 'OFF' ? 0 : form.endDayOffset,
        reminderEnabled: category === 'OFF' ? false : form.reminderEnabled,
      });
      const date = form.workDate;
      this.setData({ editVisible: false });
      await this.load();
      this.openDayByDate(date);
      wx.showModal({
        title: '已更新班表',
        content: '如果已添加到手机日历，请到系统日历删除旧日程后重新添加；小程序无法修改系统日历。',
        showCancel: false,
      });
    } catch (e) {
      toastError(e, '保存失败');
    } finally {
      this.setData({ editSaving: false });
    }
  },

  async deleteEdit() {
    const form = this.data.edit;
    if (this.data.editSaving) return;
    const confirmed = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: '删除当天班次',
        content: `确认删除 ${form.workDate} 的班次？系统日历中的旧日程需要手动删除。`,
        confirmColor: '#d93025',
        success: (r) => resolve(r.confirm),
      });
    });
    if (!confirmed) return;

    this.setData({ editSaving: true });
    try {
      await deleteShift(form.workDate);
      this.setData({ editVisible: false });
      await this.load();
      wx.showToast({ title: '已删除', icon: 'success' });
    } catch (e) {
      toastError(e, '删除失败');
    } finally {
      this.setData({ editSaving: false });
    }
  },

  onAddShift(e: WechatMiniprogram.TouchEvent) {
    const idx = Number(e.currentTarget.dataset.index);
    const shift = this.data.selectedShifts[idx];
    if (!shift || !shift.canAdd) return;
    this.addOne(shift)
      .then(() => {
        const list = this.data.selectedShifts.slice();
        if (list[idx]) list[idx] = { ...list[idx], localAdded: true };
        this.setData({ selectedShifts: list });
        wx.showToast({ title: '已添加到手机日历', icon: 'success' });
      })
      .catch((err) => this.handleAddFail(err));
  },

  onBatchWeek() {
    const weekStart = this.data.selectedWeekStart;
    this.runBatch(this.collectShifts(weekStart, addDays(weekStart, 6)));
  },

  /** 某日期区间内可添加的班次（未添加、未结束） */
  collectShifts(from: string, to: string): ShiftView[] {
    const now = Date.now();
    const out: ShiftView[] = [];
    for (const date of dateRange(from, to)) {
      for (const s of this._byDate[date] || []) {
        if (!s.canAdd || s.localAdded) continue;
        if (s.endAt && new Date(s.endAt).getTime() <= now) continue;
        out.push(s);
      }
    }
    return out.sort((a, b) => ((a.startAt || '') < (b.startAt || '') ? -1 : 1));
  },

  openBatch() {
    const weekStart = mondayOf(today());
    const { first, last } = monthBounds(this.data.monthKey);
    this.setData({
      batchVisible: true,
      batchProgress: '',
      weekCount: this.collectShifts(weekStart, addDays(weekStart, 6)).length,
      monthCount: this.collectShifts(first, last).length,
    });
  },

  closeBatch() {
    if (this.data.batchBusy) return;
    this.setData({ batchVisible: false });
  },

  onBatchAdd(e: WechatMiniprogram.TouchEvent) {
    const scope = String(e.currentTarget.dataset.scope);
    const t = today();
    let from = '';
    let to = '';
    if (scope === 'week') {
      const ws = mondayOf(t);
      from = ws;
      to = addDays(ws, 6);
    } else {
      const bounds = monthBounds(this.data.monthKey);
      from = bounds.first;
      to = bounds.last;
    }
    this.runBatch(this.collectShifts(from, to));
  },

  runBatch(shifts: ShiftView[]) {
    if (this.data.batchBusy) return;
    if (shifts.length === 0) {
      wx.showToast({ title: '没有可添加的班次', icon: 'none' });
      return;
    }

    // 必须在点击回调内立刻发起第一次调用，保留微信点击态
    const first = shifts[0];
    const firstPromise = this.addOne(first);

    this.setData({
      batchBusy: true,
      batchProgress: `0/${shifts.length}`,
      batchVisible: true,
      selectedVisible: false,
    });

    (async () => {
      let ok = 0;
      let fail = 0;
      let authFail = false;

      try {
        await firstPromise;
        ok += 1;
      } catch (e) {
        fail += 1;
        authFail = this.isAuthError(e);
      }

      for (let i = 1; i < shifts.length && !authFail; i += 1) {
        try {
          await this.addOne(shifts[i]);
          ok += 1;
        } catch (e) {
          fail += 1;
          if (this.isAuthError(e)) authFail = true;
        }
        this.setData({ batchProgress: `${i + 1}/${shifts.length}` });
      }

      this.setData({ batchBusy: false, batchVisible: false });
      await this.load();
      wx.showModal({
        title: '批量添加完成',
        content: authFail
          ? '日历权限被拒绝，请到设置中开启后重试。'
          : `成功 ${ok} 条${fail ? `，失败 ${fail} 条（可能被微信/系统限制）` : ''}。可到系统日历核对。`,
        showCancel: false,
      });
    })();
  },

  isAuthError(err: any): boolean {
    const msg = String((err && (err.errMsg || err.message)) || '');
    return /auth deny|authorize|permission/i.test(msg);
  },

  addOne(shift: ShiftView): Promise<void> {
    const wxCtx = wx as any;
    if (typeof wxCtx.addPhoneCalendar !== 'function') {
      return Promise.reject(new Error('当前微信版本不支持添加手机日历'));
    }
    if (!shift.startAt || !shift.endAt) {
      return Promise.reject(new Error('该班次没有时间'));
    }
    const startTime = Math.floor(new Date(shift.startAt).getTime() / 1000);
    const endTime = Math.floor(new Date(shift.endAt).getTime() / 1000);
    const openid = this.data.openid;

    return new Promise((resolve, reject) => {
      wxCtx.addPhoneCalendar({
        title: shift.title,
        description: '由班表助手添加；修改或删除请到系统日历中操作',
        startTime,
        endTime,
        alarm: shift.reminderEnabled,
        alarmOffset: CALENDAR_ALARM_OFFSET,
        success: () => {
          if (openid) {
            saveRecord({
              employeeId: openid,
              workDate: shift.workDate,
              shiftCode: shift.label,
              title: shift.title,
              startAt: shift.startAt!,
              endAt: shift.endAt!,
              fingerprint: fingerprint(shift.title, shift.startAt!, shift.endAt!),
            });
          }
          resolve();
        },
        fail: (err: any) => reject(err),
      });
    });
  },

  handleAddFail(err: any) {
    const msg = String(err?.errMsg || err?.message || '');
    if (msg.indexOf('auth deny') >= 0 || msg.indexOf('authorize') >= 0) {
      wx.showModal({
        title: '需要日历权限',
        content: '请在设置中允许写入日历后重试，仍可正常查看班表。',
        confirmText: '去设置',
        success: (r) => {
          if (r.confirm) (wx as any).openSetting({});
        },
      });
      return;
    }
    toastError(err, '添加失败，你仍可查看班表');
  },

  retry() {
    this.load();
  },
});
