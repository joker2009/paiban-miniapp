const crypto = require('crypto');
const { cloud, db, COLLECTIONS } = require('../lib/cloud');
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

  const res = await db.collection(COLLECTIONS.invites).where({ tokenHash }).limit(1).get();
  const invite = res.data[0];
  if (!invite) throw ERR.INVITE_INVALID();

  const now = new Date();
  if (invite.usedAt || invite.revokedAt || !invite.expiresAt || new Date(invite.expiresAt) <= now) {
    throw ERR.INVITE_INVALID();
  }

  const empDoc = await db.collection(COLLECTIONS.employees).doc(invite.employeeId).get().catch(() => null);
  if (!empDoc || !empDoc.data || empDoc.data.status !== 'ACTIVE') throw ERR.INVITE_INVALID();

  const existing = await db
    .collection(COLLECTIONS.bindings)
    .where({ openid: identity.openid, status: 'ACTIVE' })
    .limit(1)
    .get();

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

module.exports = { getMe, bindInvite };
