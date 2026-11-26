const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const COLLECTIONS = {
  teams: 'pb_teams',
  employees: 'pb_employees',
  bindings: 'pb_bindings',
  admins: 'pb_admins',
  invites: 'pb_invites',
  shiftTypes: 'pb_shiftTypes',
  importJobs: 'pb_importJobs',
  draftCells: 'pb_draftCells',
  releaseVersions: 'pb_releaseVersions',
  publishedShifts: 'pb_publishedShifts',
  weekPointers: 'pb_weekPointers',
  auditLogs: 'pb_auditLogs',
  idempotency: 'pb_idempotency',
};

/** 集合不存在（首次运行、尚未创建任何数据） */
function isCollectionNotExist(err) {
  if (!err) return false;
  const code = err.errCode || err.code || (err.original && err.original.errCode);
  const msg = String(err.errMsg || err.message || '');
  return (
    code === -502005 ||
    /collection.*(not exist|does not exist)/i.test(msg) ||
    /DATABASE_COLLECTION_NOT_EXIST/i.test(msg) ||
    /集合不存在/.test(msg)
  );
}

/** 读查询：集合不存在时按空结果处理，避免首次运行时整页报错 */
async function safeGet(query) {
  try {
    return await query.get();
  } catch (err) {
    if (isCollectionNotExist(err)) return { data: [] };
    throw err;
  }
}

async function safeCount(query) {
  try {
    return await query.count();
  } catch (err) {
    if (isCollectionNotExist(err)) return { total: 0 };
    throw err;
  }
}

/** 服务端分页读取全部（单页上限 1000） */
async function getAll(query, pageSize = 1000, maxDocs = 5000) {
  const out = [];
  let skip = 0;
  for (;;) {
    const res = await safeGet(query.skip(skip).limit(pageSize));
    out.push(...res.data);
    if (res.data.length < pageSize) break;
    skip += pageSize;
    if (out.length >= maxDocs) break;
  }
  return out;
}

/** 服务端小批量读取（用于列表接口） */
async function getPage(query, { cursor = null, pageSize = 50 } = {}) {
  let q = query;
  if (cursor) {
    q = q.where({ createdAt: _.lt(new Date(cursor)) });
  }
  const res = await safeGet(q.orderBy('createdAt', 'desc').limit(pageSize + 1));
  const items = res.data.slice(0, pageSize);
  const nextCursor = res.data.length > pageSize
    ? new Date(res.data[pageSize - 1].createdAt).toISOString()
    : null;
  return { items, nextCursor };
}

module.exports = {
  cloud,
  db,
  _,
  COLLECTIONS,
  getAll,
  getPage,
  safeGet,
  safeCount,
  isCollectionNotExist,
};
