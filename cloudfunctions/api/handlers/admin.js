const crypto = require('crypto');
const { db, _, COLLECTIONS } = require('../lib/cloud');
const { getIdentity, requireAdmin } = require('../lib/auth');
const { ERR } = require('../lib/errors');
const { str, int, bool, arr } = require('../lib/validate');
const { validateShiftTimes, isValidHHmm } = require('../lib/date');
const { audit } = require('../lib/audit');

const INVITE_PEPPER = process.env.INVITE_PEPPER || 'paiban-invite-pepper-change-me';
const INVITE_TTL_MS = 48 * 60 * 60 * 1000;
const PAGE_SIZE = 50;

function hashInvite(code) {
  return crypto.createHash('sha256').update(`${INVITE_PEPPER}:${code}`).digest('hex');
}

async function adminIdentity(payload) {
  const teamId = str(payload.teamId, 'teamId', { min: 1, max: 64 });
  const identity = await getIdentity();
  requireAdmin(identity, teamId);
  return { identity, teamId };
}

async function listEmployees(payload) {
  const { teamId } = await adminIdentity(payload);
  const cursor = payload.cursor ? new Date(payload.cursor) : null;
  const where = { teamId };
  if (cursor) where.createdAt = _.lt(cursor);

  const res = await db
    .collection(COLLECTIONS.employees)
    .where(where)
    .orderBy('createdAt', 'desc')
    .limit(PAGE_SIZE + 1)
    .get();

  const items = res.data.slice(0, PAGE_SIZE);
  const nextCursor = res.data.length > PAGE_SIZE
    ? new Date(res.data[PAGE_SIZE - 1].createdAt).toISOString()
    : null;

  const ids = items.map((e) => e._id);
  let boundIds = new Set();
  if (ids.length > 0) {
    const bindings = await db
      .collection(COLLECTIONS.bindings)
      .where({ employeeId: _.in(ids), status: 'ACTIVE' })
      .limit(1000)
      .get();
    boundIds = new Set(bindings.data.map((b) => b.employeeId));
  }

  return {
    items: items.map((e) => ({
      _id: e._id,
      employeeNo: e.employeeNo,
      name: e.name,
      status: e.status,
      bound: boundIds.has(e._id),
    })),
    nextCursor,
  };
}

async function saveEmployee(payload) {
  const { identity, teamId } = await adminIdentity(payload);
  const employeeNo = str(payload.employeeNo, '工号', { min: 1, max: 32 });
  const name = str(payload.name, '姓名', { min: 1, max: 32 });
  const status = payload.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE';

  const dup = await db
    .collection(COLLECTIONS.employees)
    .where({ teamId, employeeNo })
    .limit(2)
    .get();
  const dupOther = dup.data.find((e) => e._id !== payload.employeeId);
  if (dupOther) throw ERR.CONFLICT('该工号已存在');

  let employeeId = payload.employeeId;
  if (employeeId) {
    const doc = await db.collection(COLLECTIONS.employees).doc(employeeId).get().catch(() => null);
    if (!doc || !doc.data || doc.data.teamId !== teamId) throw ERR.NOT_FOUND('员工不存在');
    await db.collection(COLLECTIONS.employees).doc(employeeId).update({
      data: { employeeNo, name, status, updatedAt: new Date() },
    });
  } else {
    const teamDoc = await db.collection(COLLECTIONS.teams).doc(teamId).get();
    const added = await db.collection(COLLECTIONS.employees).add({
      data: {
        orgId: teamDoc.data.orgId,
        teamId,
        employeeNo,
        name,
        status,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    employeeId = added._id;
  }

  if (status === 'DISABLED') {
    // 停用员工：撤销未使用邀请码
    const invites = await db
      .collection(COLLECTIONS.invites)
      .where({ employeeId, teamId, usedAt: _.exists(false), revokedAt: _.exists(false) })
      .limit(100)
      .get();
    for (const inv of invites.data) {
      await db.collection(COLLECTIONS.invites).doc(inv._id).update({ data: { revokedAt: new Date() } });
    }
  }

  await audit({
    teamId,
    operatorOpenid: identity.openid,
    action: payload.employeeId ? 'employee.update' : 'employee.create',
    refId: employeeId,
    summary: `${employeeNo} ${status}`,
  });

  return { employeeId };
}

async function issueInvite(payload) {
  const { identity, teamId } = await adminIdentity(payload);
  const employeeId = str(payload.employeeId, 'employeeId', { min: 1, max: 64 });
  const empDoc = await db.collection(COLLECTIONS.employees).doc(employeeId).get().catch(() => null);
  if (!empDoc || !empDoc.data || empDoc.data.teamId !== teamId) throw ERR.NOT_FOUND('员工不存在');
  if (empDoc.data.status !== 'ACTIVE') throw ERR.CONFLICT('员工已停用，不能发放邀请码');

  const active = await db
    .collection(COLLECTIONS.invites)
    .where({
      employeeId,
      usedAt: _.exists(false),
      revokedAt: _.exists(false),
      expiresAt: _.gt(new Date()),
    })
    .limit(10)
    .get();
  if (active.data.length >= 5) throw ERR.CONFLICT('有效邀请码过多，请先撤销部分邀请码');

  const inviteCode = crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, '').toUpperCase().slice(0, 12);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const added = await db.collection(COLLECTIONS.invites).add({
    data: {
      tokenHash: hashInvite(inviteCode),
      employeeId,
      employeeName: empDoc.data.name,
      teamId,
      orgId: empDoc.data.orgId,
      expiresAt,
      issuedBy: identity.openid,
      createdAt: new Date(),
    },
  });

  await audit({
    teamId,
    operatorOpenid: identity.openid,
    action: 'invite.issue',
    refId: added._id,
    summary: `employee ${employeeId}`,
  });

  return { inviteId: added._id, inviteCode, expiresAt: expiresAt.toISOString() };
}

async function revokeInvite(payload) {
  const inviteId = str(payload.inviteId, 'inviteId', { min: 1, max: 64 });
  const doc = await db.collection(COLLECTIONS.invites).doc(inviteId).get().catch(() => null);
  if (!doc || !doc.data) throw ERR.NOT_FOUND('邀请码不存在');
  const { identity } = await adminIdentity({ teamId: doc.data.teamId });

  if (doc.data.usedAt) throw ERR.CONFLICT('邀请码已被使用，无法撤销；如需解绑请联系部署方');
  await db.collection(COLLECTIONS.invites).doc(inviteId).update({ data: { revokedAt: new Date() } });
  await audit({
    teamId: doc.data.teamId,
    operatorOpenid: identity.openid,
    action: 'invite.revoke',
    refId: inviteId,
  });
  return {};
}

async function listInvites(payload) {
  const { teamId } = await adminIdentity(payload);
  const res = await db
    .collection(COLLECTIONS.invites)
    .where({
      teamId,
      usedAt: _.exists(false),
      revokedAt: _.exists(false),
      expiresAt: _.gt(new Date()),
    })
    .orderBy('expiresAt', 'asc')
    .limit(100)
    .get();
  return {
    items: res.data.map((i) => ({
      inviteId: i._id,
      employeeId: i.employeeId,
      employeeName: i.employeeName || '',
      expiresAt: new Date(i.expiresAt).toISOString(),
    })),
  };
}

async function listShiftTypes(payload) {
  const { teamId } = await adminIdentity(payload);
  const res = await db
    .collection(COLLECTIONS.shiftTypes)
    .where({ teamId })
    .orderBy('code', 'asc')
    .limit(200)
    .get();
  return { items: res.data };
}

const CATEGORIES = ['WORK', 'OFF', 'STUDY'];

async function saveShiftType(payload) {
  const { identity, teamId } = await adminIdentity(payload);
  const code = str(payload.code, '班次编码', { min: 1, max: 24 }).toUpperCase();
  if (!/^[A-Z0-9_]+$/.test(code)) throw ERR.INVALID_ARGUMENT('班次编码只能包含大写字母、数字和下划线');
  const label = str(payload.label, '显示名称', { min: 1, max: 32 });
  const category = payload.category;
  if (!CATEGORIES.includes(category)) throw ERR.INVALID_ARGUMENT('班次类别不合法');

  const aliases = arr(payload.aliases || [], '简称', { max: 20 })
    .map((a) => str(a, '简称', { min: 1, max: 16 }))
    .filter((a, i, list) => list.indexOf(a) === i);

  let startLocal = null;
  let endLocal = null;
  let endDayOffset = 0;
  let reminderEnabled = !!payload.reminderEnabled;

  if (category === 'OFF') {
    reminderEnabled = false;
  } else if (category === 'WORK') {
    if (!isValidHHmm(payload.startLocal) || !isValidHHmm(payload.endLocal)) {
      throw ERR.INVALID_ARGUMENT('工作班次必须填写起止时间');
    }
    endDayOffset = int(payload.endDayOffset, '结束日偏移', { min: 0, max: 1 });
    const err = validateShiftTimes(payload.startLocal, payload.endLocal, endDayOffset);
    if (err) throw ERR.INVALID_ARGUMENT(err);
    startLocal = payload.startLocal;
    endLocal = payload.endLocal;
  } else {
    // 学习：由管理员决定是否配置具体时间；不配置时间则不产生提醒
    const hasAnyTime = payload.startLocal || payload.endLocal;
    if (hasAnyTime) {
      if (!isValidHHmm(payload.startLocal) || !isValidHHmm(payload.endLocal)) {
        throw ERR.INVALID_ARGUMENT('学习班次的起止时间需同时填写或同时留空');
      }
      endDayOffset = int(payload.endDayOffset || 0, '结束日偏移', { min: 0, max: 1 });
      const err = validateShiftTimes(payload.startLocal, payload.endLocal, endDayOffset);
      if (err) throw ERR.INVALID_ARGUMENT(err);
      startLocal = payload.startLocal;
      endLocal = payload.endLocal;
    } else {
      reminderEnabled = false;
    }
  }

  // 团队内简称 / 名称 / 编码不得歧义
  const all = await db.collection(COLLECTIONS.shiftTypes).where({ teamId }).limit(200).get();
  const others = all.data.filter((s) => s._id !== payload.shiftTypeId);
  const taken = new Set();
  for (const s of others) {
    taken.add(s.code.toUpperCase());
    taken.add(s.label);
    for (const a of s.aliases || []) taken.add(a);
  }
  const clash = [code, label, ...aliases].find((t) => taken.has(t));
  if (clash) throw ERR.CONFLICT(`编码、名称或简称「${clash}」已被其他班次占用`);

  const now = new Date();
  let shiftTypeId = payload.shiftTypeId;
  let revision = 1;

  if (shiftTypeId) {
    const doc = await db.collection(COLLECTIONS.shiftTypes).doc(shiftTypeId).get().catch(() => null);
    if (!doc || !doc.data || doc.data.teamId !== teamId) throw ERR.NOT_FOUND('班次不存在');
    if (typeof payload.revision !== 'number' || payload.revision !== doc.data.revision) {
      throw ERR.CONFLICT('班次字典已在别处更新，请刷新后重试');
    }
    revision = doc.data.revision + 1;
    await db.collection(COLLECTIONS.shiftTypes).doc(shiftTypeId).update({
      data: {
        label,
        aliases,
        category,
        startLocal,
        endLocal,
        endDayOffset,
        reminderEnabled,
        enabled: !!payload.enabled,
        revision,
        updatedAt: now,
      },
    });
  } else {
    const added = await db.collection(COLLECTIONS.shiftTypes).add({
      data: {
        teamId,
        code,
        label,
        aliases,
        category,
        startLocal,
        endLocal,
        endDayOffset,
        reminderEnabled,
        enabled: payload.enabled !== false,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
    });
    shiftTypeId = added._id;
  }

  await audit({
    teamId,
    operatorOpenid: identity.openid,
    action: payload.shiftTypeId ? 'shiftType.update' : 'shiftType.create',
    refId: shiftTypeId,
    summary: `${code} v${revision}`,
  });

  return { shiftTypeId, revision };
}

module.exports = {
  listEmployees,
  saveEmployee,
  issueInvite,
  revokeInvite,
  listInvites,
  listShiftTypes,
  saveShiftType,
};
