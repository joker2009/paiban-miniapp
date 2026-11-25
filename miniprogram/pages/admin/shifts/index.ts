import { listShiftTypes, saveShiftType } from '../../../services/admin';
import { toastError } from '../../../utils/cloud';
import type { ShiftType } from '../../../types/index';

const CATEGORIES = [
  { key: 'WORK', label: '工作' },
  { key: 'OFF', label: '休息' },
  { key: 'STUDY', label: '学习' },
] as const;

interface ShiftForm {
  visible: boolean;
  shiftTypeId: string;
  code: string;
  label: string;
  aliasesText: string;
  categoryIndex: number;
  startLocal: string;
  endLocal: string;
  endDayOffsetIndex: number;
  reminderEnabled: boolean;
  enabled: boolean;
  revision: number;
}

const EMPTY_FORM: ShiftForm = {
  visible: false,
  shiftTypeId: '',
  code: '',
  label: '',
  aliasesText: '',
  categoryIndex: 0,
  startLocal: '',
  endLocal: '',
  endDayOffsetIndex: 0,
  reminderEnabled: true,
  enabled: true,
  revision: 0,
};

Page({
  data: {
    teamId: '',
    loading: true,
    items: [] as ShiftType[],
    categories: CATEGORIES.map((c) => c.label),
    dayOffsets: ['当天', '次日'],
    form: { ...EMPTY_FORM } as ShiftForm,
    busy: false,
  },

  onLoad(options: Record<string, string>) {
    this.setData({ teamId: options.teamId || '' });
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      const res = await listShiftTypes(this.data.teamId);
      this.setData({ loading: false, items: res.items });
    } catch (e) {
      this.setData({ loading: false });
      toastError(e);
    }
  },

  openCreate() {
    this.setData({ form: { ...EMPTY_FORM, visible: true } });
  },

  openEdit(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id);
    const s = this.data.items.find((x) => x._id === id);
    if (!s) return;
    this.setData({
      form: {
        visible: true,
        shiftTypeId: s._id,
        code: s.code,
        label: s.label,
        aliasesText: (s.aliases || []).join('、'),
        categoryIndex: Math.max(0, CATEGORIES.findIndex((c) => c.key === s.category)),
        startLocal: s.startLocal || '',
        endLocal: s.endLocal || '',
        endDayOffsetIndex: s.endDayOffset === 1 ? 1 : 0,
        reminderEnabled: s.reminderEnabled,
        enabled: s.enabled,
        revision: s.revision,
      },
    });
  },

  closeForm() {
    this.setData({ 'form.visible': false });
  },

  onField(e: WechatMiniprogram.Input) {
    const field = String(e.currentTarget.dataset.field);
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  onCategory(e: WechatMiniprogram.PickerChange) {
    const idx = Number(e.detail.value);
    const patch: Record<string, any> = { 'form.categoryIndex': idx };
    if (CATEGORIES[idx].key === 'OFF') {
      patch['form.startLocal'] = '';
      patch['form.endLocal'] = '';
      patch['form.endDayOffsetIndex'] = 0;
      patch['form.reminderEnabled'] = false;
    }
    this.setData(patch);
  },

  onStartTime(e: WechatMiniprogram.PickerChange) {
    this.setData({ 'form.startLocal': e.detail.value });
  },

  onEndTime(e: WechatMiniprogram.PickerChange) {
    this.setData({ 'form.endLocal': e.detail.value });
  },

  onDayOffset(e: WechatMiniprogram.PickerChange) {
    this.setData({ 'form.endDayOffsetIndex': Number(e.detail.value) });
  },

  onReminder(e: WechatMiniprogram.SwitchChange) {
    this.setData({ 'form.reminderEnabled': e.detail.value });
  },

  onEnabled(e: WechatMiniprogram.SwitchChange) {
    this.setData({ 'form.enabled': e.detail.value });
  },

  async onSubmit() {
    const f = this.data.form;
    if (this.data.busy) return;
    if (!f.code.trim() || !f.label.trim()) {
      wx.showToast({ title: '编码和名称不能为空', icon: 'none' });
      return;
    }
    const category = CATEGORIES[f.categoryIndex].key;
    if (category === 'WORK' && (!f.startLocal || !f.endLocal)) {
      wx.showToast({ title: '工作班次必须填写起止时间', icon: 'none' });
      return;
    }

    this.setData({ busy: true });
    try {
      await saveShiftType({
        teamId: this.data.teamId,
        shiftTypeId: f.shiftTypeId || undefined,
        code: f.code.trim(),
        label: f.label.trim(),
        aliases: f.aliasesText
          .split(/[、,，\s]+/)
          .map((x) => x.trim())
          .filter(Boolean),
        category,
        startLocal: f.startLocal || null,
        endLocal: f.endLocal || null,
        endDayOffset: (f.endDayOffsetIndex === 1 ? 1 : 0) as 0 | 1,
        reminderEnabled: f.reminderEnabled,
        enabled: f.enabled,
        revision: f.shiftTypeId ? f.revision : undefined,
      });
      wx.showToast({ title: '已保存', icon: 'success' });
      this.setData({ 'form.visible': false });
      await this.load();
    } catch (e) {
      toastError(e);
    } finally {
      this.setData({ busy: false });
    }
  },
});
