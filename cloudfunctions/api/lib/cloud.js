const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const COLLECTIONS = {
  teams: 'teams',
  employees: 'employees',
  bindings: 'bindings',
  admins: 'admins',
  invites: 'invites',
  shiftTypes: 'shiftTypes',
  importJobs: 'importJobs',
  draftCells: 'draftCells',
  releaseVersions: 'releaseVersions',
  publishedShifts: 'publishedShifts',
  weekPointers: 'weekPointers',
  auditLogs: 'auditLogs',
  idempotency: 'idempotency',
};

/** 服务端分页读取全部（单页上限 1000） */
async function getAll(query, pageSize = 1000, maxDocs = 5000) {
  const out = [];
  let skip = 0;
  for (;;) {
    const res = await query.skip(skip).limit(pageSize).get();
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
  const res = await q.orderBy('createdAt', 'desc').limit(pageSize + 1).get();
  const items = res.data.slice(0, pageSize);
  const nextCursor = res.data.length > pageSize
    ? new Date(res.data[pageSize - 1].createdAt).toISOString()
    : null;
  return { items, nextCursor };
}

module.exports = { cloud, db, _, COLLECTIONS, getAll, getPage };
