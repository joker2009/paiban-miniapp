const { db, COLLECTIONS } = require('./cloud');

/** 最小审计：不记录原图、敏感备注或邀请码明文 */
async function audit({ teamId, operatorOpenid, action, refId, summary }) {
  try {
    await db.collection(COLLECTIONS.auditLogs).add({
      data: {
        teamId: teamId || null,
        operatorOpenid,
        action,
        refId: refId || null,
        summary: summary || null,
        createdAt: new Date(),
      },
    });
  } catch (e) {
    console.warn('[audit] write failed', e && e.message);
  }
}

module.exports = { audit };
