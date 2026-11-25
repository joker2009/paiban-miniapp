/**
 * 一次性初始化函数：建团队 / 授权管理员 / 写入示例班次与成员。
 * 部署后由人工调用，完成后请立即删除该云函数。
 *
 * 环境变量：BOOTSTRAP_TOKEN（必填，随机长串）
 * 调用参数：{ token, action: 'initTeam'|'seedShiftTypes'|'seedEmployees', ... }
 */
const crypto = require('crypto');
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const SAMPLE_SHIFTS = [
  {
    code: 'DAY_1',
    label: '日责1',
    aliases: ['日', '日责', '白班'],
    category: 'WORK',
    startLocal: '08:00',
    endLocal: '16:00',
    endDayOffset: 0,
    reminderEnabled: true,
  },
  {
    code: 'MID',
    label: '中班',
    aliases: ['中'],
    category: 'WORK',
    startLocal: '14:00',
    endLocal: '22:00',
    endDayOffset: 0,
    reminderEnabled: true,
  },
  {
    code: 'NIGHT',
    label: '夜班',
    aliases: ['夜'],
    category: 'WORK',
    startLocal: '20:00',
    endLocal: '06:00',
    endDayOffset: 1,
    reminderEnabled: true,
  },
  {
    code: 'OFF',
    label: '休息',
    aliases: ['休', '公休'],
    category: 'OFF',
    startLocal: null,
    endLocal: null,
    endDayOffset: 0,
    reminderEnabled: false,
  },
];

exports.main = async (event) => {
  const expected = process.env.BOOTSTRAP_TOKEN;
  if (!expected) {
    return { ok: false, message: '未配置 BOOTSTRAP_TOKEN，拒绝执行' };
  }
  if (!event || event.token !== expected) {
    return { ok: false, message: 'token 不匹配' };
  }

  const action = event.action;
  const now = new Date();

  if (action === 'initTeam') {
    const name = String(event.name || '').trim();
    const adminOpenid = String(event.adminOpenid || '').trim();
    if (!name || !adminOpenid) return { ok: false, message: 'name 与 adminOpenid 必填' };

    const exists = await db.collection('teams').where({ name }).limit(1).get();
    let teamId;
    if (exists.data.length > 0) {
      teamId = exists.data[0]._id;
    } else {
      const added = await db.collection('teams').add({
        data: {
          orgId: event.orgId || 'default',
          name,
          timezone: 'Asia/Shanghai',
          createdAt: now,
        },
      });
      teamId = added._id;
    }

    const adminExists = await db.collection('admins').where({ openid: adminOpenid, teamId }).limit(1).get();
    if (adminExists.data.length === 0) {
      await db.collection('admins').add({
        data: {
          openid: adminOpenid,
          appId: event.appId || '',
          orgId: event.orgId || 'default',
          teamId,
          name: event.adminName || '管理员',
          createdAt: now,
        },
      });
    }
    return { ok: true, teamId };
  }

  if (action === 'seedShiftTypes') {
    const teamId = String(event.teamId || '').trim();
    if (!teamId) return { ok: false, message: 'teamId 必填' };
    const created = [];
    for (const s of SAMPLE_SHIFTS) {
      const dup = await db.collection('shiftTypes').where({ teamId, code: s.code }).limit(1).get();
      if (dup.data.length > 0) continue;
      await db.collection('shiftTypes').add({
        data: { ...s, teamId, enabled: true, revision: 1, createdAt: now, updatedAt: now },
      });
      created.push(s.code);
    }
    return { ok: true, created, warning: '示例时间仅用于开发联调，请按真实班次规则修改' };
  }

  if (action === 'seedEmployees') {
    const teamId = String(event.teamId || '').trim();
    const employees = Array.isArray(event.employees) ? event.employees : [];
    if (!teamId || employees.length === 0) return { ok: false, message: 'teamId 与 employees 必填' };

    const teamDoc = await db.collection('teams').doc(teamId).get();
    const created = [];
    for (const e of employees) {
      const employeeNo = String(e.employeeNo || '').trim();
      const name = String(e.name || '').trim();
      if (!employeeNo || !name) continue;
      const dup = await db.collection('employees').where({ teamId, employeeNo }).limit(1).get();
      if (dup.data.length > 0) continue;
      await db.collection('employees').add({
        data: {
          orgId: teamDoc.data.orgId,
          teamId,
          employeeNo,
          name,
          status: 'ACTIVE',
          createdAt: now,
          updatedAt: now,
        },
      });
      created.push(employeeNo);
    }
    return { ok: true, created };
  }

  if (action === 'makeInviteCode') {
    // 仅开发便利：直接生成一个邀请码（正式流程走 admin.issueInvite）
    const employeeId = String(event.employeeId || '').trim();
    if (!employeeId) return { ok: false, message: 'employeeId 必填' };
    const emp = await db.collection('employees').doc(employeeId).get();
    const pepper = process.env.INVITE_PEPPER || 'paiban-invite-pepper-change-me';
    const code = crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, '').toUpperCase().slice(0, 12);
    const tokenHash = crypto.createHash('sha256').update(`${pepper}:${code}`).digest('hex');
    await db.collection('invites').add({
      data: {
        tokenHash,
        employeeId,
        employeeName: emp.data.name,
        teamId: emp.data.teamId,
        orgId: emp.data.orgId,
        expiresAt: new Date(Date.now() + 48 * 3600 * 1000),
        issuedBy: 'bootstrap',
        createdAt: now,
      },
    });
    return { ok: true, inviteCode: code };
  }

  return { ok: false, message: '未知 action' };
};
