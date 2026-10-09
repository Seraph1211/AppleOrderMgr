import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getDefaultOrderExportFields,
  orderExportFields,
} from '../src/constants/orderExportFields.js';

test('订单导出首次默认字段来自当前可见业务列并排除敏感列', () => {
  const fields = getDefaultOrderExportFields([
    { key: 'orderNumber', visible: true },
    { key: 'products', visible: true },
    { key: 'emailPickupInfo', visible: true },
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
    'emailPickupStore',
    'emailPickupSchedule',
  ]);
});

test('官网状态默认选择跟随列表，预约字段去掉邮件前缀', () => {
  assert.deepEqual(getDefaultOrderExportFields([{ key: 'officialOrderStatus', visible: true }]), [
    'officialOrderStatus',
  ]);
  assert.deepEqual(
    getDefaultOrderExportFields([{ key: 'officialOrderStatus', visible: false }]),
    []
  );
  for (const [key, label] of [
    ['emailPickupStore', '取货门店'],
    ['emailPickupDate', '取货日期'],
    ['emailPickupSchedule', '取货安排'],
  ])
    assert.equal(orderExportFields.find(field => field.key === key).label, label);
});

test('前后端官网状态中文名称一致', async () => {
  const { createRequire } = await import('node:module');
  const { OFFICIAL_ORDER_STATUS_LABELS: backendLabels } = createRequire(import.meta.url)(
    '../../src/constants/officialOrderStatus.js'
  );
  const { OFFICIAL_ORDER_STATUS_LABELS } = await import('../src/constants/officialOrderStatus.js');
  for (const [status, label] of Object.entries(OFFICIAL_ORDER_STATUS_LABELS)) {
    assert.equal(backendLabels[status], label);
  }
});
