import test from 'node:test';
import assert from 'node:assert/strict';
import { formatOfficialRefreshDuration } from '../src/utils/officialRefreshDuration.js';

const startedAt = '2026-10-09T03:53:00.000Z';
const start = Date.parse(startedAt);

test('运行耗时按服务器时间递增，完成后固定且不包含排队时间', () => {
  const running = { state: 'running', startedAt, createdAt: '2026-10-09T03:50:00Z' };
  assert.equal(formatOfficialRefreshDuration(running, start + 44000), '44 秒');
  assert.equal(formatOfficialRefreshDuration(running, start + 65000), '1 分 5 秒');
  const done = { ...running, state: 'succeeded', finishedAt: '2026-10-09T03:53:44.900Z' };
  assert.equal(formatOfficialRefreshDuration(done, start + 3600000), '44 秒');
  assert.equal(formatOfficialRefreshDuration({ ...done, state: 'failed' }, start), '44 秒');
  assert.equal(formatOfficialRefreshDuration({ ...done, state: 'cancelled' }, start), '44 秒');
  assert.equal(formatOfficialRefreshDuration(running, start + 3661000), '1 小时 1 分 1 秒');
});

test('未开始、旧任务缺时间、无效时间和反向时间显示占位', () => {
  for (const job of [
    { state: 'queued', startedAt: null, finishedAt: null },
    { state: 'cancelled', startedAt: null, finishedAt: startedAt },
    { state: 'succeeded' },
    { state: 'running', startedAt: 'invalid' },
    { state: 'failed', startedAt, finishedAt: 'invalid' },
    { state: 'running', startedAt: '2026-10-09T04:00:00Z' },
    { state: 'failed', startedAt, finishedAt: '2026-10-09T03:52:00Z' },
  ])
    assert.equal(formatOfficialRefreshDuration(job, start), '—');
});
