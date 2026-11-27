const { db, _, COLLECTIONS, safeGet } = require('../lib/cloud');
const { getIdentity } = require('../lib/auth');
const { ERR } = require('../lib/errors');

const SAMPLE_SHIFTS = [
  { code: 'DAY_1', label: '日责1', aliases: ['日', '日责', '白班'], category: 'WORK', startLocal: '08:00', endLocal: '16:00', endDayOffset: 0, reminderEnabled: true },
  { code: 'MID', label: '中班', aliases: ['中'], category: 'WORK', startLocal: '14:00', endLocal: '22:00', endDayOffset: 0, reminderEnabled: true },
  { code: 'NIGHT', label: '夜班', aliases: ['夜'], category: 'WORK', startLocal: '20:00', endLocal: '06:00', endDayOffset: 1, reminderEnabled: true },
  { code: 'OFF', label: '休息', aliases: ['休', '公休'], category: 'OFF', startLocal: null, endLocal: null, endDayOffset: 0, reminderEnabled: false },
];

const REQUIRED_COLLECTIONS = ['pb_teams', 'pb_admins', 'pb_employees', 'pb_bindings', 'pb_shiftTypes'];

async function ensureCollections() {
  for (const name of REQUIRED_COLLECTIONS) {
    try {
      await db.createCollection(name);
    } catch (err) {
      const code = err && (err.errCode || err.code);
      const msg = String((err && (err.errMsg || err.message)) || '');
      if (!(code === -501001 || /exist|已存在/i.test(msg))) throw err;
    }
  }
}

async function nextEmployeeNo(teamId) {
  const all = await safeGet(db.collection(COLLECTIONS.employees).where({ teamId }).limit(500));
  const nums = all.data.map((e) => Number(e.employeeNo)).filter((n) => Number.isInteger(n) && n >= 0);
  let next = (nums.length ? Math.max(...nums) : 0) + 1;
  for (let i = 0; i < 50; i += 1) {
    const candidate = String(next + i).padStart(4, '0');
    const dup = await safeGet(
      db.collection(COLLECTIONS.employees).where({ teamId, employeeNo: candidate }).limit(1)
    );
    if (dup.data.length === 0) return candidate;
  }
  return `A${Date.now().toString().slice(-6)}`;
}

/**
 * 测试环境一键初始化（免权限）：
 * 仅在系统里还没有任何管理员时可用，创建团队 / 管理员 / 员工绑定 / 示例班次。
 * 一旦存在管理员即关闭，避免长期后门。
 */
async function ensureTestSetup(payload) {
  const identity = await getIdentity();
  await ensureCollections();

  const admins = await safeGet(db.collection(COLLECTIONS.admins).limit(1));
  const isAdmin = identity.adminTeams.length > 0;
  if (admins.data.length > 0 && !isAdmin) {
    throw ERR.FORBIDDEN('系统已有管理员，请让管理员为你开通，或使用 BOOTSTRAP_TOKEN 初始化');
  }

  const now = new Date();

  // 团队
  let teamId;
  const teams = await safeGet(db.collection(COLLECTIONS.teams).limit(1));
  if (teams.data.length > 0) {
    teamId = teams.data[0]._id;
  } else {
    const added = await db.collection(COLLECTIONS.teams).add({
      data: { orgId: 'default', name: '测试团队', timezone: 'Asia/Shanghai', createdAt: now },
    });
    teamId = added._id;
  }
  const teamDoc = await db.collection(COLLECTIONS.teams).doc(teamId).get();

  // 管理员
  if (!isAdmin) {
    await db.collection(COLLECTIONS.admins).add({
      data: {
        openid: identity.openid,
        appId: identity.appId || '',
        orgId: teamDoc.data.orgId || 'default',
        teamId,
        name: payload.adminName || '管理员',
        createdAt: now,
      },
    });
  }

  // 员工 + 绑定
  let employeeId = identity.binding ? identity.binding.employeeId : null;
  let employeeNo = '';
  let name = '';
  if (employeeId) {
    const emp = await db.collection(COLLECTIONS.employees).doc(employeeId).get().catch(() => null);
    if (emp && emp.data) {
      employeeNo = emp.data.employeeNo;
      name = emp.data.name;
    }
  } else {
    employeeNo = await nextEmployeeNo(teamId);
    name = String(payload.name || '测试员工').trim().slice(0, 32) || '测试员工';
    const added = await db.collection(COLLECTIONS.employees).add({
      data: {
        orgId: teamDoc.data.orgId || 'default',
        teamId,
        employeeNo,
        name,
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      },
    });
    employeeId = added._id;
    await db.collection(COLLECTIONS.bindings).add({
      data: {
        appId: identity.appId || '',
        openid: identity.openid,
        employeeId,
        orgId: teamDoc.data.orgId || 'default',
        teamId,
        status: 'ACTIVE',
        boundBy: 'dev-setup',
        boundAt: now,
        createdAt: now,
      },
    });
  }

  // 示例班次
  const shifts = await safeGet(
    db.collection(COLLECTIONS.shiftTypes).where({ teamId }).limit(1)
  );
  let seededShifts = 0;
  if (shifts.data.length === 0) {
    for (const s of SAMPLE_SHIFTS) {
      await db.collection(COLLECTIONS.shiftTypes).add({
        data: { ...s, teamId, enabled: true, revision: 1, createdAt: now, updatedAt: now },
      });
      seededShifts += 1;
    }
  }

  return {
    teamId,
    teamName: teamDoc.data.name,
    employeeId,
    employeeNo,
    name,
    seededShifts,
    devSetup: true,
  };
}

module.exports = { ensureTestSetup };
