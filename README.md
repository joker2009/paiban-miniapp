# 排班助手（微信小程序）

<img src="assets/icon-1024.png" width="96" align="right" alt="排班助手图标" />

从微信聊天选图 → OCR 识别排班表 → 选自己 → 校对保存 → 月历查看并添加到手机日历。

> 当前为**员工自助模式**：不需要团队、管理员、邀请码或发布流程。管理员相关页面仅保留代码，不在入口中展示。

> 上架用图标、简介、类目与隐私声明见 [`docs/STORE.md`](docs/STORE.md)。

- 技术栈：原生微信小程序（TypeScript）+ 微信云开发（云函数 / 云数据库 / 私有存储，支持环境共享）
- OCR：DeepSeek 视觉大模型（OpenAI 兼容接口），可插拔；开发联调用 `cloudfunctions/paiban_ocr`
- 设计依据：`排班助手小程序设计文档.md`（v1.0 MVP）
- 时区：固定 `Asia/Shanghai`，一周为周一至周日

## 目录

```
miniprogram/                 小程序（原生 TS）
  app.ts / app.json / app.wxss
  config/index.ts            环境 ID、限额（需要替换 CLOUD_ENV_ID）
  pages/
    schedule/                我的排班（员工）
    bind/                    个人绑定（邀请码）
    admin/                   排班管理（管理员）
      import/                导入排班图（聊天选图 / 相册）
      review/                校对与发布
      shifts/                班次字典
      members/               成员与邀请码
  services/                  云函数调用封装
  utils/                     日期、云调用、本机日历记录
cloudfunctions/
  paiban_api/                所有业务操作（按 op 路由）
  paiban_ocr/                DeepSeek 识别 + 定时兜底 + 原图过期清理
  paiban_bootstrap/          一次性初始化（用完删除）
  cloudbase_auth/            环境共享鉴权（部署在资源方环境）
tests/                       纯 Node 单测（日期/解析）
docs/DEPLOY.md               部署、环境变量、集合索引、真机验收
```

## 快速开始

```bash
npm install
npm run typecheck
npm test
```

1. `project.config.json` 填入你的 `appid`。
2. `miniprogram/config/index.ts` 填入云开发 `CLOUD_ENV_ID`。
3. 用微信开发者工具打开本目录，按 `docs/DEPLOY.md` 部署云函数、配置环境变量和数据库权限。
4. 用 `paiban_bootstrap` 云函数建团队/管理员/示例班次/员工，给员工发邀请码。

## 关键约束（与设计文档一致）

- 身份只取云函数受信任上下文；前端传入的 `openid`/角色/员工 ID 一律不信任。
- 员工只能读自己的已发布排班；原图、草稿、花名册仅管理员可见。
- 发布采用「先写完整快照 → 校验数量 → 事务切换版本指针」，发布幂等键去重。
- 草稿乐观锁 `revision`；并发发布返回 `VERSION_CONFLICT`。
- 添加到手机日历必须从点击回调内调用 `wx.addPhoneCalendar`，提前 30 分钟；仅回调成功后记本机添加记录。
- 原图与完整 OCR 文本默认保留 7 天，不影响已发布结构化排班。

## 云函数操作（`paiban_api`）

`auth.getMe` / `auth.bindInvite`；`admin.listEmployees|saveEmployee|issueInvite|revokeInvite|listInvites|listShiftTypes|saveShiftType`；`import.createJob|submitJob|listJobs|getJob|retryFailed|removeFailedImage|getImagePreview`；`draft.listCells|saveCells|linkRow`；`release.preview|publish|listHistory`；`schedule.getMine`。

统一返回 `{ ok, data | code, message, requestId }`；错误码含 `FORBIDDEN`、`INVITE_INVALID`、`FILE_INVALID`、`OCR_FAILED`、`REVIEW_REQUIRED`、`DRAFT_CONFLICT`、`VERSION_CONFLICT`。

## 已知边界（首版）

- 一周一个团队一个当前发布版本；同一员工同一天最多一个班次。
- 班次字典示例时间仅用于联调，不能直接作为真实配置上线。
- 不监听微信群、不自动发布、不读写系统日历（只调用系统提供的“添加日程”）。
- 小程序关闭时不做主动调班推送；员工打开或刷新「我的排班」时呈现变更。
