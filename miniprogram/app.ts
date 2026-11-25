import { CLOUD_ENV_ID } from './config/index';

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
    wx.cloud.init({
      env: CLOUD_ENV_ID,
      traceUser: true,
    });
  },
});
