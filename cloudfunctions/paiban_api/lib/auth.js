const { cloud, db, COLLECTIONS, safeGet } = require('./cloud');
const { ERR } = require('./errors');

/**
 * 身份一律来自云函数受信任上下文，禁止信任前端传入的 openid / role / employeeId。
 */
async function getIdentity() {
  const ctx = cloud.getWXContext();
  // 环境共享调用时，身份在 FROM_OPENID / FROM_APPID 中
  const openid = ctx.OPENID || ctx.FROM_OPENID;
  const appId = ctx.APPID || ctx.FROM_APPID || '';
  if (!openid) throw ERR.UNAUTHORIZED('无法获取微信身份');

  const [adminRes, bindingRes] = await Promise.all([
    safeGet(db.collection(COLLECTIONS.admins).where({ openid })),
    safeGet(db.collection(COLLECTIONS.bindings).where({ openid, status: 'ACTIVE' }).limit(1)),
  ]);

  const adminTeams = [];
  for (const a of adminRes.data) {
    if (a.appId && a.appId !== appId) continue;
    const team = await db.collection(COLLECTIONS.teams).doc(a.teamId).get().catch(() => null);
    if (team && team.data) {
      adminTeams.push({
        teamId: a.teamId,
        teamName: team.data.name,
        orgId: team.data.orgId,
      });
    }
  }

  let employee = null;
  const binding = bindingRes.data[0];
  if (binding) {
    const empDoc = await db.collection(COLLECTIONS.employees).doc(binding.employeeId).get().catch(() => null);
    if (empDoc && empDoc.data) {
      const teamDoc = await db.collection(COLLECTIONS.teams).doc(empDoc.data.teamId).get().catch(() => null);
      employee = {
        employeeId: binding.employeeId,
        employeeNo: empDoc.data.employeeNo,
        name: empDoc.data.name,
        teamId: empDoc.data.teamId,
        teamName: teamDoc && teamDoc.data ? teamDoc.data.name : '',
        status: empDoc.data.status,
      };
    }
  }

  return { openid, appId, adminTeams, employee, binding: binding || null };
}

function requireAdmin(identity, teamId) {
  if (!teamId) throw ERR.INVALID_ARGUMENT('缺少团队参数');
  const hit = identity.adminTeams.find((t) => t.teamId === teamId);
  if (!hit) throw ERR.FORBIDDEN('你无权管理该团队');
  return hit;
}

function requireEmployee(identity) {
  if (!identity.employee) throw ERR.FORBIDDEN('请先绑定个人排班');
  if (identity.employee.status !== 'ACTIVE') throw ERR.FORBIDDEN('账号已停用，请联系管理员');
  return identity.employee;
}

/** 校验某实体确实属于指定团队（防跨团队越权） */
async function assertInTeam(collection, id, teamId) {
  const doc = await db.collection(collection).doc(id).get().catch(() => null);
  if (!doc || !doc.data || doc.data.teamId !== teamId) {
    throw ERR.NOT_FOUND('数据不存在或不属于该团队');
  }
  return doc.data;
}

module.exports = { getIdentity, requireAdmin, requireEmployee, assertInTeam };
