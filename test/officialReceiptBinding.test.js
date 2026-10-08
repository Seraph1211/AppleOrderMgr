/* eslint-disable camelcase -- 直接模拟数据库返回的真实 snake_case 列名。 */
/* eslint-disable no-magic-numbers -- 内部写入契约的合成边界值。 */
const crypto = require('crypto');
const {
  deviceSetHash,
  validateReceiptBinding,
  readReceiptInput,
  readReceiptPlan,
} = require('../src/services/officialReceiptBinding');
const { hash } = require('../src/services/officialOrderSupport');
const transaction = {};
let row;
let deps;
beforeEach(() => {
  row = {
    id: 1,
    order_number: 'W1234567890',
    order_url: 'https://www.apple.com.cn/xc/cn/vieworder/W1234567890/contact@example.invalid',
    apple_id: 'test@example.invalid',
    apple_id_ref: 2,
    apple_password: 'cipher',
    email_order_status: 'picked_up',
    row_hash: 'a'.repeat(32),
    account_candidates: [
      { id: 2, apple_id: 'TEST@example.invalid', password: 'cipher', status: '正常' },
    ],
  };
  deps = {
    decrypt: value => (value === 'cipher' ? 'synthetic' : value),
    getEffectivePermissions: jest
      .fn()
      .mockResolvedValue(['orders.read', 'pickups.read', 'pickups.edit']),
    db: {
      User: { findByPk: jest.fn().mockResolvedValue({ id: 1, role: 'admin', status: 'active' }) },
      PickupDevice: { findAll: jest.fn().mockResolvedValue([]) },
      sequelize: {
        transaction: jest.fn(callback => callback(transaction)),
        query: jest
          .fn()
          .mockImplementation(sql => Promise.resolve(sql.startsWith('SET') ? [] : [[row]])),
      },
    },
  };
});
test('采集快照同时校验账号档案与订单凭据，输出正确身份摘要', async () => {
  const value = await readReceiptInput(1, 1, deps);
  expect(value).toMatchObject({
    actorUserId: 1,
    devicesBeforeHash: deviceSetHash([]),
    previousDeviceCount: 0,
  });
  expect(value.samples[0]).toMatchObject({
    id: 1,
    credentialSource: 'accountRegistry',
    beforeRowHash: row.row_hash,
    password: 'synthetic',
  });
});
test.each([
  [
    'not-picked',
    () => {
      row.email_order_status = 'processing';
    },
    'RECEIPT_ORDER_NOT_PICKED_UP',
  ],
  [
    'ambiguous',
    () => {
      row.account_candidates.push({ ...row.account_candidates[0], id: 3 });
    },
    'RECEIPT_ACCOUNT_CONFLICT',
  ],
  [
    'reference',
    () => {
      row.apple_id_ref = 3;
    },
    'RECEIPT_ACCOUNT_CONFLICT',
  ],
  [
    'abnormal',
    () => {
      row.account_candidates[0].status = '异常';
    },
    'RECEIPT_ACCOUNT_CONFLICT',
  ],
  [
    'password',
    () => {
      row.apple_password = 'different';
    },
    'RECEIPT_CREDENTIAL_CONFLICT',
  ],
  [
    'locked',
    () => deps.db.User.findByPk.mockResolvedValue({ role: 'admin', status: 'locked' }),
    'RECEIPT_ACTOR_INVALID',
  ],
  [
    'permission',
    () => deps.getEffectivePermissions.mockResolvedValue(['orders.read']),
    'RECEIPT_PERMISSION_DENIED',
  ],
])('%s 不进行采集', async (_name, change, code) => {
  change();
  await expect(readReceiptInput(1, 1, deps)).rejects.toThrow(code);
});
test('非法系统 ID 不查询数据库', async () => {
  await expect(readReceiptInput('1', 1, deps)).rejects.toThrow('RECEIPT_INPUT_INVALID');
  expect(deps.db.sequelize.transaction).not.toHaveBeenCalled();
});
test('批次一次预加载订单并保留缺失行，不按订单 N+1 查询', async () => {
  row = {
    id: 1,
    orderNumber: 'W1234567890',
    account: 'test@example.invalid',
    status: 'picked_up',
    hasUrl: true,
  };
  const result = await readReceiptPlan([1, 2], 1, deps);
  expect(result).toEqual([
    {
      orderId: 1,
      outcome: 'RECEIPT_READY',
      accountHash: hash(row.account),
      identity: hash(JSON.stringify([1, row.orderNumber, hash(row.account)])),
    },
    { orderId: 2, outcome: 'RECEIPT_ORDER_NOT_ELIGIBLE' },
  ]);
  expect(deps.db.sequelize.query).toHaveBeenCalledTimes(2);
  await expect(readReceiptPlan([1, 1], 1, deps)).rejects.toThrow('RECEIPT_PLAN_INVALID');
});
test('绑定契约拒绝重复 SN、未来／过期证明和未验证出口', () => {
  const input = {
    version: 1,
    requestKey: crypto.randomUUID(),
    batchId: crypto.randomUUID(),
    actorUserId: 1,
    orderId: 1,
    orderNumber: 'W1234567890',
    orderBeforeHash: 'a'.repeat(32),
    devicesBeforeHash: deviceSetHash([]),
    receipt: {
      runId: 1,
      sha256: 'b'.repeat(64),
      detailSha256: 'c'.repeat(64),
      observedAt: new Date().toISOString(),
      egressVerified: true,
      requestCoverageVerified: true,
    },
    items: [{ serialNumber: 'TESTSN0001', partNumber: 'TEST/A', productName: 'TEST PHONE' }],
  };
  expect(validateReceiptBinding(input).serials).toEqual(['TESTSN0001']);
  expect(() =>
    validateReceiptBinding({ ...input, items: [...input.items, ...input.items] })
  ).toThrow('RECEIPT_BINDING_SERIAL_INVALID');
  for (const change of [
    { egressVerified: false },
    { requestCoverageVerified: false },
    { observedAt: '2099-01-01T00:00:00Z' },
    { observedAt: '2020-01-01T00:00:00Z' },
  ]) {
    expect(() =>
      validateReceiptBinding({ ...input, receipt: { ...input.receipt, ...change } })
    ).toThrow('RECEIPT_BINDING_PROOF_INVALID');
  }
  expect(() => validateReceiptBinding({ ...input, requestKey: 'invalid' })).toThrow(
    'RECEIPT_BINDING_INPUT_INVALID'
  );
});
