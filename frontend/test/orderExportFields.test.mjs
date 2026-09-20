import assert from 'node:assert/strict';
import test from 'node:test';
import { getDefaultOrderExportFields } from '../src/constants/orderExportFields.js';

test('订单导出首次默认字段来自当前可见业务列并排除敏感列', () => {
  const fields = getDefaultOrderExportFields([
    { key: 'orderNumber', visible: true },
    { key: 'products', visible: true },
    { key: 'recipientName', visible: false },
    { key: 'applePassword', visible: true },
    { key: 'recipientIdCard', visible: true },
    { key: 'orderUrl', visible: true },
    { key: 'paymentScreenshot', visible: true },
    { key: 'actions', visible: true },
  ]);

  assert.deepEqual(fields, [
    'systemOrderId',
    'orderNumber',
    'ingestionSource',
    'products',
    'orderAmount',
    'currency',
    'amountSource',
  ]);
});
