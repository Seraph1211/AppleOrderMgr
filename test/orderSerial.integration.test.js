const enabled = process.env.RUN_ORDER_SERIAL_INTEGRATION === 'true';
const suite = enabled ? describe : describe.skip;
suite('订单序列号 HTTP、数据库和审计事务', () => {
  let db, server, base, user, other, order, device;
  const request = async (method, suffix = '', body, role = 'admin') => {
    try {
      const response = await fetch(`${base}/api/orders/${order.id}/devices${suffix}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-role': role },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, body: await response.json() };
    } catch (error) {
      throw new Error('隔离序列号请求失败', { cause: error });
    }
  };
  const edit = (serialBarcode = 'TEST000002', extra = {}) =>
    request('PUT', `/${device.id}`, {
      serialBarcode,
      expectedSerialNumber: 'TEST000001',
      reason: '纠正录入错误',
      ...extra,
    });
  beforeAll(async () => {
    if (process.env.DB_NAME !== 'apple_order_mgr_serial_test_20261008')
      throw new Error('仅允许隔离测试库');
    db = require('../src/models');
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const role = req.headers['x-role'];
      req.user =
        role === 'outside'
          ? { ...other.toJSON(), permissions: ['orders.read', 'orders.edit'] }
          : {
            ...user.toJSON(),
            role: role === 'read' ? 'operator' : 'admin',
            permissions: role === 'read' ? ['orders.read'] : ['orders.read', 'orders.edit'],
          };
      req.requestId = '01234567-0000-4000-8000-000000000099';
      next();
    });
    app.use(require('../src/middleware/operationAudit').operationAudit);
    app.use('/api/orders', require('../src/routes/orders'));
    app.use(require('../src/middleware/errorHandler'));
    server = await new Promise(resolve => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  beforeEach(async () => {
    await db.sequelize.query(
      'TRUNCATE users, orders, stock_units, stock_operations, stock_events, pickup_records, operation_logs RESTART IDENTITY CASCADE'
    );
    user = await db.User.create({
      username: 'serial_admin',
      password: 'Synthetic-Test-Only-123!',
      role: 'admin',
    });
    other = await db.User.create({
      username: 'serial_outside',
      password: 'Synthetic-Test-Only-123!',
      role: 'operator',
      orderAccess: { mode: 'tags', tags: ['OUTSIDE'] },
    });
    await db.UserPermission.bulkCreate(
      ['orders.read', 'orders.edit'].map(permissionCode => ({ userId: other.id, permissionCode }))
    );
    order = await db.Order.create({
      orderNumber: 'W9701000672',
      tag: 'INSIDE',
      products: [{ name: '合成测试设备', quantity: 2 }],
    });
    const result = await request('POST', '', { serialBarcode: 'TEST000001' });
    expect(result.status).toBe(201);
    device = result.body.data.device;
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (db) await db.sequelize.close();
  });
  test('更正保留设备身份，同步库存、回读及两种审计', async () => {
    const before = await db.PickupDevice.findByPk(device.id);
    expect((await edit('stest000002')).status).toBe(200);
    expect((await request('GET')).body.data.items[0].serialNumber).toBe('TEST000002');
    const after = await db.PickupDevice.findByPk(device.id);
    expect(after.stockUnitId).toBe(before.stockUnitId);
    expect((await db.StockUnit.findByPk(after.stockUnitId)).serialNumber).toBe('TEST000002');
    const event = await db.PickupRecordEvent.findOne({
      where: { eventType: 'device_serial_updated' },
    });
    expect(event.changes).toMatchObject({
      before: { serialNumber: 'TEST000001' },
      after: { serialNumber: 'TEST000002' },
      reason: '纠正录入错误',
      requestId: '01234567-0000-4000-8000-000000000099',
    });
    expect(event.actorUserId).toBe(user.id);
    expect(await db.StockEvent.count({ where: { action: 'order.serial_update' } })).toBe(1);
    expect(await db.OperationLog.count({ where: { method: 'PUT', result: 'success' } })).toBe(1);
    expect((await db.PickupRecord.findOne()).status).toBe('pending');
  });
  test('重复号码和非法输入拒绝且不改动', async () => {
    await request('POST', '', { serialBarcode: 'TEST000002' });
    expect((await edit()).status).toBe(409);
    expect((await edit('1234567890')).status).toBe(400);
    expect((await edit('TEST000003', { reason: '' })).status).toBe(400);
    expect((await db.PickupDevice.findByPk(device.id)).serialNumber).toBe('TEST000001');
    expect(
      await db.PickupRecordEvent.count({ where: { eventType: 'device_serial_updated' } })
    ).toBe(0);
  });
  test('只读权限和 TAG 越权拒绝', async () => {
    const body = {
      serialBarcode: 'TEST000002',
      expectedSerialNumber: 'TEST000001',
      reason: '测试',
    };
    expect((await request('PUT', `/${device.id}`, body, 'read')).status).toBe(403);
    expect((await request('PUT', `/${device.id}`, body, 'outside')).status).toBe(404);
    expect((await request('GET', '', undefined, 'outside')).status).toBe(404);
    expect((await request('POST', '', { serialBarcode: 'TEST000003' }, 'read')).status).toBe(403);
  });
  test('并发修改只允许一项成功，旧值不能覆盖新值', async () => {
    const results = await Promise.all([edit('TEST000002'), edit('TEST000003')]);
    expect(results.map(item => item.status).sort()).toEqual([200, 409]);
    expect(
      await db.PickupRecordEvent.count({ where: { eventType: 'device_serial_updated' } })
    ).toBe(1);
  });
  test('审计失败回滚主档与绑定，无变更不追加事件', async () => {
    expect((await edit('TEST000001')).status).toBe(200);
    const spy = jest
      .spyOn(db.PickupRecordEvent, 'create')
      .mockRejectedValueOnce(new Error('synthetic audit failure'));
    try {
      expect((await edit()).status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect((await db.PickupDevice.findByPk(device.id)).serialNumber).toBe('TEST000001');
    expect((await db.StockUnit.findOne()).serialNumber).toBe('TEST000001');
    expect(await db.StockEvent.count({ where: { action: 'order.serial_update' } })).toBe(0);
  });
  test('删除误录序列号保留库存主档和审计，重复删除不影响重新绑定', async () => {
    const before = await db.PickupDevice.findByPk(device.id);
    const body = { expectedSerialNumber: 'TEST000001', reason: '误录，删除绑定' };
    expect((await request('DELETE', `/${device.id}`, body)).body.data.removed).toBe(true);
    expect((await request('GET')).body.data.items).toEqual([]);
    expect((await db.StockUnit.findByPk(before.stockUnitId)).serialNumber).toBe('TEST000001');
    const event = await db.PickupRecordEvent.findOne({ where: { eventType: 'device_removed' } });
    expect(event.changes).toMatchObject({
      device: { id: device.id, serialNumber: 'TEST000001' },
      reason: body.reason,
    });
    expect(await db.OperationLog.count({ where: { method: 'DELETE', result: 'success' } })).toBe(1);
    expect((await request('DELETE', `/${device.id}`, body)).body.data.removed).toBe(false);
    const rebound = await request('POST', '', { serialBarcode: 'TEST000001' });
    expect(rebound.status).toBe(201);
    expect(rebound.body.data.device.id).not.toBe(device.id);
    expect((await request('DELETE', `/${device.id}`, body)).body.data.removed).toBe(false);
    expect(await db.PickupDevice.count()).toBe(1);
    expect(await db.PickupRecordEvent.count({ where: { eventType: 'device_removed' } })).toBe(1);
  });
  test('删除要求原因、原值及权限，越权和过期草稿均拒绝', async () => {
    const body = { expectedSerialNumber: 'TEST000001', reason: '误录' };
    expect((await request('DELETE', `/${device.id}`, { ...body, reason: '' })).status).toBe(400);
    expect((await request('DELETE', `/${device.id}`, body, 'read')).status).toBe(403);
    expect((await request('DELETE', `/${device.id}`, body, 'outside')).status).toBe(404);
    expect((await edit()).status).toBe(200);
    expect((await request('DELETE', `/${device.id}`, body)).status).toBe(409);
    expect(await db.PickupDevice.count()).toBe(1);
  });
  test('删除时库存审计失败，绑定和取货审计完整回滚', async () => {
    const spy = jest
      .spyOn(db.StockEvent, 'create')
      .mockRejectedValueOnce(new Error('synthetic removal audit failure'));
    try {
      expect(
        (
          await request('DELETE', `/${device.id}`, {
            expectedSerialNumber: 'TEST000001',
            reason: '误录',
          })
        ).status
      ).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(await db.PickupDevice.count()).toBe(1);
    expect(await db.PickupRecordEvent.count({ where: { eventType: 'device_removed' } })).toBe(0);
    expect((await db.PickupRecord.findOne()).version).toBe(1);
  });
});
