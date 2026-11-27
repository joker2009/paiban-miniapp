import { getProfile, saveProfile } from '../../services/personal';
import { toastError } from '../../utils/cloud';

Page({
  data: {
    loading: true,
    name: '',
    employeeNo: '',
    saving: false,
  },

  onLoad() {
    this.load();
  },

  async load() {
    try {
      const res = await getProfile();
      const p = res.profile;
      this.setData({
        loading: false,
        name: (p && p.employeeName) || '',
        employeeNo: (p && p.employeeNo) || '',
      });
    } catch (e) {
      this.setData({ loading: false });
      toastError(e, '加载失败');
    }
  },

  onField(e: WechatMiniprogram.Input) {
    const field = String(e.currentTarget.dataset.field);
    this.setData({ [field]: e.detail.value });
  },

  async save() {
    const name = this.data.name.trim();
    if (!name) {
      wx.showToast({ title: '请输入姓名', icon: 'none' });
      return;
    }
    if (this.data.saving) return;

    this.setData({ saving: true });
    try {
      await saveProfile({
        name,
        employeeNo: this.data.employeeNo.trim() || undefined,
      });
      wx.showToast({ title: '已保存', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 500);
    } catch (e) {
      toastError(e, '保存失败');
    } finally {
      this.setData({ saving: false });
    }
  },
});
