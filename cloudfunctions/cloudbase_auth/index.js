/**
 * 环境共享鉴权函数：必须部署在资源方（环境 owner）环境中，函数名固定为 cloudbase_auth。
 * 调用方小程序 wx.cloud.Cloud.init() 时微信会自动调用本函数。
 *
 * 环境变量：SHARED_APPIDS = 允许调用的小程序 AppID，逗号分隔
 * 例：SHARED_APPIDS=wx318613dae09114d3
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async () => {
  const ctx = cloud.getWXContext();
  const fromApp = ctx.FROM_APPID || '';

  const allow = String(process.env.SHARED_APPIDS || process.env.SHARED_APPID || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!fromApp) {
    return { errCode: -1, errMsg: 'NO_FROM_APPID' };
  }
  if (allow.length === 0) {
    return { errCode: -1, errMsg: 'SHARED_APPIDS_NOT_CONFIGURED' };
  }
  if (!allow.includes(fromApp)) {
    return { errCode: -1, errMsg: 'APP_NOT_ALLOWED' };
  }

  return {
    errCode: 0,
    errMsg: '',
    auth: JSON.stringify({
      role: 'paiban_caller',
      fromApp,
    }),
  };
};
