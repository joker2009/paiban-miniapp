const { ERR } = require('./errors');

function str(v, field, { min = 1, max = 200 } = {}) {
  if (typeof v !== 'string') throw ERR.INVALID_ARGUMENT(`${field} 必须是字符串`);
  const s = v.trim();
  if (s.length < min) throw ERR.INVALID_ARGUMENT(`${field} 不能为空`);
  if (s.length > max) throw ERR.INVALID_ARGUMENT(`${field} 过长`);
  return s;
}

function optStr(v, field, opts) {
  if (v === undefined || v === null || v === '') return null;
  return str(v, field, opts);
}

function int(v, field, { min = -Infinity, max = Infinity } = {}) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw ERR.INVALID_ARGUMENT(`${field} 不合法`);
  }
  return v;
}

function bool(v, field) {
  if (typeof v !== 'boolean') throw ERR.INVALID_ARGUMENT(`${field} 必须是布尔值`);
  return v;
}

function arr(v, field, { min = 0, max = 1000 } = {}) {
  if (!Array.isArray(v) || v.length < min || v.length > max) {
    throw ERR.INVALID_ARGUMENT(`${field} 数量不合法`);
  }
  return v;
}

function isoDateTime(v, field) {
  if (typeof v !== 'string') throw ERR.INVALID_ARGUMENT(`${field} 不合法`);
  const t = new Date(v).getTime();
  if (!Number.isFinite(t)) throw ERR.INVALID_ARGUMENT(`${field} 不是有效时间`);
  return v;
}

module.exports = { str, optStr, int, bool, arr, isoDateTime };
