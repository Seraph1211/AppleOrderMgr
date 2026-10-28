import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  taskConfigEffectiveAt,
  taskConfigError,
  taskConfigNeedsReview,
} from '../src/utils/taskConfigDisplay.js';

test('配置生效时间固定按北京时间解释，与浏览器时区无关', () => {
  assert.equal(taskConfigEffectiveAt('2026-01-01T08:30:45'), '2026-01-01T00:30:45.000Z');
  assert.equal(taskConfigEffectiveAt(''), undefined);
  assert.throws(() => taskConfigEffectiveAt('invalid'), /有效/);
  assert.throws(() => taskConfigEffectiveAt('2099-01-01T08:30'), /晚于/);
});

test('409保留预览过期、停用和并发冲突各自原因', () => {
  for (const message of ['预览已过期', '实例已停用', '配置已被更新']) {
    assert.equal(
      taskConfigError({ response: { status: 409, data: { error: { message } } } }),
      message
    );
  }
});

test('24小时建议复核只适用已生效配置，不把待更新或缺失改成有效', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  assert.equal(
    taskConfigNeedsReview({ status: 'active', lastConfirmedAt: '2026-10-27T12:00:00Z' }, now),
    true
  );
  assert.equal(
    taskConfigNeedsReview({ status: 'active', lastConfirmedAt: '2026-10-27T12:00:01Z' }, now),
    false
  );
  assert.equal(
    taskConfigNeedsReview({ status: 'invalidated', lastConfirmedAt: '2026-10-20T12:00:00Z' }, now),
    false
  );
  assert.equal(taskConfigNeedsReview({ status: 'missing', lastConfirmedAt: null }, now), false);
});
