import {
  listEmployees,
  saveEmployee,
  issueInvite,
  revokeInvite,
  listInvites,
  type InviteInfo,
} from '../../../services/admin';
import { toastError } from '../../../utils/cloud';
import type { Employee } from '../../../types/index';

Page({
  data: {
    teamId: '',
    loading: true,
    items: [] as Employee[],
    nextCursor: null as string | null,
    invites: [] as InviteInfo[],

    addModal: { visible: false, employeeNo: '', name: '' },
    codeModal: { visible: false, code: '', employeeName: '', expiresAt: '' },
    busy: false,
  },

  onLoad(options: Record<string, string>) {
    this.setData({ teamId: options.teamId || '' });
    this.load(true);
  },

  async load(reset: boolean) {
    this.setData({ loading: true });
    try {
      const cursor = reset ? undefined : this.data.nextCursor || undefined;
      const [empRes, inviteRes] = await Promise.all([
        listEmployees(this.data.teamId, cursor),
        reset ? listInvites(this.data.teamId) : Promise.resolve({ items: this.data.invites }),
      ]);
      this.setData({
        loading: false,
        items: reset ? empRes.items : this.data.items.concat(empRes.items),
        nextCursor: empRes.nextCursor,
        invites: inviteRes.items,
      });
    } catch (e) {
      this.setData({ loading: false });
      toastError(e);
    }
  },

  loadMore() {
    if (this.data.nextCursor) this.load(false);
  },

  openAdd() {
    this.setData({ addModal: { visible: true, employeeNo: '', name: '' } });
  },

  closeAdd() {
    this.setData({ 'addModal.visible': false });
  },

  onField(e: WechatMiniprogram.Input) {
    const field = String(e.currentTarget.dataset.field);
    this.setData({ [`addModal.${field}`]: e.detail.value });
  },

  async onAddSubmit() {
    const { employeeNo, name } = this.data.addModal;
    if (!employeeNo.trim() || !name.trim()) {
      wx.showToast({ title: '工号和姓名不能为空', icon: 'none' });
      return;
    }
    this.setData({ busy: true });
    try {
      await saveEmployee({
        teamId: this.data.teamId,
        employeeNo: employeeNo.trim(),
        name: name.trim(),
        status: 'ACTIVE',
      });
      this.setData({ 'addModal.visible': false });
      wx.showToast({ title: '已添加', icon: 'success' });
      await this.load(true);
    } catch (e) {
      toastError(e);
    } finally {
      this.setData({ busy: false });
    }
  },

  async onToggleStatus(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id);
    const emp = this.data.items.find((x) => x._id === id);
    if (!emp) return;
    const next = emp.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    const confirmed = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: next === 'DISABLED' ? '停用员工' : '启用员工',
        content: next === 'DISABLED'
          ? `停用后 ${emp.name} 将无法查看排班，已发放的邀请码同时失效。`
          : `恢复 ${emp.name} 的绑定资格。`,
        success: (r) => resolve(r.confirm),
      });
    });
    if (!confirmed) return;
    try {
      await saveEmployee({
        teamId: this.data.teamId,
        employeeId: id,
        employeeNo: emp.employeeNo,
        name: emp.name,
        status: next,
      });
      await this.load(true);
    } catch (err) {
      toastError(err);
    }
  },

  async onIssue(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id);
    const emp = this.data.items.find((x) => x._id === id);
    if (!emp) return;
    this.setData({ busy: true });
    try {
      const res = await issueInvite(id);
      this.setData({
        codeModal: {
          visible: true,
          code: res.inviteCode,
          employeeName: emp.name,
          expiresAt: res.expiresAt.slice(0, 16).replace('T', ' '),
        },
      });
      await this.load(true);
    } catch (err) {
      toastError(err);
    } finally {
      this.setData({ busy: false });
    }
  },

  copyCode() {
    wx.setClipboardData({
      data: this.data.codeModal.code,
      success: () => wx.showToast({ title: '已复制', icon: 'success' }),
    });
  },

  closeCode() {
    this.setData({ 'codeModal.visible': false });
  },

  async onRevoke(e: WechatMiniprogram.TouchEvent) {
    const inviteId = String(e.currentTarget.dataset.id);
    try {
      await revokeInvite(inviteId);
      wx.showToast({ title: '已撤销', icon: 'success' });
      await this.load(true);
    } catch (err) {
      toastError(err);
    }
  },
});
