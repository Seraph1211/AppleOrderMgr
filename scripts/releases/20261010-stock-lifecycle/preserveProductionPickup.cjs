// 现行生产 finishGroup 已保存官网取货日期；增量发布保留此行为。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = '/app/src/services/officialOrderRefreshService.js';
const original = fs.readFileSync(path, 'utf8');
const start = original.indexOf('async function finishGroup(');
assert(start > 0, '生产账号组入口必须存在');
let source = original.slice(start);
const replacements = [
  [
    'observed: result?.observedAt || null,',
    'observed: result?.observedAt || null,\n            pickup: result?.actualPickupDate || null,',
  ],
  [
    'UPDATE orders o SET official_raw_status=x.status,official_status_observed_at=x.observed\n',
    'UPDATE orders o SET official_raw_status=x.status,official_status_observed_at=x.observed,\n             actual_pickup_date=COALESCE(x.pickup,o.actual_pickup_date)\n',
  ],
  [
    'status text,observed timestamptz,error text)',
    'status text,observed timestamptz,error text,pickup date)',
  ],
];
for (const [before, after] of replacements) {
  assert.equal(source.split(before).length, 2, '生产兼容补丁必须唯一匹配');
  source = source.replace(before, after);
}
fs.writeFileSync(path, original.slice(0, start) + source);
