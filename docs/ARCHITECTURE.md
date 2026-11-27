# 当前架构（员工自助模式）

## 1. 角色与数据边界

- 没有管理员、团队、邀请码、发布版本。
- 每个微信用户只能读写自己的排班与设置，身份来自云函数受信任上下文（共享环境取 `FROM_OPENID`）。
- 前端传入的 openid / 姓名只作为查询条件，不作为权限依据。

## 2. 主流程

```
选图（聊天/相册）
  → 上传云存储 imports/personal/<openid>/
  → personal.recognize 创建 pb_ocr_tasks（PENDING）
  → paiban_ocr 处理任务（RUNNING → DONE/FAILED）
  → 客户端轮询 personal.getRecognizeTask
  → 识别名单（可搜索，设置姓名优先）
  → 校对每天文字、设置班次时间
  → personal.saveWeek 按 workDate 分周写入
  → 月历查看 / 编辑 / 批量写系统日历
```

## 3. 集合

### `pb_personal_schedules`

一人一周一条，`_id = <openid>_<weekStart>`。

```json
{
  "openid": "o...",
  "weekStart": "2026-11-30",
  "employeeName": "张三",
  "employeeNo": "0001",
  "shifts": [
    {
      "workDate": "2026-11-30",
      "label": "夜",
      "category": "WORK",
      "startLocal": "20:00",
      "endLocal": "06:00",
      "endDayOffset": 1,
      "startAt": "2026-11-30T20:00:00+08:00",
      "endAt": "2026-12-01T06:00:00+08:00",
      "reminderEnabled": true
    }
  ]
}
```

- 图片日期可能跨周，`saveWeek` 会按 `workDate` 分组写多个周文档。
- 合并策略：只覆盖本次导入涉及的日期；本次为空则删除旧记录，其他日期保留。
- `saveShift` / `deleteShift` 只改单天，不改姓名和偏好。

### `pb_user_profiles`

`_id = openid`，保存 `employeeName`、`employeeNo`、`shiftTypes[]`（每个班次标签的默认起止时间、是否提醒）。

### `pb_ocr_tasks`

```json
{
  "openid": "o...",
  "fileID": "cloud://...",
  "weekStart": "2026-11-23",
  "status": "PENDING | RUNNING | DONE | FAILED",
  "dates": ["2026-11-30", "..."],
  "rows": [{ "employeeNo": "", "name": "", "cells": [{ "date": "", "text": "" }] }],
  "notes": "",
  "error": null
}
```

- API 创建后立即唤醒 `paiban_ocr`，定时触发器每 20 秒兜底。
- `RUNNING` 超过 5 分钟会被重置为 `PENDING`。

## 4. 云函数

### `paiban_api`

按 `op` 路由，统一返回 `{ ok, data | code, message, requestId }`。

| 操作 | 作用 |
| --- | --- |
| `auth.getMe` | 返回 openid（员工自助不需要角色） |
| `personal.getMine` | 读取日期范围内的班次与设置 |
| `personal.saveWeek` | 批量保存，按实际日期分周合并 |
| `personal.saveShift` / `personal.deleteShift` | 编辑/删除单天 |
| `personal.recognize` / `getRecognizeTask` | 异步识别任务 |
| `personal.getProfile` / `saveProfile` | 姓名、工号、班次偏好 |

冷启动会执行 `ensureCollections()`，确保全部 `pb_*` 集合存在（云数据库 `add` 不会自动建集合）。

### `paiban_ocr`

- `action: "recognizeTask"`：处理异步任务并写回结果。
- 定时触发器：回收卡住任务、处理 `PENDING` 任务、清理旧图（旧逻辑）。
- 识别参数：`DEEPSEEK_MODEL=deepseek-flash`、`DEEPSEEK_THINKING=disabled`、`max_tokens=4000`。
- 输出先解析图片表头 `dates`，再按列对齐员工 `cells`；只有月/日时按参考年份就近推断。
- 原图逐格日期作为补充；仍取不到日期才回退到调用方传入的 `weekStart`。

### `paiban_bootstrap`

已停用，仓库与云端均为禁用桩。团队模式如需恢复，从 git 历史取回。

### `cloudbase_auth`

环境共享鉴权函数，部署在资源方环境，校验 `FROM_APPID` 是否在 `SHARED_APPIDS` 白名单。

## 5. 系统日历

- 使用 `wx.addPhoneCalendar`，必须在点击回调内调用，提前 30 分钟。
- 只新增，不能读取、修改或删除系统日历事件。
- 本机记录用 `openid + workDate` 和内容指纹（标题/起止/提前量）判断「已添加」；编辑后指纹变化，会重新出现「加日历」。
- 批量添加从点击回调立刻发起第一条，其余顺序执行；权限拒绝会中断并提示。

## 6. 安全与隐私

- 所有查询按 `openid` 限定；识别文件路径校验 `imports/personal/<openid>/`。
- 数据库集合关闭客户端直接读写，只允许云函数访问。
- 原图只在识别页/校对页通过临时地址预览，不公开。
- 云函数密钥只放环境变量，不进入代码和仓库。
