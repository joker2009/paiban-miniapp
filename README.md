# 排班助手（微信小程序）

<img src="assets/icon-1024.png" width="96" align="right" alt="排班助手图标" />

把群里的排班图，变成每个人自己的班表。

**当前为员工自助模式**：每个员工自己选图、识别、选自己的名字、保存并加到手机日历。不需要团队、管理员、邀请码或发布流程。

> 上架用图标、简介、类目与隐私声明见 [`docs/STORE.md`](docs/STORE.md)。  
> 架构、数据模型与接口见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。  
> 部署与环境变量见 [`docs/DEPLOY.md`](docs/DEPLOY.md)。

## 功能

- **选图**：从微信聊天或相册选 1–5 张排班图
- **识别**：DeepSeek 视觉模型识别表格；日期以图片表头为准，支持跨周
- **异步任务**：创建识别任务后轮询结果，避开云函数间 15 秒调用上限
- **选自己**：识别名单可搜索；设置里的姓名/工号会优先匹配并自动选中
- **原图核对**：选人页和校对页都能查看原图并放大
- **校对保存**：可直接改每天的班次文字，设置每个班次的起止时间与提醒
- **小程序月历**：左右滑动切月（带滑入动效）、查看每天班次
- **编辑班次**：日历里点日期可编辑或删除当天班次，应对后续调班
- **系统日历**：单条添加、本周/本月批量添加，提前 30 分钟提醒

## 技术栈

- 原生微信小程序（TypeScript）
- 微信云开发：云函数、云数据库、私有存储，支持环境共享
- OCR：DeepSeek 视觉模型（OpenAI 兼容接口）
- 时区：固定 `Asia/Shanghai`

## 目录

```
miniprogram/
  app.ts / app.json / app.wxss
  config/index.ts            环境 ID、共享环境配置、限额
  pages/
    calendar/                月历首页（切月、编辑、批量加日历）
    import/                  选图 → 识别 → 选人 → 校对 → 保存
    settings/                个人设置（姓名、工号）
    schedule/ bind/ admin/   旧团队模式页面，代码保留但不在入口
  services/personal.ts       员工自助接口封装
  utils/                     日期、云调用、本机日历记录
cloudfunctions/
  paiban_api/                所有业务操作（按 op 路由）
  paiban_ocr/                DeepSeek 识别、异步任务、定时兜底
  paiban_bootstrap/          已停用（禁用桩，防止误恢复初始化能力）
  cloudbase_auth/            环境共享鉴权（部署在资源方环境）
docs/
  DEPLOY.md                  部署、环境变量、集合索引
  STORE.md                   上架图标、简介、类目
  ARCHITECTURE.md            当前架构与数据模型
tests/                       纯 Node 单测（日期/解析）
```

## 快速开始

```bash
npm install
npm run typecheck
npm test
```

1. `project.config.json` 填入 `appid`
2. `miniprogram/config/index.ts` 填入云开发环境
3. 按 `docs/DEPLOY.md` 部署两个云函数并配置环境变量
4. 开发者工具编译，授予日历相关隐私权限后开始测试

## 数据模型

| 集合 | 用途 |
| --- | --- |
| `pb_personal_schedules` | 每人每周一份文档：`openid + weekStart`，内含该周班次数组 |
| `pb_user_profiles` | 个人设置：姓名、工号、班次时间偏好 |
| `pb_ocr_tasks` | 异步识别任务：`PENDING → RUNNING → DONE / FAILED` |

首次调用 `paiban_api` 时会自动补齐全部 `pb_*` 集合（`ensureCollections`）。

旧的团队模式集合（`pb_teams`、`pb_admins`、`pb_importJobs` 等）仍可能存在，但当前流程不再读写。

## 接口（`paiban_api`）

| 操作 | 说明 |
| --- | --- |
| `auth.getMe` | 取 openid（不涉及角色/绑定） |
| `personal.getMine` | 按日期范围读取自己的班次与设置 |
| `personal.saveWeek` | 保存/合并班次，按实际日期分组到周 |
| `personal.saveShift` / `personal.deleteShift` | 编辑/删除单天班次 |
| `personal.recognize` | 创建识别任务，返回 `taskId` |
| `personal.getRecognizeTask` | 轮询识别结果 |
| `personal.getProfile` / `personal.saveProfile` | 读取/保存姓名、工号与班次偏好 |

旧的 `admin.*`、`import.*`、`draft.*`、`release.*`、`schedule.*` 操作仍保留在代码里，但当前入口不再使用。

## OCR 流程

1. 客户端上传图片到 `imports/personal/<openid>/...`
2. `personal.recognize` 建任务并唤醒 `paiban_ocr`
3. `paiban_ocr` 下载图片，调用 DeepSeek，返回 `dates + employees + cells`
4. 客户端每 2 秒轮询 `personal.getRecognizeTask`，单图最多等 3 分钟
5. 定时触发器每 20 秒兜底处理未启动的任务

关键参数：

- `DEEPSEEK_MODEL=deepseek-flash`
- `thinking: { type: "disabled" }`（关闭推理，避免 token 被思维链吃光）
- 提示词要求先输出图片表头的 `dates`，`cells` 按列对齐
- 两个函数超时 60 秒

## 已知边界

- 识别按图片表头的日期写入；完全读不到日期时才回退到所选周
- 同一员工同一天只保存一条班次
- 微信不开放修改/删除系统日历事件：调班后需手动删除旧日程再重新添加
- 批量写系统日历受微信/系统限制，失败可重试或逐条添加
- 上传原图目前保留在云存储，尚未做自动清理
- 旧的管理员/邀请码/发布能力不在入口中展示
