import { initCloud } from './utils/cloud';

App<IAppOption>({
  globalData: {
    me: null,
    meLoadedAt: 0,
  },
  onLaunch() {
    if (!wx.cloud) {
      console.error('[app] 基础库版本过低，无法使用云开发能力');
      return;
    }
    initCloud().catch((e) => {
      console.error('[app] 云环境初始化失败', e);
    });
  },
});
