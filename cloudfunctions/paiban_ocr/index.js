const cloud = require('wx-server-sdk');
const { chatVision } = require('./lib/deepseek');
const { parseRecognition } = require('./lib/parse');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const $ = db.command.aggregate;

const C = {
  jobs: 'pb_importJobs',
  cells: 'pb_draftCells',
  employees: 'pb_employees',
  shiftTypes: 'pb_shiftTypes',
  tasks: 'pb_ocr_tasks',
};


/** 集合未创建时按空结果处理 */
async function safeGet(query) {
  try {
    return await query.get();
  } catch (err) {
    const code = err && (err.errCode || err.code);
    const msg = String((err && (err.errMsg || err.message)) || '');
    if (code === -502005 || /collection.*not exist/i.test(msg) || /集合不存在/.test(msg)) {
      return { data: [] };
    }
    throw err;
  }
}

const WEEK_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const MAX_JOBS_PER_TICK = 2;
const STALE_MS = 3 * 60 * 1000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function pad(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function weekDates(weekStart) {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

function normalizeShiftText(text) {
  return String(text || '')
    .replace(/[\s　]+/g, '')
    .replace(/[。．.、，,;；]+$/g, '')
    .toUpperCase();
}

function mimeOf(buf, fileID) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.slice(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF') return 'image/webp';
  if (/\.png($|\?)/i.test(fileID)) return 'image/png';
  return 'image/jpeg';
}

function buildPrompt(weekStart) {
  const year = weekStart.slice(0, 4);
  return [
    '你是排班表识别器。输入是一张排班表图片，只输出 JSON，不要输出任何解释或 Markdown 代码块。',
    '请先读取图片表头中的日期，再按列顺序输出。',
    '输出结构（尽量紧凑，不要额外字段）：',
    '{"dates":["YYYY-MM-DD","..."],"employees":[{"employeeNo":"工号字符串，保留前导零","name":"姓名","cells":["该列班次原文或空字符串","..."]}]}',
    '规则：',
    '1. dates 必须来自图片表头，按从左到右的列顺序；绝对不要使用任何用户提供的周次。',
    '2. 表头只有月/日时，年份按 ' + year + ' 推断；dates 数量 = 表头日期列数。',
    '3. 每个员工的 cells 数量与 dates 完全一致，按同一列顺序；空白列写空字符串。',
    '4. employeeNo 必须来自图片，不要自行补零或改号；姓名仅作参考。',
    '5. text 只保留该格班次原文或符号，不翻译、不猜测。',
    '6. 每人一行；忽略组名、分隔行、备注、加班和欠休列。',
    '7. 看不清就输出空字符串，不要编造。',
  ].join('\n');
}

async function recognizeImage(job, image, pageIndex) {
  const dl = await cloud.downloadFile({ fileID: image.fileID });
  const buf = dl.fileContent;
  const b64 = buf.toString('base64');
  const mime = mimeOf(buf, image.fileID);
  const text = await chatVision({
    messages: [
      { role: 'system', content: '你只输出严格 JSON，不输出任何其他文字。' },
      {
        role: 'user',
        content: [
          { type: 'text', text: buildPrompt(job.weekStart) },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}`, detail: 'high' } },
        ],
      },
    ],
  });
  return parseRecognition(text);
}

/**
 * 员工自助识别：传入一张图，同步返回结构化行，不落库。
 */
async function recognizeFile(fileID, weekStart) {
  if (!fileID || !weekStart) throw new Error('INVALID_ARGUMENT');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) throw new Error('INVALID_WEEK');

  const dl = await cloud.downloadFile({ fileID });
  const buf = dl.fileContent;
  if (!buf || buf.length === 0) throw new Error('EMPTY_FILE');
  const maxBytes = Number(process.env.MAX_IMAGE_BYTES || 10 * 1024 * 1024);
  if (buf.length > maxBytes) throw new Error('FILE_TOO_LARGE');

  const mime = mimeOf(buf, fileID);
  const b64 = buf.toString('base64');
  const text = await chatVision({
    messages: [
      { role: 'system', content: '你只输出严格 JSON，不输出任何其他文字。' },
      {
        role: 'user',
        content: [
          { type: 'text', text: buildPrompt(weekStart) },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}`, detail: 'high' } },
        ],
      },
    ],
  });

  const parsed = parseRecognition(text);

  // 表头日期优先；模型逐格日期作为补充
  const headerDates = (parsed.dates || [])
    .map((d) => completeDate(d, weekStart))
    .filter(Boolean);
  const dateSet = new Set(headerDates);
  for (const row of parsed.rows) for (const c of row.cells) {
    const d = completeDate(c.date, weekStart);
    if (d) dateSet.add(d);
  }
  const dates = dateSet.size > 0 ? Array.from(dateSet).sort() : weekDates(weekStart);

  const rows = parsed.rows.map((row) => ({
    employeeNo: row.employeeNo || '',
    name: row.name || '',
    cells: (row.cells || []).map((c, i) => ({
      date: completeDate(c.date, weekStart) || headerDates[i] || dates[i] || null,
      text: c.text || '',
      confidence: c.confidence,
    })),
  }));

  return { weekStart, dates, rows, notes: parsed.notes || '' };
}

/**
 * 处理异步识别任务：结果写回 pb_ocr_tasks。
 * 由 API 即时唤起或定时触发器轮询。
 */
async function processTask(taskId) {
  if (!taskId) return { error: 'missing taskId' };
  const claim = await db
    .collection(C.tasks)
    .where({ _id: taskId, status: 'PENDING' })
    .update({ data: { status: 'RUNNING', updatedAt: new Date() } });
  if (!claim.stats || claim.stats.updated === 0) return { skipped: true };

  const doc = await db.collection(C.tasks).doc(taskId).get().catch(() => null);
  if (!doc || !doc.data) return { error: 'task missing' };
  const task = doc.data;

  try {
    const data = await recognizeFile(task.fileID, task.weekStart);
    await db.collection(C.tasks).doc(taskId).update({
      data: {
        status: 'DONE',
        dates: data.dates,
        rows: data.rows,
        notes: data.notes,
        error: null,
        updatedAt: new Date(),
      },
    });
    return { status: 'DONE', rows: data.rows.length };
  } catch (e) {
    const msg = String((e && e.message) || '识别失败').slice(0, 200);
    console.error('[ocr] task failed', taskId, msg);
    const friendly = publicError(msg);
    await db.collection(C.tasks).doc(taskId).update({
      data: {
        status: 'FAILED',
        error: friendly,
        detail: msg,
        updatedAt: new Date(),
      },
    });
    return { status: 'FAILED', error: friendly };
  }
}

async function loadShiftMap(teamId) {
  const res = await safeGet(db.collection(C.shiftTypes).where({ teamId }).limit(200));
  const byToken = new Map();
  const byCode = new Map();
  for (const s of res.data) {
    if (s.enabled === false) continue;
    byCode.set(String(s.code).toUpperCase(), s);
    const tokens = [s.code, s.label, ...(s.aliases || [])];
    for (const t of tokens) {
      const n = normalizeShiftText(t);
      if (n) byToken.set(n, s);
    }
  }
  return { byToken, byCode };
}

async function loadEmployees(teamId) {
  const res = await safeGet(db.collection(C.employees).where({ teamId }).limit(1000));
  const map = new Map();
  for (const e of res.data) {
    if (e.status !== 'ACTIVE') continue; // 停用员工按未匹配处理，需管理员介入
    map.set(String(e.employeeNo).trim(), e);
  }
  return map;
}

/**
 * 把模型输出的日期补全为 YYYY-MM-DD。
 * 以图片表头为准，允许超出所选周；只有月/日时按参考日期年份就近推断。
 */
function completeDate(rawDate, refDate) {
  if (!rawDate) return null;
  const s = String(rawDate).trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return isValidDateStr(s) ? s : null;

  const m = /^(\d{1,2})[-/.](\d{1,2})$/.exec(s) || /^(\d{1,2})月(\d{1,2})日?$/.exec(s);
  if (!m) return null;

  const month = Number(m[1]);
  const day = Number(m[2]);
  const refYear = Number(refDate.slice(0, 4));
  const refTs = Date.parse(`${refDate}T00:00:00Z`);

  let best = null;
  let bestDiff = Infinity;
  for (const y of [refYear - 1, refYear, refYear + 1]) {
    const candidate = `${y}-${pad(month)}-${pad(day)}`;
    if (!isValidDateStr(candidate)) continue;
    const diff = Math.abs(Date.parse(`${candidate}T00:00:00Z`) - refTs);
    if (diff < bestDiff) {
      best = candidate;
      bestDiff = diff;
    }
  }
  return best;
}

function isValidDateStr(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** 识别结果 → 草稿单元格（含异常标记） */
function buildCells(job, pageIndex, parsed, ctx) {
  const dates = weekDates(job.weekStart);
  const cells = [];
  const rows = [];

  parsed.rows.forEach((row, rowIdx) => {
    const employeeNo = String(row.employeeNo || '').replace(/^['"]/, '').trim();
    const employee = employeeNo ? ctx.empMap.get(employeeNo) : null;
    const rowKey = employee ? `emp_${employeeNo}` : `row_${pageIndex}_${rowIdx}`;

    const rowMeta = {
      rowKey,
      employeeNo: employeeNo || '',
      employeeName: row.name || (employee ? employee.name : ''),
      matched: !!employee,
      cellCount: 0,
    };

    const dateSeen = new Set();

    row.cells.forEach((c, cellIdx) => {
      const headerDate = (parsed.dates || [])[cellIdx];
      const workDate = completeDate(c.date || headerDate, job.weekStart);
      const rawText = (c.text || '').trim();
      const issues = [];

      if (!workDate || !dates.includes(workDate)) {
        issues.push('日期无法确定或不在本周');
      }
      if (!employee) {
        issues.push('未匹配员工（工号不在花名册）');
      }
      if (rawText === '') {
        issues.push('空白单元格：请确认未排班或选择班次');
      }

      let shift = null;
      const normalized = normalizeShiftText(rawText);
      if (rawText && normalized) {
        shift = ctx.shiftMap.byToken.get(normalized) || ctx.shiftMap.byCode.get(normalized);
        if (!shift) issues.push(`未知班次：${rawText}`);
      }
      if (c.confidence !== null && c.confidence < 0.6) {
        issues.push('识别置信度较低，请核对');
      }

      if (workDate) dateSeen.add(workDate);

      cells.push({
        pageIndex,
        workDate: workDate || null,
        rawText,
        confidence: c.confidence,
        rect: c.rect || null,
        rowKey,
        employeeId: employee ? employee._id : null,
        employeeNo: employeeNo || null,
        employeeName: employee ? employee.name : (row.name || null),
        shiftCode: shift ? shift.code : null,
        cleared: false,
        status: issues.length === 0 ? 'MATCHED' : 'NEEDS_REVIEW',
        issues,
      });
    });

    // 模型漏掉的日期补成待校对空白单元格
    for (const d of dates) {
      if (!dateSeen.has(d)) {
        cells.push({
          pageIndex,
          workDate: d,
          rawText: '',
          confidence: null,
          rect: null,
          rowKey,
          employeeId: employee ? employee._id : null,
          employeeNo: employeeNo || null,
          employeeName: employee ? employee.name : (row.name || null),
          shiftCode: null,
          cleared: false,
          status: 'NEEDS_REVIEW',
          issues: ['该日期缺失识别结果，请核对'],
        });
        rowMeta.cellCount += 1;
      }
    }

    rowMeta.cellCount += row.cells.length;
    if (!employee) rows.push(rowMeta);
  });

  return { cells, unmatchedRows: rows };
}

async function getAllCells(jobId, where = {}) {
  const out = [];
  let skip = 0;
  for (;;) {
    const res = await safeGet(db.collection(C.cells).where({ jobId, ...where }).skip(skip).limit(100));
    out.push(...res.data);
    if (res.data.length < 100) break;
    skip += 100;
    if (out.length >= 3000) break;
  }
  return out;
}

async function removePageCells(jobId, pageIndex) {
  for (;;) {
    const res = await safeGet(db.collection(C.cells).where({ jobId, pageIndex }).limit(100));
    if (res.data.length === 0) break;
    for (const c of res.data) await db.collection(C.cells).doc(c._id).remove();
  }
}

/**
 * 每次调用只识别一张图，避免多图连续调用超出云函数超时；
 * 剩余图片继续置为 PENDING_OCR，由定时触发器在下一轮推进。
 */
async function processJob(jobId, requestId) {
  // 原子认领：只有 PENDING_OCR 才能被处理（超时的 RECOGNIZING 由 poll 回收）
  const claim = await db
    .collection(C.jobs)
    .where({ _id: jobId, status: 'PENDING_OCR' })
    .update({ data: { status: 'RECOGNIZING', updatedAt: new Date() } });
  if (!claim.stats || claim.stats.updated === 0) {
    return { skipped: true };
  }

  const doc = await db.collection(C.jobs).doc(jobId).get().catch(() => null);
  if (!doc || !doc.data) return { error: 'job missing' };
  const job = doc.data;
  const images = (job.images || []).map((im) => ({ ...im }));

  const nextIdx = images.findIndex((im) => im.status === 'UPLOADED');
  if (nextIdx === -1) {
    return finalizeJob(jobId, job, images);
  }

  const shiftMap = await loadShiftMap(job.teamId);
  const empMap = await loadEmployees(job.teamId);
  const ctx = { shiftMap, empMap };
  const im = images[nextIdx];

  await removePageCells(jobId, nextIdx);
  let imageStatus = { ...im };
  const now = new Date();

  try {
    const parsed = await recognizeImage(job, im, nextIdx);
    const built = buildCells(job, nextIdx, parsed, ctx);
    const chunk = 20;
    for (let i = 0; i < built.cells.length; i += chunk) {
      await Promise.all(
        built.cells.slice(i, i + chunk).map((c) =>
          db.collection(C.cells).add({
            data: { ...c, jobId, teamId: job.teamId, createdAt: now, updatedAt: now },
          })
        )
      );
    }
    imageStatus = { ...im, status: 'OCR_DONE', error: null };
  } catch (e) {
    const msg = String(e && e.message ? e.message : '识别失败').slice(0, 200);
    console.error('[ocr] image failed', requestId, jobId, nextIdx, msg);
    imageStatus = { ...im, status: 'OCR_FAILED', error: publicError(msg) };
  }

  const updatedImages = images.map((x, i) => (i === nextIdx ? imageStatus : x));
  const remaining = updatedImages.some((x) => x.status === 'UPLOADED');

  if (remaining) {
    await db.collection(C.jobs).doc(jobId).update({
      data: {
        images: updatedImages,
        status: 'PENDING_OCR',
        revision: (job.revision || 1) + 1,
        updatedAt: now,
      },
    });
    return { step: 'image', pageIndex: nextIdx, remaining: true };
  }

  return finalizeJob(jobId, { ...job, images: updatedImages }, updatedImages);
}

/** 所有图片处理完毕：合并冲突、汇总未匹配行、计算任务状态 */
async function finalizeJob(jobId, job, images) {
  const now = new Date();
  let cells = await getAllCells(jobId);

  const groups = new Map();
  for (const c of cells) {
    const key = `${c.rowKey}|${c.workDate || 'nodate'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  for (const list of groups.values()) {
    if (list.length <= 1) continue;
    const nonEmpty = list.filter((c) => c.rawText !== '');
    const distinctShift = new Set(list.map((c) => c.shiftCode || '__EMPTY__'));

    if (nonEmpty.length <= 1 || distinctShift.size === 1) {
      // 结果一致：保留信息量最大的一条，其余作废
      const best = list.slice().sort((a, b) => {
        const score = (c) =>
          (c.rawText ? 2 : 0) + (c.shiftCode ? 1 : 0) + ((c.issues || []).length === 0 ? 1 : 0);
        return score(b) - score(a);
      })[0];
      for (const c of list) {
        if (c._id === best._id) continue;
        await db.collection(C.cells).doc(c._id).update({
          data: { status: 'SUPERSEDED', issues: [], updatedAt: now },
        });
        c.status = 'SUPERSEDED';
      }
    } else {
      for (const c of list) {
        const issues = [...new Set([...(c.issues || []), '多图识别结果冲突，请选择正确班次'])];
        await db.collection(C.cells).doc(c._id).update({
          data: { status: 'NEEDS_REVIEW', issues, updatedAt: now },
        });
        c.status = 'NEEDS_REVIEW';
        c.issues = issues;
      }
    }
  }

  // 未匹配员工行汇总
  const rowMap = new Map();
  for (const c of cells) {
    if (c.status === 'SUPERSEDED') continue;
    if (c.employeeId) continue;
    const prev = rowMap.get(c.rowKey);
    if (prev) {
      prev.cellCount += 1;
    } else {
      rowMap.set(c.rowKey, {
        rowKey: c.rowKey,
        employeeNo: c.employeeNo || '',
        employeeName: c.employeeName || '',
        cellCount: 1,
      });
    }
  }

  const live = cells.filter((c) => c.status !== 'SUPERSEDED');
  const pending = live.filter((c) => c.status === 'NEEDS_REVIEW').length;
  const anySuccess = images.some((im) => im.status === 'OCR_DONE');
  const blockers = pending + rowMap.size;

  let status = 'NEEDS_REVIEW';
  let error = null;
  if (!anySuccess) {
    status = 'FAILED';
    error = '所有图片识别失败，请重试失败图片或重新导入';
  } else if (live.length === 0) {
    status = 'NEEDS_REVIEW';
    error = '未识别到员工行，请检查原图是否清晰或重试';
  } else if (blockers === 0) {
    status = 'READY';
  }

  await db.collection(C.jobs).doc(jobId).update({
    data: {
      images,
      unmatchedRows: Array.from(rowMap.values()),
      status,
      revision: (job.revision || 1) + 1,
      updatedAt: now,
      ocrCompletedAt: now,
      error,
    },
  });

  return { status, cells: live.length, blockers };
}

function publicError(msg) {
  if (msg.indexOf('DEEPSEEK_API_KEY') >= 0 || msg.indexOf('OCR_NOT_CONFIGURED') >= 0) {
    return 'OCR 服务未配置，请联系管理员';
  }
  if (msg.indexOf('DEEPSEEK_TIMEOUT') >= 0) return '识别超时，可重试';
  if (msg.indexOf('DEEPSEEK_HTTP_401') >= 0 || msg.indexOf('DEEPSEEK_HTTP_403') >= 0) {
    return 'OCR 服务鉴权失败，请联系管理员';
  }
  if (msg.indexOf('BAD_JSON') >= 0 || msg.indexOf('NO_JSON_OBJECT') >= 0) {
    return '识别结果格式异常，可重试或更换清晰原图';
  }
  return '识别失败，可重试';
}

async function poll() {
  // 回收超时的 RECOGNIZING 任务
  await db
    .collection(C.jobs)
    .where({ status: 'RECOGNIZING', updatedAt: _.lt(new Date(Date.now() - STALE_MS)) })
    .update({ data: { status: 'PENDING_OCR' } })
    .catch(() => {});

  const res = await safeGet(
    db
      .collection(C.jobs)
      .where({ status: 'PENDING_OCR' })
      .orderBy('updatedAt', 'asc')
      .limit(MAX_JOBS_PER_TICK)
  );

  const results = [];
  for (const job of res.data) {
    try {
      results.push(await processJob(job._id, 'timer'));
    } catch (e) {
      console.error('[ocr] process job failed', job._id, e && e.message);
    }
  }

  // 回收卡住的识别任务
  await db
    .collection(C.tasks)
    .where({ status: 'RUNNING', updatedAt: _.lt(new Date(Date.now() - 5 * 60 * 1000)) })
    .update({ data: { status: 'PENDING' } })
    .catch(() => {});

  // 每次只处理一个任务，避免超过函数超时
  const taskRes = await safeGet(
    db.collection(C.tasks).where({ status: 'PENDING' }).orderBy('createdAt', 'asc').limit(1)
  );
  for (const t of taskRes.data) {
    try {
      results.push(await processTask(t._id));
    } catch (e) {
      console.error('[ocr] process task failed', t._id, e && e.message);
    }
  }

  await cleanupExpiredOriginals();
  return results;
}

/** 原图与 OCR 原文默认最多保留 7 天，不影响已发布排班 */
async function cleanupExpiredOriginals() {
  const cutoff = new Date(Date.now() - RETENTION_MS);
  const res = await db
    .collection(C.jobs)
    .where({ updatedAt: _.lt(cutoff), images: _.neq([]) })
    .limit(5)
    .get()
    .catch(() => ({ data: [] }));

  for (const job of res.data) {
    const fileIDs = (job.images || []).map((i) => i.fileID).filter(Boolean);
    if (fileIDs.length > 0) {
      await cloud.deleteFile({ fileList: fileIDs }).catch(() => {});
    }
    await db.collection(C.jobs).doc(job._id).update({
      data: {
        images: [],
        originalExpired: true,
        updatedAt: new Date(),
      },
    });
    // 原文清空，保留人工确认结果
    const cells = await db.collection(C.cells).where({ jobId: job._id }).limit(1000).get().catch(() => ({ data: [] }));
    for (const c of cells.data) {
      if (c.status !== 'MANUAL') {
        await db.collection(C.cells).doc(c._id).remove().catch(() => {});
      } else {
        await db.collection(C.cells).doc(c._id).update({ data: { rawText: '', rect: null } }).catch(() => {});
      }
    }
  }
}

exports.main = async (event) => {
  const isTimer = event && (event.Type === 'Timer' || event.TriggerName === 'ocrPoller');
  const token = process.env.INTERNAL_TOKEN || '';

  // 异步任务：处理一条识别任务并写回结果
  if (event && event.action === 'recognizeTask') {
    if (!token || event.token !== token) {
      return { ok: false, code: 'FORBIDDEN', message: 'token 不匹配' };
    }
    const result = await processTask(event.taskId);
    return { ok: true, result };
  }

  // 员工自助：同步识别（用于调试，生产走 recognizeTask）
  if (event && event.action === 'recognize') {
    if (!token || event.token !== token) {
      return { ok: false, code: 'FORBIDDEN', message: 'token 不匹配' };
    }
    try {
      const data = await recognizeFile(event.fileID, event.weekStart);
      return { ok: true, data };
    } catch (e) {
      const msg = String((e && e.message) || '识别失败').slice(0, 200);
      console.error('[ocr] recognize failed', msg);
      return { ok: false, code: 'OCR_FAILED', message: publicError(msg) };
    }
  }

  const authorized = isTimer || (token && event && event.token === token);

  if (!authorized) {
    return { ok: false, code: 'FORBIDDEN' };
  }

  if (event && event.jobId) {
    try {
      const result = await processJob(event.jobId, 'direct');
      return { ok: true, result };
    } catch (e) {
      console.error('[ocr] direct failed', e && e.message);
      return { ok: false, code: 'OCR_FAILED' };
    }
  }

  const results = await poll();
  return { ok: true, results };
};
