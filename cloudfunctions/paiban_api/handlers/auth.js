const crypto = require('crypto');
const { cloud, db, _, COLLECTIONS, safeGet } = require('../lib/cloud');
const { getIdentity } = require('../lib/auth');
const { ERR } = require('../lib/errors');
const { str } = require('../lib/validate');

const INVITE_PEPPER = process.env.INVITE_PEPPER || 'paiban-invite-pepper-change-me';
const INVITE_TTL_MS = 48 * 60 * 60 * 1000;

function hashInvite(code) {
  return crypto.createHash('sha256').update(`${INVITE_PEPPER}:${code}`).digest('hex');
}

async function getMe() {
  const id = await getIdentity();
  const roles = [];
  if (id.adminTeams.length > 0) roles.push('ADMIN');
  if (id.employee) roles.push('EMPLOYEE');
  if (roles.length === 0) roles.push('NONE');

  return {
    openid: id.openid,
    roles,
    employee: id.employee,
    adminTeams: id.adminTeams.map((t) => ({ teamId: t.teamId, teamName: t.teamName })),
  };
}

async function bindInvite(payload) {
  const code = str(payload.inviteCode, '邀请码', { min: 6, max: 64 }).replace(/\s+/g, '').toUpperCase();
  const identity = await getIdentity();
  const tokenHash = hashInvite(code);

  const res = await safeGet(db.collection(COLLECTIONS.invites).where({ tokenHash }).limit(1));
  const invite = res.data[0];
  if (!invite) throw ERR.INVITE_INVALID();

  const now = new Date();
  if (invite.usedAt || invite.revokedAt || !invite.expiresAt || new Date(invite.expiresAt) <= now) {
    throw ERR.INVITE_INVALID();
  }

  const empDoc = await db.collection(COLLECTIONS.employees).doc(invite.employeeId).get().catch(() => null);
  if (!empDoc || !empDoc.data || empDoc.data.status !== 'ACTIVE') throw ERR.INVITE_INVALID();

  const existing = await safeGet(
    db
      .collection(COLLECTIONS.bindings)
      .where({ openid: identity.openid, status: 'ACTIVE' })
      .limit(1)
  );

  if (existing.data.length > 0) {
    if (existing.data[0].employeeId === invite.employeeId) {
      return { employeeId: invite.employeeId, teamId: invite.teamId, alreadyBound: true };
    }
    // 已绑定其他员工，需管理员解绑，避免通过新邀请码静默换绑
    throw ERR.FORBIDDEN('当前微信已绑定其他员工，请联系管理员处理');
  }

  // 原子消费邀请码并建立绑定
  const tx = await db.startTransaction();
  try {
    const fresh = await tx.collection(COLLECTIONS.invites).doc(invite._id).get();
    const freshInvite = fresh.data;
    if (!freshInvite || freshInvite.usedAt || freshInvite.revokedAt || new Date(freshInvite.expiresAt) <= new Date()) {
      await tx.rollback();
      throw ERR.INVITE_INVALID();
    }
    await tx.collection(COLLECTIONS.invites).doc(invite._id).update({
      data: { usedAt: new Date(), usedByOpenid: identity.openid },
    });
    await tx.collection(COLLECTIONS.bindings).add({
      data: {
        appId: identity.appId,
        openid: identity.openid,
        employeeId: invite.employeeId,
        orgId: empDoc.data.orgId,
        teamId: empDoc.data.teamId,
        status: 'ACTIVE',
        boundAt: new Date(),
        createdAt: new Date(),
      },
    });
    await tx.commit();
  } catch (e) {
    try { await tx.rollback(); } catch (ignore) { /* noop */ }
    if (e && e.code === 'INVITE_INVALID') throw e;
    console.error('[bindInvite] transaction failed', e && e.message);
    throw ERR.INVITE_INVALID();
  }

  return { employeeId: invite.employeeId, teamId: empDoc.data.teamId };
}

/**
 * 管理员可绑定的员工列表（仅限其管理团队）。
 * 管理员身份本身不等于员工绑定，需要显式选择一条员工记录。
 */
async function listBindableEmployees() {
  const identity = await getIdentity();
  if (identity.adminTeams.length === 0) throw ERR.FORBIDDEN('无管理权限');

  const items = [];
  for (const team of identity.adminTeams) {
    const empRes = await safeGet(
      db
        .collection(COLLECTIONS.employees)
        .where({ teamId: team.teamId, status: 'ACTIVE' })
        .limit(200)
    );
    const ids = empRes.data.map((e) => e._id);
    let bindingMap = new Map();
    if (ids.length > 0) {
      const bindings = await safeGet(
        db
          .collection(COLLECTIONS.bindings)
          .where({ employeeId: _.in(ids), status: 'ACTIVE' })
          .limit(1000)
      );
      bindingMap = new Map(bindings.data.map((b) => [b.employeeId, b]));
    }
    for (const e of empRes.data) {
      const b = bindingMap.get(e._id);
      items.push({
        employeeId: e._id,
        employeeNo: e.employeeNo,
        name: e.name,
        teamId: team.teamId,
        teamName: team.teamName,
        bound: !!b,
        boundToMe: !!b && b.openid === identity.openid,
      });
    }
  }
  return { items };
}

/** 管理员把自己绑定到管理团队内的一条员工记录（无需邀请码） */
async function bindSelf(payload) {
  const employeeId = str(payload.employeeId, 'employeeId', { min: 1, max: 64 });
  const identity = await getIdentity();
  if (identity.adminTeams.length === 0) throw ERR.FORBIDDEN('无管理权限');

  const empDoc = await db.collection(COLLECTIONS.employees).doc(employeeId).get().catch(() => null);
  if (!empDoc || !empDoc.data) throw ERR.NOT_FOUND('员工不存在');
  const emp = empDoc.data;

  if (!identity.adminTeams.some((t) => t.teamId === emp.teamId)) {
    throw ERR.FORBIDDEN('该员工不属于你管理的团队');
  }
  if (emp.status !== 'ACTIVE') throw ERR.CONFLICT('员工已停用');

  if (identity.binding) {
    if (identity.binding.employeeId === employeeId) {
      return { employeeId, teamId: emp.teamId, already: true };
    }
    throw ERR.FORBIDDEN('当前微信已绑定其他员工，请联系部署方解绑');
  }

  const existing = await safeGet(
    db.collection(COLLECTIONS.bindings).where({ employeeId, status: 'ACTIVE' }).limit(1)
  );
  if (existing.data.length > 0) throw ERR.CONFLICT('该员工已被其他微信绑定');

  await db.collection(COLLECTIONS.bindings).add({
    data: {
      appId: identity.appId,
      openid: identity.openid,
      employeeId,
      orgId: emp.orgId,
      teamId: emp.teamId,
      status: 'ACTIVE',
      boundBy: 'admin-self',
      boundAt: new Date(),
      createdAt: new Date(),
    },
  });
  return { employeeId, teamId: emp.teamId };
}

/**
 * 管理员一键创建员工并绑定自己（开发/初始化阶段免邀请码）。
 * 自动生成工号；也可指定 employeeNo。
 */
async function createSelfEmployee(payload) {
  const name = str(payload.name, '姓名', { min: 1, max: 32 });
  const identity = await getIdentity();
  if (identity.adminTeams.length === 0) throw ERR.FORBIDDEN('无管理权限');

  if (identity.binding) {
    const empDoc = await db
      .collection(COLLECTIONS.employees)
      .doc(identity.binding.employeeId)
      .get()
      .catch(() => null);
    if (empDoc && empDoc.data) {
      return {
        employeeId: identity.binding.employeeId,
        teamId: empDoc.data.teamId,
        employeeNo: empDoc.data.employeeNo,
        name: empDoc.data.name,
        already: true,
      };
    }
  }

  const team = identity.adminTeams[0];
  let employeeNo = payload.employeeNo
    ? str(payload.employeeNo, '工号', { min: 1, max: 32 })
    : '';

  if (employeeNo) {
    const dup = await safeGet(
      db.collection(COLLECTIONS.employees).where({ teamId: team.teamId, employeeNo }).limit(1)
    );
    if (dup.data.length > 0) throw ERR.CONFLICT('该工号已存在');
  } else {
    const all = await safeGet(
      db.collection(COLLECTIONS.employees).where({ teamId: team.teamId }).limit(500)
    );
    const nums = all.data
      .map((e) => Number(e.employeeNo))
      .filter((n) => Number.isInteger(n) && n >= 0);
    let next = (nums.length ? Math.max(...nums) : 0) + 1;
    for (let i = 0; i < 50; i += 1) {
      const candidate = String(next + i).padStart(4, '0');
      const dup = await safeGet(
        db.collection(COLLECTIONS.employees).where({ teamId: team.teamId, employeeNo: candidate }).limit(1)
      );
      if (dup.data.length === 0) {
        employeeNo = candidate;
        break;
      }
    }
    if (!employeeNo) employeeNo = `A${Date.now().toString().slice(-6)}`;
  }

  const teamDoc = await db.collection(COLLECTIONS.teams).doc(team.teamId).get();
  const now = new Date();
  const added = await db.collection(COLLECTIONS.employees).add({
    data: {
      orgId: teamDoc.data.orgId,
      teamId: team.teamId,
      employeeNo,
      name,
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    },
  });

  await db.collection(COLLECTIONS.bindings).add({
    data: {
      appId: identity.appId,
      openid: identity.openid,
      employeeId: added._id,
      orgId: teamDoc.data.orgId,
      teamId: team.teamId,
      status: 'ACTIVE',
      boundBy: 'admin-self-create',
      boundAt: now,
      createdAt: now,
    },
  });

  return {
    employeeId: added._id,
    teamId: team.teamId,
    teamName: team.teamName,
    employeeNo,
    name,
    created: true,
  };
}

module.exports = { getMe, bindInvite, listBindableEmployees, bindSelf, createSelfEmployee };
