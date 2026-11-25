# 部署与验收

## 1. 前置

- 微信小程序 AppID（已关联云开发）
- 云开发环境 ID（测试/生产分开）
- DeepSeek API Key（模型需支持图片输入）
- 微信开发者工具（已安装）

## 2. 替换配置

| 位置 | 字段 |
| --- | --- |
| `project.config.json` | `appid` |
| `miniprogram/config/index.ts` | `CLOUD_ENV_ID` |
| `miniprogram/config/index.ts` | `MAX_IMAGES_PER_JOB` / `MAX_IMAGE_BYTES`（与云函数环境变量保持一致） |

## 3. 安装依赖与部署云函数

```bash
cd cloudfunctions/api && npm install
cd ../ocr && npm install
cd ../bootstrap && npm install
```

在开发者工具里分别右键 `api`、`ocr`、`bootstrap` 目录 → **上传并部署：云端安装依赖**。

`ocr` 还需要上传触发器：右键 `ocr` → **上传触发器**（`config.json` 中每分钟轮询 `PENDING_OCR`）。

三个函数的运行内存建议 256MB；`ocr` 超时时间建议在云控制台调到 60 秒（识别密集表格时可再加大）。

## 4. 环境变量

在云开发控制台 → 云函数 → 对应函数 → 配置 → 环境变量。

**api**

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `INVITE_PEPPER` | 是 | 邀请码摘要盐值，随机长串，与 bootstrap 保持一致 |
| `INTERNAL_TOKEN` | 是 | api 唤醒 ocr 的内部令牌，与 ocr 保持一致 |
| `MAX_IMAGE_BYTES` | 否 | 单图上限，默认 10485760（10MB） |

**ocr**

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 是 | DeepSeek API Key |
| `DEEPSEEK_MODEL` | 是 | 支持图片输入的模型名 |
| `DEEPSEEK_BASE_URL` | 否 | 默认 `https://api.deepseek.com` |
| `DEEPSEEK_MAX_TOKENS` | 否 | 默认 8000；大团队周表可调大 |
| `INTERNAL_TOKEN` | 是 | 与 api 一致 |

**bootstrap**（初始化完成后删除）

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `BOOTSTRAP_TOKEN` | 是 | 随机长串，调用时传入 |
| `INVITE_PEPPER` | 是 | 与 api 一致 |

## 5. 数据库集合与权限

集合会在首次写入时自动创建，也可先在控制台建好。**所有集合都必须关闭客户端直接读写**，只允许云函数访问。

权限设置选择「自定义安全规则」：

```json
{ "read": false, "write": false }
```

需要设置的集合：

`teams`、`employees`、`bindings`、`admins`、`invites`、`shiftTypes`、`importJobs`、`draftCells`、`releaseVersions`、`publishedShifts`、`weekPointers`、`auditLogs`、`idempotency`

## 6. 索引（控制台 → 数据库 → 索引管理）

| 集合 | 索引字段 | 唯一 |
| --- | --- | --- |
| `employees` | `teamId, employeeNo` | 是 |
| `employees` | `teamId, createdAt` | 否 |
| `admins` | `openid, teamId` | 是 |
| `bindings` | `openid, status` | 否（唯一性由云函数保证，便于未来解绑留痕） |
| `bindings` | `employeeId, status` | 否 |
| `invites` | `tokenHash` | 是 |
| `invites` | `teamId, expiresAt` | 否 |
| `shiftTypes` | `teamId, code` | 是 |
| `importJobs` | `teamId, weekStart, createdAt` | 否 |
| `importJobs` | `status, updatedAt` | 否 |
| `draftCells` | `jobId, status` | 否 |
| `draftCells` | `jobId, rowKey, workDate` | 否 |
| `publishedShifts` | `releaseId, employeeId` | 否 |
| `publishedShifts` | `employeeId, workDate` | 否 |
| `releaseVersions` | `teamId, weekStart, version` | 否 |
| `weekPointers` | 无需（按 `_id` 读取） | — |
| `auditLogs` | `teamId, createdAt` | 否 |

## 7. 初始化数据

1. 先在小程序里运行一次，取到自己的 openid：

```js
// 开发者工具 Console
wx.cloud.callFunction({ name: 'api', data: { op: 'auth.getMe' } }).then(console.log)
```

2. 调用 `bootstrap`（开发者工具 Console 或云控制台「云函数测试」）：

```js
wx.cloud.callFunction({
  name: 'bootstrap',
  data: { token: '<BOOTSTRAP_TOKEN>', action: 'initTeam', name: '示例团队', adminOpenid: '<你的openid>' }
}).then(console.log) // 记住返回的 teamId
```

```js
wx.cloud.callFunction({
  name: 'bootstrap',
  data: { token: '<BOOTSTRAP_TOKEN>', action: 'seedShiftTypes', teamId: '<teamId>' }
}).then(console.log)
```

```js
wx.cloud.callFunction({
  name: 'bootstrap',
  data: {
    token: '<BOOTSTRAP_TOKEN>', action: 'seedEmployees', teamId: '<teamId>',
    employees: [{ employeeNo: '0001', name: '张三' }, { employeeNo: '0002', name: '李四' }]
  }
}).then(console.log)
```

3. 生成一个测试邀请码（正式流程用管理员页「发邀请码」）：

```js
wx.cloud.callFunction({
  name: 'bootstrap',
  data: { token: '<BOOTSTRAP_TOKEN>', action: 'makeInviteCode', employeeId: '<employeeId>' }
}).then(console.log)
```

4. **初始化完成后删除 `bootstrap` 云函数**，不要留在生产环境。

## 8. OCR 说明

- 识别函数按图逐张调用 DeepSeek 视觉接口，要求返回严格 JSON（员工/工号/7 天单元格/原文/置信度/矩形）。
- 返回结果会按工号精确匹配花名册；空白、未知班次、低置信度、日期异常、未匹配员工都会进入「待校对」，不会自动发布。
- 多图同员工同日冲突会保留两处来源并标记冲突，管理员选定后其余自动作废。
- 图片过大（base64 后体积膨胀）可能触发上游限制：建议限制单图 < 5MB；可通过 `MAX_IMAGE_BYTES` 收紧。
- 若模型不支持图片输入，图片会标记 `OCR_FAILED` 并给出可诊断错误；可更换 `DEEPSEEK_MODEL` 后点「重试」。
- 原图与完整 OCR 文本默认 7 天后由 `ocr` 定时清理，已发布排班与人工确认结果保留。

## 9. 真机验收（与设计文档 AC 对应）

| 编号 | 场景 | 通过标准 |
| --- | --- | --- |
| AC-01 | 聊天选图 / 相册选图 / 取消 | 能从微信聊天手动选图；相册可兜底；取消不建任务、不上传 |
| AC-02 | OCR 行列错位 | 日期、工号、班次逐格核对；模糊/缺列/错误星期/未知班次能定位异常 |
| AC-03 | 多图、重复、部分失败 | 重复提示；冲突需确认；单图可重试；未覆盖的老班次不被删除 |
| AC-04 | 夜班、休息、跨日 | 夜班按开始日展示；凌晨能看到上一日夜班；休息无添加按钮 |
| AC-05 | 员工/团队隔离 | 员工 A 读不到 B 的排班与原图；团队管理员不能跨团队 |
| AC-06 | 重复发布与并发 | 同一 requestId 不生成第二版；并发发布只有一份生效；失败时员工只见旧版本 |
| AC-07 | 原生日历与失败回退 | 真机日历起止正确、提前 30 分钟提醒；拒绝授权仍可查看排班且不标记“已添加” |
| AC-08 | 调班后的本机提醒 | 看到最新结果；旧记录给出人工清理提示；未变更班次不重复添加 |
| AC-09 | 数据保护与清理 | 存储无公开读地址；越权被拒；超期原图清理后已发布排班仍可查 |

真机重点：`wx.chooseMessageFile` 与 `wx.addPhoneCalendar` 在开发者工具里不能作为验收依据，必须在 iPhone 与至少一台团队常用安卓机上走查并记录系统/微信版本。

## 10. 上线前业务方提供

- AppID、云环境、可部署人员
- 授权团队、管理员名单、员工花名册（工号）
- 完整班次与符号字典（尤其夜班、学习），示例时间不能代替真实规则
- 一期未来排班、脱敏验收样图、数据保留期限、获批 OCR 服务
- 没有生产配置时使用独立测试环境与虚构数据
