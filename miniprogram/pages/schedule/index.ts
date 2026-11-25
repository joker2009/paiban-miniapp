import { getMe } from '../../services/auth';
import { getMine } from '../../services/schedule';
import {
  today,
  addDays,
  mondayOf,
  displayDate,
  displayRange,
  dateRange,
  isOngoing,
  isValidDate,
} from '../../utils/date';
import { localStatus, saveRecord, getRecord, fingerprint } from '../../utils/localCalendar';
import { CALENDAR_ALARM_OFFSET } from '../../config/index';
import { toastError } from '../../utils/cloud';
import type { MeInfo, MyShift, ScheduleMineResult } from '../../types/index';

interface ShiftView extends MyShift {
  timeText: string;
  ongoing: boolean;
  ended: boolean;
  canAdd: boolean;
  localAdded: boolean;
  localStale: boolean;
  oldTimeText: string;
}

interface DayView {
  date: string;
  label: string;
  isToday: boolean;
  empty: boolean;
  shifts: ShiftView[];
}

interface WeekView {
  weekStart: string;
  label: string;
  days: DayView[];
}

interface StaleNotice {
  workDate: string;
  text: string;
  removed: boolean;
  oldTimeText: string;
}

const WEEK_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

Page({
  data: {
    loading: true,
    bound: true,
    errorMsg: '',
    teamName: '',
    lastPublishedAt: '',
    nextShift: null as null | {
      title: string;
      dateText: string;
      timeText: string;
      ongoing: boolean;
      canAdd: boolean;
      localAdded: boolean;
      workDate: string;
      shiftCode: string;
    },
    weeks: [] as WeekView[],
    staleNotices: [] as StaleNotice[],
    hasAnyShift: false,
  },

  _me: null as MeInfo | null,
  _shiftsByDate: {} as Record<string, ShiftView>,

  onShow() {
    this.load();
  },

  async onPullDownRefresh() {
    await this.load();
    wx.stopPullDownRefresh();
  },

  async load() {
    this.setData({ loading: true, errorMsg: '' });
    try {
      const me = await getMe();
      this._me = me;
      const app = getApp<IAppOption>();
      app.globalData.me = me;
      app.globalData.meLoadedAt = Date.now();

      if (!me.employee) {
        this.setData({ loading: false, bound: false });
        return;
      }

      const t = today();
      // 查询前一日，用于判断跨夜班是否仍在进行中
      const from = addDays(t, -1);
      const to = addDays(t, 13);
      const data = await getMine(from, to);
      this.applySchedule(me, data);
    } catch (e: any) {
      this.setData({ loading: false, errorMsg: e?.message || '加载失败，请下拉重试' });
    }
  },

  applySchedule(me: MeInfo, data: ScheduleMineResult) {
    const employee = me.employee!;
    const now = Date.now();
    const byDate: Record<string, ShiftView> = {};
    let hasAnyShift = false;

    const viewOf = (s: MyShift): ShiftView => {
      const rec = getRecord(employee.employeeId, s.workDate);
      const canRemind = s.reminderEnabled && (s.category === 'WORK' || s.category === 'STUDY');
      const title = shiftTitle(s);
      const fp = s.startAt && s.endAt ? fingerprint(title, s.startAt, s.endAt) : '';
      const same = !!rec && rec.fingerprint === fp;
      const ended = !!s.endAt && new Date(s.endAt).getTime() <= now;
      return {
        ...s,
        timeText: displayRange(s.startAt, s.endAt),
        ongoing: isOngoing(s.startAt, s.endAt, now),
        ended,
        canAdd: canRemind && !ended && !!s.startAt && !!s.endAt,
        localAdded: same,
        localStale: !!rec && !same,
        oldTimeText: rec ? `${rec.startAt.slice(5, 16).replace('T', ' ')} → ${rec.endAt.slice(5, 16).replace('T', ' ')}` : '',
      };
    };

    for (const s of data.shifts) {
      byDate[s.workDate] = viewOf(s);
      if (s.category === 'WORK' || s.category === 'STUDY') hasAnyShift = true;
    }
    this._shiftsByDate = byDate;

    // 本周 / 下周
    const weeks: WeekView[] = [];
    let cursor = mondayOf(today());
    for (let w = 0; w < 2; w += 1) {
      const days: DayView[] = dateRange(cursor, addDays(cursor, 6)).map((date) => {
        const sv = byDate[date];
        return {
          date,
          label: displayDate(date),
          isToday: date === today(),
          empty: !sv,
          shifts: sv ? [sv] : [],
        };
      });
      weeks.push({ weekStart: cursor, label: w === 0 ? '本周' : '下周', days });
      cursor = addDays(cursor, 7);
    }

    // 下一班：正在上班 -> 当前班次 + 另列下一班；否则最近的未来工作班次
    const working = data.shifts.filter((s) => s.category === 'WORK' || s.category === 'STUDY');
    const ongoing = working.find((s) => isOngoing(s.startAt, s.endAt, now));
    const future = working
      .filter((s) => s.startAt && new Date(s.startAt).getTime() > now)
      .sort((a, b) => (a.startAt! < b.startAt! ? -1 : 1))[0];
    const focus = ongoing || future;
    let nextShift: any = null;
    if (focus) {
      const sv = byDate[focus.workDate] || viewOf(focus);
      nextShift = {
        title: shiftTitle(focus),
        dateText: ongoing ? '当前班次' : displayDate(focus.workDate),
        timeText: sv.timeText,
        ongoing: !!ongoing,
        canAdd: sv.canAdd,
        localAdded: sv.localAdded,
        workDate: focus.workDate,
        shiftCode: focus.shiftCode,
      };
    }

    // 旧提醒：已变更 / 已清除
    const staleNotices: StaleNotice[] = [];
    const displayed = new Set<string>();
    for (const w of weeks) for (const d of w.days) displayed.add(d.date);
    for (const date of Array.from(displayed).sort()) {
      const s = byDate[date];
      const status = localStatus(employee.employeeId, date, s && s.startAt && s.endAt
        ? { title: shiftTitle(s), startAt: s.startAt, endAt: s.endAt }
        : null);
      if (status === 'STALE' || status === 'REMOVED') {
        const rec = getRecord(employee.employeeId, date)!;
        staleNotices.push({
          workDate: date,
          removed: status === 'REMOVED',
          oldTimeText: `${rec.title} · ${rec.startAt.slice(5, 16).replace('T', ' ')} → ${rec.endAt.slice(5, 16).replace('T', ' ')}`,
          text: status === 'REMOVED'
            ? '该班次已被取消，请到系统日历手动删除旧提醒'
            : '班次已变更，旧日历提醒需手动处理',
        });
      }
    }

    this.setData({
      loading: false,
      bound: true,
      teamName: data.teamName,
      lastPublishedAt: data.lastPublishedAt ? data.lastPublishedAt.slice(0, 16).replace('T', ' ') : '',
      weeks,
      nextShift,
      staleNotices,
      hasAnyShift,
    });
  },

  /**
   * 必须从点击回调内直接调用 wx.addPhoneCalendar，
   * 排班数据已在加载时准备好，点击后不做额外异步请求。
   */
  onAddToCalendar(e: WechatMiniprogram.TouchEvent) {
    const { date } = e.currentTarget.dataset as { date: string };
    const sv = this._shiftsByDate[date];
    const me = this._me;
    if (!sv || !me?.employee) return;
    if (!sv.canAdd) {
      wx.showToast({ title: '该班次无需提醒', icon: 'none' });
      return;
    }
    this.addShift(sv, me);
  },

  onAddNext() {
    const next = this.data.nextShift;
    if (!next) return;
    const sv = this._shiftsByDate[next.workDate];
    const me = this._me;
    if (!sv || !me?.employee) return;
    if (!sv.canAdd) {
      wx.showToast({ title: '该班次无需提醒', icon: 'none' });
      return;
    }
    this.addShift(sv, me);
  },

  addShift(sv: ShiftView, me: MeInfo) {
    const employee = me.employee!;
    const title = shiftTitle(sv);
    const startTime = Math.floor(new Date(sv.startAt!).getTime() / 1000);
    const endTime = Math.floor(new Date(sv.endAt!).getTime() / 1000);

    if (sv.localStale) {
      wx.showModal({
        title: '旧提醒可能重复',
        content: `本机已添加过旧班次（${sv.oldTimeText}）。继续添加可能出现重复提醒，建议先在系统日历删除旧日程。`,
        confirmText: '仍要添加',
        cancelText: '取消',
        success: (r) => {
          if (r.confirm) this.doAdd(sv, employee.employeeId, title, startTime, endTime);
        },
      });
      return;
    }
    if (sv.localAdded) {
      wx.showModal({
        title: '可能重复',
        content: '本机已添加过该班次。若你已在系统日历中删除，可重新添加。',
        confirmText: '仍要添加',
        cancelText: '取消',
        success: (r) => {
          if (r.confirm) this.doAdd(sv, employee.employeeId, title, startTime, endTime);
        },
      });
      return;
    }
    this.doAdd(sv, employee.employeeId, title, startTime, endTime);
  },

  doAdd(sv: ShiftView, employeeId: string, title: string, startTime: number, endTime: number) {
    const wxCtx = wx as any;
    if (typeof wxCtx.addPhoneCalendar !== 'function') {
      wx.showModal({
        title: '无法添加',
        content: '当前微信版本不支持添加手机日历，请手动在系统日历中添加。',
        showCancel: false,
      });
      return;
    }

    wxCtx.addPhoneCalendar({
      title,
      description: '由排班助手添加；如需修改或删除，请到系统日历中操作',
      startTime,
      endTime,
      alarm: sv.reminderEnabled,
      alarmOffset: CALENDAR_ALARM_OFFSET,
      success: () => {
        saveRecord({
          employeeId,
          workDate: sv.workDate,
          shiftCode: sv.shiftCode,
          title,
          startAt: sv.startAt!,
          endAt: sv.endAt!,
          fingerprint: fingerprint(title, sv.startAt!, sv.endAt!),
        });
        wx.showToast({ title: '已添加到手机日历', icon: 'success' });
        this.load();
      },
      fail: (err: any) => {
        console.warn('[calendar] addPhoneCalendar fail', err);
        const msg = String(err?.errMsg || '');
        if (msg.indexOf('auth deny') >= 0 || msg.indexOf('authorize') >= 0) {
          wx.showModal({
            title: '需要日历权限',
            content: '添加日程需要日历写入权限。你可以继续查看排班，或到设置中开启权限后重试。',
            confirmText: '去设置',
            success: (r) => {
              if (r.confirm) wxCtx.openSetting({});
            },
          });
        } else {
          wx.showModal({
            title: '添加失败',
            content: '未能添加到手机日历，你仍可正常查看排班。可稍后重试或手动添加。',
            showCancel: false,
          });
        }
      },
    });
  },

  onDismissStale(e: WechatMiniprogram.TouchEvent) {
    // 仅提示，不改动系统日历；本机记录不清除，避免误报“已处理”
    wx.showToast({ title: '请到系统日历中删除旧日程', icon: 'none' });
  },

  goBind() {
    wx.navigateTo({ url: '/pages/bind/index' });
  },

  retry() {
    this.load();
  },
});

function shiftTitle(s: MyShift): string {
  if (s.category === 'STUDY') return `学习 · ${s.label}`;
  return `上班 · ${s.label}`;
}
