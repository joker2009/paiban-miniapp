/**
 * 一次性初始化函数：建集合 / 团队 / 授权管理员 / 示例班次与成员。
 * 部署后由人工调用，完成后请立即删除该云函数。
 *
 * 环境变量：BOOTSTRAP_TOKEN（推荐配置；首次运行可免 token）
 * 调用参数：{ token, action: 'initTeam'|'initSelfTeam'|'seedShiftTypes'|'seedEmployees'|'makeInviteCode'|'ensureCollections' }
 */
const crypto = require('crypto');
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const DB_COLLECTIONS = [
  'pb_teams',
  'pb_employees',
  'pb_bindings',
  'pb_admins',
  'pb_invites',
  'pb_shiftTypes',
  'pb_importJobs',
  'pb_draftCells',
  'pb_releaseVersions',
  'pb_publishedShifts',
  'pb_weekPointers',
  'pb_auditLogs',
  'pb_idempotency',
];

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

function normalizeToken(value) {
  return String(value || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
}

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

/** 显式创建所有集合，避免首次查询/写入因集合不存在失败 */
async function ensureCollections() {
  const created = [];
  const existed = [];
  const failed = [];

  await Promise.all(
    DB_COLLECTIONS.map(async (name) => {
      try {
        await db.createCollection(name);
        created.push(name);
      } catch (err) {
        const code = err && (err.errCode || err.code);
        const msg = String((err && (err.errMsg || err.message)) || '');
        if (code === -501001 || /exist|已存在/i.test(msg)) {
          existed.push(name);
        } else {
          failed.push(`${name}: ${msg}`);
        }
      }
    })
  );

  if (failed.length > 0) {
    throw new Error(`创建集合失败：${failed.join('；')}`);
  }
  return { created, existed };
}

async function createTeamAndAdmin({ name, orgId, adminOpenid, appId, adminName }) {
  const now = new Date();
  const exists = await safeGet(db.collection('pb_teams').where({ name }).limit(1));
  let teamId;
  if (exists.data.length > 0) {
    teamId = exists.data[0]._id;
  } else {
    const added = await db.collection('pb_teams').add({
      data: {
        orgId: orgId || 'default',
        name,
        timezone: 'Asia/Shanghai',
        createdAt: now,
      },
    });
    teamId = added._id;
  }

  const adminExists = await safeGet(
    db.collection('pb_admins').where({ openid: adminOpenid, teamId }).limit(1)
  );
  if (adminExists.data.length === 0) {
    await db.collection('pb_admins').add({
      data: {
        openid: adminOpenid,
        appId: appId || '',
        orgId: orgId || 'default',
        teamId,
        name: adminName || '管理员',
        createdAt: now,
      },
    });
  }
  return teamId;
}

async function seedShiftTypes(teamId, now) {
  const created = [];
  for (const s of SAMPLE_SHIFTS) {
    const dup = await safeGet(db.collection('pb_shiftTypes').where({ teamId, code: s.code }).limit(1));
    if (dup.data.length > 0) continue;
    await db.collection('pb_shiftTypes').add({
      data: { ...s, teamId, enabled: true, revision: 1, createdAt: now, updatedAt: now },
    });
    created.push(s.code);
  }
  return created;
}

async function seedEmployees(teamId, employees, now) {
  const teamDoc = await db.collection('pb_teams').doc(teamId).get();
  const created = [];
  for (const e of employees || []) {
    const employeeNo = String((e && e.employeeNo) || '').trim();
    const name = String((e && e.name) || '').trim();
    if (!employeeNo || !name) continue;
    const dup = await safeGet(db.collection('pb_employees').where({ teamId, employeeNo }).limit(1));
    if (dup.data.length > 0) continue;
    await db.collection('pb_employees').add({
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
  return created;
}

exports.main = async (event) => {
  const action = event && event.action;
  const expected = normalizeToken(process.env.BOOTSTRAP_TOKEN);
  const provided = normalizeToken(event && event.token);
  const tokenOk = !!expected && provided === expected;

  let firstRun = false;
  let collections = null;

  if (!tokenOk) {
    // 首次运行免 token：仅限 initSelfTeam、未传 token、且系统里还没有任何管理员
    if (action === 'initSelfTeam' && !provided) {
      collections = await ensureCollections();
      const admins = await safeGet(db.collection('pb_admins').limit(1));
      firstRun = admins.data.length === 0;
    }
    if (!firstRun) {
      if (!expected) {
        return {
          ok: false,
          message:
            '未配置 BOOTSTRAP_TOKEN，且系统已有管理员，不能再免 token 初始化。请配置环境变量后重试。',
        };
      }
      return {
        ok: false,
        message:
          `token 不匹配（配置值长度 ${expected.length}，收到长度 ${provided.length}）。` +
          '请确认 token 是 paiban_bootstrap 的环境变量值，且已把占位符替换成真实值。',
      };
    }
  }

  if (!collections) {
    collections = await ensureCollections();
  }

  const now = new Date();

  if (action === 'ensureCollections') {
    return { ok: true, collections };
  }

  if (action === 'initTeam') {
    const name = String(event.name || '').trim();
    const adminOpenid = String(event.adminOpenid || '').trim();
    if (!name || !adminOpenid) return { ok: false, message: 'name 与 adminOpenid 必填' };

    const teamId = await createTeamAndAdmin({
      name,
      orgId: event.orgId,
      adminOpenid,
      appId: event.appId,
      adminName: event.adminName,
    });
    return { ok: true, teamId, collections };
  }

  /**
   * 把当前调用者设为管理员，并顺带初始化示例班次/员工。
   * 首次运行可免 token；之后必须带 token。
   */
  if (action === 'initSelfTeam') {
    const ctx = cloud.getWXContext();
    const openid = ctx.FROM_OPENID || ctx.OPENID;
    const appId = ctx.FROM_APPID || ctx.APPID || '';
    const name = String(event.name || '').trim();
    if (!openid) return { ok: false, message: '无法获取当前用户身份' };
    if (!name) return { ok: false, message: 'name 必填' };

    const teamId = await createTeamAndAdmin({
      name,
      orgId: event.orgId,
      adminOpenid: openid,
      appId,
      adminName: event.adminName,
    });

    const shifts = await seedShiftTypes(teamId, now);
    const employees = Array.isArray(event.employees)
      ? await seedEmployees(teamId, event.employees, now)
      : [];

    return {
      ok: true,
      teamId,
      openid,
      collections,
      seeded: { shifts, employees },
      mode: firstRun ? 'firstRunNoToken' : 'token',
    };
  }

  if (action === 'seedShiftTypes') {
    const teamId = String(event.teamId || '').trim();
    if (!teamId) return { ok: false, message: 'teamId 必填' };
    const created = await seedShiftTypes(teamId, now);
    return { ok: true, created, warning: '示例时间仅用于开发联调，请按真实班次规则修改' };
  }

  if (action === 'seedEmployees') {
    const teamId = String(event.teamId || '').trim();
    const employees = Array.isArray(event.employees) ? event.employees : [];
    if (!teamId || employees.length === 0) return { ok: false, message: 'teamId 与 employees 必填' };
    const created = await seedEmployees(teamId, employees, now);
    return { ok: true, created };
  }

  if (action === 'makeInviteCode') {
    // 仅开发便利：直接生成一个邀请码（正式流程走 admin.issueInvite）
    const employeeId = String(event.employeeId || '').trim();
    if (!employeeId) return { ok: false, message: 'employeeId 必填' };
    const emp = await db.collection('pb_employees').doc(employeeId).get();
    const pepper = process.env.INVITE_PEPPER || 'paiban-invite-pepper-change-me';
    const code = crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, '').toUpperCase().slice(0, 12);
    const tokenHash = crypto.createHash('sha256').update(`${pepper}:${code}`).digest('hex');
    await db.collection('pb_invites').add({
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
