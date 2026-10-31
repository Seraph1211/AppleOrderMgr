import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { formatProxyFee, getProxyFeeError } from '../src/pages/proxyOrders/presentation.js';
const { normalizeProxyFee } = createRequire(import.meta.url)('../../src/utils/proxyFee.js');

test('前后端精度一致；未知、零和非法金额不混淆', () => {
  for (const value of [undefined, null, '', ' ', 0, '0.00', '1.2', '001.20', '9999999999.99']) {
    assert.equal(getProxyFeeError(value), '');
    const saved = normalizeProxyFee(value);
    assert.equal(formatProxyFee(saved), formatProxyFee(value));
  }
  for (const value of [
    -1,
    '-0.01',
    '1.234',
    '1e2',
    '¥120',
    '1,200',
    '10000000000',
    NaN,
    Infinity,
    true,
    [],
    {},
  ]) {
    assert.ok(getProxyFeeError(value));
    assert.throws(() => normalizeProxyFee(value));
    assert.equal(formatProxyFee(value), '待核对');
  }
  assert.equal(formatProxyFee(null), '未登记');
  assert.equal(formatProxyFee(0), '¥0.00');
});
