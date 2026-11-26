import { getMe } from '../../services/auth';
import { listJobs } from '../../services/importJob';
import { listHistory } from '../../services/release';
import { today, mondayOf, addDays, displayDate, dateRange } from '../../utils/date';
import { toastError } from '../../utils/cloud';
import type { MeInfo, ImportJob } from '../../types/index';

interface JobView extends ImportJob {
  statusLabel: string;
  statusClass: string;
  icon: string;
  updatedText: string;
}

const STATUS_MAP: Record<string, { label: string; cls: string; icon: string }> = {
  UPLOADING: { label: '上传中', cls: 'tag-muted', icon: '···' },
  PENDING_OCR: { label: '等待识别', cls: 'tag-muted', icon: '…' },
  RECOGNIZING: { label: '识别中', cls: 'tag', icon: '◌' },
  NEEDS_REVIEW: { label: '待校对', cls: 'tag-warn', icon: '!' },
  READY: { label: '可发布', cls: 'tag-success', icon: '✓' },
  PUBLISHED: { label: '已发布', cls: 'tag-success', icon: '✓' },
  FAILED: { label: '处理失败', cls: 'tag-danger', icon: '×' },
};

Page({
  data: {
    loading: true,
    noAccess: false,
    errorMsg: '',
    teams: [] as Array<{ teamId: string; teamName: string }>,
    teamIndex: 0,
    teamId: '',
    teamName: '',
    weekStart: '',
    weekLabel: '',
    jobs: [] as JobView[],
    currentVersion: 0,
    lastPublishedAt: '',
  },

  _me: null as MeInfo | null,

  onShow() {
    this.init();
  },

  async onPullDownRefresh() {
    await this.loadWeek();
    wx.stopPullDownRefresh();
  },

  async init() {
    this.setData({ loading: true, errorMsg: '' });
    try {
      const me = await getMe();
      this._me = me;
      if (me.adminTeams.length === 0) {
        this.setData({ loading: false, noAccess: true });
        return;
      }
      const cur = this.data.teamId;
      const idx = cur ? Math.max(0, me.adminTeams.findIndex((t) => t.teamId === cur)) : 0;
      const team = me.adminTeams[idx];
      const weekStart = this.data.weekStart || mondayOf(today());
      this.setData({
        teams: me.adminTeams,
        teamIndex: idx,
        teamId: team.teamId,
        teamName: team.teamName,
        weekStart,
        weekLabel: weekLabel(weekStart),
      });
      await this.loadWeek();
    } catch (e: any) {
      this.setData({ loading: false, errorMsg: e?.message || '加载失败' });
    }
  },

  async loadWeek() {
    const { teamId, weekStart } = this.data;
    if (!teamId || !weekStart) return;
    this.setData({ loading: true });
    try {
      const [jobsRes, historyRes] = await Promise.all([
        listJobs(teamId, weekStart),
        listHistory(teamId, weekStart),
      ]);
      const jobs: JobView[] = jobsRes.items.map((j) => {
        const meta = STATUS_MAP[j.status] || { label: j.status, cls: 'tag-muted', icon: '·' };
        return {
          ...j,
          statusLabel: meta.label,
          statusClass: meta.cls,
          icon: meta.icon,
          updatedText: j.updatedAt ? j.updatedAt.slice(5, 16).replace('T', ' ') : '',
        };
      });
      const latest = historyRes.items[0];
      this.setData({
        loading: false,
        jobs,
        currentVersion: latest ? latest.version : 0,
        lastPublishedAt: latest ? latest.publishedAt.slice(5, 16).replace('T', ' ') : '',
      });
    } catch (e: any) {
      this.setData({ loading: false, errorMsg: e?.message || '加载失败' });
    }
  },

  onTeamChange(e: WechatMiniprogram.PickerChange) {
    const idx = Number(e.detail.value);
    const team = this.data.teams[idx];
    if (!team) return;
    this.setData({ teamIndex: idx, teamId: team.teamId, teamName: team.teamName });
    this.loadWeek();
  },

  prevWeek() {
    this.setData({ weekStart: addDays(this.data.weekStart, -7), weekLabel: weekLabel(addDays(this.data.weekStart, -7)) });
    this.loadWeek();
  },

  nextWeek() {
    const next = addDays(this.data.weekStart, 7);
    this.setData({ weekStart: next, weekLabel: weekLabel(next) });
    this.loadWeek();
  },

  goImport() {
    if (!this.data.teamId) {
      wx.showToast({ title: '团队信息加载中，请稍后重试', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url:
        `/pages/admin/import/index?teamId=${this.data.teamId}` +
        `&weekStart=${this.data.weekStart}` +
        `&teamName=${encodeURIComponent(this.data.teamName)}`,
    });
  },

  goShifts() {
    wx.navigateTo({ url: `/pages/admin/shifts/index?teamId=${this.data.teamId}` });
  },

  goMembers() {
    wx.navigateTo({ url: `/pages/admin/members/index?teamId=${this.data.teamId}` });
  },

  openJob(e: WechatMiniprogram.TouchEvent) {
    const { jobid } = e.currentTarget.dataset as { jobid: string };
    wx.navigateTo({
      url: `/pages/admin/review/index?jobId=${jobid}&teamId=${this.data.teamId}&weekStart=${this.data.weekStart}`,
    });
  },

  retry() {
    this.init();
  },
});

function weekLabel(weekStart: string): string {
  const end = addDays(weekStart, 6);
  return `${weekStart.slice(5)} ~ ${end.slice(5)}`;
}
