/** 解析模型输出为严格结构，尽量容忍代码块包裹与多余解释。 */
function extractJson(text) {
  if (typeof text !== 'string') throw new Error('EMPTY_CONTENT');
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('NO_JSON_OBJECT');
  s = s.slice(start, end + 1);
  try {
    return JSON.parse(s);
  } catch (e) {
    // 常见问题：尾逗号
    try {
      return JSON.parse(s.replace(/,\s*([}\]])/g, '$1'));
    } catch (e2) {
      throw new Error('BAD_JSON');
    }
  }
}

function normalizeRect(rect) {
  if (!rect || typeof rect !== 'object') return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const x = num(rect.x);
  const y = num(rect.y);
  const w = num(rect.w);
  const h = num(rect.h);
  if (x === null || y === null) return null;
  return { x, y, w: w === null ? 0 : w, h: h === null ? 0 : h };
}

/**
 * @returns {{rows: Array<{employeeNo:string,name:string,cells:Array}>, notes:string}}
 */
function parseRecognition(text) {
  const json = extractJson(text);
  const employees = Array.isArray(json.employees) ? json.employees : Array.isArray(json.rows) ? json.rows : [];
  const rows = employees.map((e, idx) => {
    const cellsRaw = Array.isArray(e.cells) ? e.cells : Array.isArray(e.days) ? e.days : [];
    return {
      employeeNo: e.employeeNo != null ? String(e.employeeNo).trim() : '',
      name: e.name != null ? String(e.name).trim() : '',
      rowIndex: idx,
      cells: cellsRaw.map((c, ci) => {
        const dateRaw = c.date != null ? String(c.date).trim() : '';
        let date = null;
        const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(dateRaw);
        if (m) {
          date = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
        } else if (/^\d{1,2}[-/.]\d{1,2}$/.test(dateRaw)) {
          date = dateRaw; // 缺年份，交由上层按周补齐
        }
        return {
          date,
          text: c.text != null ? String(c.text).trim() : '',
          confidence:
            typeof c.confidence === 'number' && Number.isFinite(c.confidence) ? c.confidence : null,
          rect: normalizeRect(c.rect),
          cellIndex: ci,
        };
      }),
    };
  });
  return { rows, notes: typeof json.notes === 'string' ? json.notes : '' };
}

module.exports = { parseRecognition, extractJson };
