import { getMe, bindInvite } from '../../services/auth';
import { toastError } from '../../utils/cloud';

Page({
  data: {
    code: '',
    submitting: false,
    state: 'CHECKING' as 'CHECKING' | 'FORM' | 'BOUND' | 'ERROR',
    employeeText: '',
    errorMsg: '',
  },

  onShow() {
    this.loadMe();
  },

  async loadMe() {
    try {
      const me = await getMe();
      const app = getApp<IAppOption>();
      app.globalData.me = me;
      app.globalData.meLoadedAt = Date.now();

      if (me.employee) {
        this.setData({
          state: 'BOUND',
          employeeText: `${me.employee.name}（工号 ${me.employee.employeeNo}）· ${me.employee.teamName}`,
        });
      } else {
        this.setData({ state: 'FORM' });
      }
    } catch (e: any) {
      this.setData({ state: 'ERROR', errorMsg: e?.message || '加载失败' });
    }
  },

  onInput(e: WechatMiniprogram.Input) {
    this.setData({ code: e.detail.value.trim() });
  },

  async onSubmit() {
    const code = this.data.code;
    if (!code) {
      wx.showToast({ title: '请输入邀请码', icon: 'none' });
      return;
    }
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    try {
      await bindInvite(code);
      wx.showToast({ title: '绑定成功', icon: 'success' });
      setTimeout(() => wx.switchTab({ url: '/pages/schedule/index' }), 600);
    } catch (e: any) {
      // 邀请无效/过期统一提示，不暴露人员是否存在
      toastError(e, '邀请码无效或已过期');
      this.setData({ code: '' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  goSchedule() {
    wx.switchTab({ url: '/pages/schedule/index' });
  },

  retry() {
    this.setData({ state: 'CHECKING' });
    this.loadMe();
  },
});
