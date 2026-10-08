/* eslint-disable no-magic-numbers -- 受控脚本沙箱验证绑定前置条件。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const code = fs.readFileSync(
  path.join(__dirname, '../scripts/officialPickupBackfill/bindReceipt.js'),
  'utf8'
);

async function execute({
  changed = false,
  conflict = false,
  missingFields = false,
  missingBaseline = true,
} = {}) {
  try {
    const create = jest.fn();
    const order = {
      stableHash: changed ? 'changed' : 'stable',
      hash: 'status-updated-hash',
      fullHash: 'full',
      orderNumber: 'W1234567890',
      status: 'picked_up',
      pickupDate: '2026-09-22',
    };
    const device = {
      id: 1,
      orderId: conflict ? 99 : 1,
      serialNumber: 'A123456789',
      stockUnitId: 1,
    };
    const db = {
      sequelize: {
        transaction: work => work({}),
        query: jest.fn().mockResolvedValue([[order]]),
        close: jest.fn(),
      },
      User: { findOne: jest.fn().mockResolvedValue({ id: 1 }) },
      PickupRecord: { findOne: jest.fn().mockResolvedValue({ status: 'pending' }) },
      PickupDevice: { findAll: jest.fn().mockResolvedValue([device]) },
      StockUnit: { findAll: jest.fn().mockResolvedValue([{ id: 1 }]) },
    };
    let output = '';
    const payload = {
      cutoff: '2026-09-23',
      startedAt: new Date().toISOString(),
      entry: { id: 1, orderNumber: order.orderNumber, stableRowHash: 'stable', rowHash: 'legacy' },
      receipt: { orderNumber: order.orderNumber, status: 200, egressVerifiedAfter: true },
      parsed: { orderNumber: order.orderNumber, items: [{ serialNumber: device.serialNumber }] },
    };
    if (missingFields) {
      Object.assign(payload, { cutoff: null, scope: 'missing-fields', schemaVersion: 3 });
      Object.assign(payload.entry, {
        dateMissing: missingBaseline,
        serialsMissing: false,
        previousDevices: [device],
      });
      order.pickupDate = '2026-10-01';
    }
    await vm.runInNewContext(code, {
      PAYLOAD: payload,
      process: {
        stdout: {
          write: text => {
            output += text;
          },
        },
      },
      require: name => {
        if (name === './src/models') return db;
        if (name === './src/controllers/pickupDeviceController') return { create };
        if (name === './src/services/permissionService')
          return { getEffectivePermissions: () => ['orders.read', 'pickups.read', 'pickups.edit'] };
        if (name === 'sequelize') return { Op: { or: Symbol('or'), in: Symbol('in') } };
        return require(name);
      },
    });
    return { output: JSON.parse(output), create };
  } catch (error) {
    error.component = 'receiptBindingTest';
    throw error;
  }
}

test('官网状态更新后凭非目标字段摘要验证已有绑定，不记为新增', async () => {
  const { output, create } = await execute();
  expect(output).toMatchObject({ outcome: 'SERIALS_VERIFIED', newBindings: 0 });
  expect(create).not.toHaveBeenCalled();
});
test('非目标字段变化拒绝，不写绑定', async () => {
  const { output, create } = await execute({ changed: true });
  expect(output.outcome).toBe('ORDER_CHANGED');
  expect(create).not.toHaveBeenCalled();
});
test('其他订单绑定冲突保留，不覆盖', async () => {
  const { output, create } = await execute({ conflict: true });
  expect(output.outcome).toBe('DEVICE_BINDING_CONFLICT');
  expect(create).not.toHaveBeenCalled();
});
test('缺失字段范围允许截止日之后订单的收据，保持既有绑定', async () => {
  const { output, create } = await execute({ missingFields: true });
  expect(output).toMatchObject({ outcome: 'SERIALS_VERIFIED', newBindings: 0 });
  expect(create).not.toHaveBeenCalled();
});
test('缺失字段计划没有任何缺失基线时拒绝绑定', async () => {
  const { output, create } = await execute({ missingFields: true, missingBaseline: false });
  expect(output.outcome).toBe('SCOPE_INVALID');
  expect(create).not.toHaveBeenCalled();
});
