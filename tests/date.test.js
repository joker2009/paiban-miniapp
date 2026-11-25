const assert = require('node:assert');
const d = require('../cloudfunctions/api/lib/date');
const { extractJson } = require('../cloudfunctions/ocr/lib/parse');

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

test('合成本地时间带 +08:00', () => {
  assert.strictEqual(d.composeISO('2026-12-07', '20:00', 0), '2026-12-07T20:00:00+08:00');
  assert.strictEqual(d.composeISO('2026-12-07', '06:00', 1), '2026-12-08T06:00:00+08:00');
});

test('跨日班次合法性', () => {
  assert.strictEqual(d.validateShiftTimes('20:00', '06:00', 1), null);
  assert.ok(d.validateShiftTimes('20:00', '06:00', 0));
  assert.ok(d.validateShiftTimes('08:00', '08:00', 0));
  assert.strictEqual(d.validateShiftTimes('08:00', '16:00', 0), null);
});

test('周一与日期运算', () => {
  assert.strictEqual(d.mondayOf('2026-12-09'), '2026-12-07');
  assert.strictEqual(d.weekday('2026-12-07'), 1);
  assert.strictEqual(d.addDays('2026-12-07', 6), '2026-12-13');
  assert.strictEqual(d.diffDays('2026-12-07', '2026-12-13'), 6);
});

test('非法日期拒绝', () => {
  assert.strictEqual(d.isValidDate('2026-02-29'), false);
  assert.strictEqual(d.isValidDate('2026-02-28'), true);
  assert.strictEqual(d.isValidDate('2026-2-8'), false);
});

test('模型输出容忍代码块与尾逗号', () => {
  const a = extractJson('```json\n{"employees":[],"notes":"ok"}\n```');
  assert.deepStrictEqual(a.employees, []);
  const b = extractJson('前缀 {"a":[1,2,],} 后缀');
  assert.deepStrictEqual(b.a, [1, 2]);
});

console.log('date/parse tests done');
