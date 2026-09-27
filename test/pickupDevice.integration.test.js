const suite = process.env.RUN_PICKUP_DEVICE_INTEGRATION === 'true' ? describe : describe.skip;

suite('设备扫码真实数据库、HTTP 权限和事务', () => {
  let models;
  let server;
  let baseUrl;
  let user;
  let orders;
  const pair = { serialBarcode: 'STEST000001' };
  const second = { serialBarcode: 'STEST000002' };

  async function request(orderId, method = 'GET', body, role = 'staff', deviceId = '') {
    try {
      const res = await fetch(
        `${baseUrl}/pickups/${orderId}/devices${deviceId ? `/${deviceId}` : ''}`,
        {
          method,
          headers: { 'Content-Type': 'application/json', 'x-test-role': role },
          body: body ? JSON.stringify(body) : undefined,
        }
      );
      return {
        status: res.status,
        body: await res.json(),
        cache: res.headers.get('cache-control'),
      };
    } catch (error) {
      throw new Error('设备扫码隔离请求失败', { cause: error });
    }
  }

  beforeAll(async () => {
    if (
      !/^apple_order_mgr_pickup_devices_test_\d+$/.test(process.env.DB_NAME || '') ||
      process.env.DATABASE_URL
    ) {
      throw new Error('仅允许设备扫码隔离测试库');
    }
    models = require('../src/models');
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const role = req.headers['x-test-role'];
      req.user = {
        id: user.id,
        username: user.username,
        nickname: '扫码合成员工',
        role: role === 'admin' ? 'admin' : 'pickupStaff',
        orderAccess: { mode: 'tags', tags: ['SCAN-IN'] },
        permissions:
          role === 'denied'
            ? []
            : role === 'read'
              ? ['pickups.read']
              : role === 'editOnly'
                ? ['pickups.edit']
                : ['pickups.read', 'pickups.edit', 'orders.read'],
      };
      next();
    });
    app.use('/orders', require('../src/routes/orders'));
    app.use('/pickups', require('../src/routes/pickups'));
    app.use(require('../src/middleware/errorHandler'));
    await new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(async () => {
    await models.sequelize.query(
      'TRUNCATE pickup_devices, pickup_record_events, pickup_evidence, pickup_records, orders, users RESTART IDENTITY CASCADE'
    );
    user = await models.User.create({
      username: 'scan_test',
      password: 'Synthetic-Scan-Password-1!',
      role: 'pickupStaff',
    });
    orders = await models.Order.bulkCreate([
      {
        orderNumber: 'W9701000672',
        tag: 'SCAN-IN',
        recipientName: '扫码合成甲',
        products: [{ name: '测试手机', quantity: 2 }],
      },
      {
        orderNumber: 'W9702000672',
        tag: 'SCAN-OUT',
        recipientName: '扫码合成乙',
        products: [{ name: '测试手机', quantity: 2 }],
      },
      {
        orderNumber: 'W9703000672',
        tag: 'SCAN-IN',
        recipientName: '扫码合成甲',
        products: [{ name: '测试手机', quantity: 1 }],
      },
    ]);
  });

  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (models) await models.sequelize.close();
  });

  test('仅序列号自动绑定精确订单，重读可见，状态不变且有审计', async () => {
    const res = await request(orders[0].id, 'POST', pair);
    expect(res.status).toBe(201);
    expect(res.body.data.device).toMatchObject({
      orderId: orders[0].id,
      serialNumber: 'TEST000001',
    });
    expect(res.cache).toBe('no-store');
    const read = await request(orders[0].id);
    expect(read.body.data.items).toHaveLength(1);
    expect(read.body.data.items[0]).not.toHaveProperty('serialBarcode');
    expect((await request(orders[2].id)).body.data.items).toEqual([]);
    const record = await models.PickupRecord.findOne({ where: { orderId: orders[0].id } });
    expect(record.status).toBe('pending');
    expect(record.pickedUpAt).toBeNull();
    expect(record.version).toBe(1);
    const event = await models.PickupRecordEvent.findOne();
    expect(event.eventType).toBe('device_added');
    expect(event.actorUserId).toBe(user.id);
    expect(event.changes.device.serialNumber).toBe('TEST000001');
  });

  test('同订单支持多台设备，相同序列号重试幂等', async () => {
    expect((await request(orders[0].id, 'POST', pair)).status).toBe(201);
    const duplicate = await request(orders[0].id, 'POST', { ...pair, serialBarcode: 'TEST000001' });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.data.alreadyBound).toBe(true);
    expect((await request(orders[0].id, 'POST', second)).status).toBe(201);
    expect((await request(orders[0].id)).body.data.items).toHaveLength(2);
    expect(await models.PickupRecordEvent.count()).toBe(2);
  });

  test('姓名和订单尾号相同也不跨订单合并，跨范围冲突不泄露', async () => {
    await request(orders[1].id, 'POST', pair, 'admin');
    const conflict = await request(orders[0].id, 'POST', pair);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('DEVICE_ALREADY_BOUND');
    expect(JSON.stringify(conflict.body)).not.toContain(orders[1].orderNumber);
    expect(await models.PickupRecord.count()).toBe(1);
  });

  test('序列号跨订单冲突拒绝，历史 IMEI 不丢失且不再输出', async () => {
    await request(orders[0].id, 'POST', pair);
    await models.PickupDevice.update(
      { imei: '490154203237518', imeiBarcode: '490154203237518' },
      { where: { orderId: orders[0].id } }
    );
    const retry = await request(orders[0].id, 'POST', pair);
    expect(retry.status).toBe(200);
    expect(retry.body.data.device).not.toHaveProperty('imei');
    expect((await request(orders[2].id, 'POST', pair)).status).toBe(409);
    expect((await models.PickupDevice.findOne()).imei).toBe('490154203237518');
    expect(await models.PickupRecordEvent.count()).toBe(1);
  });

  test('订单序列号批量展示、模糊搜索、分页和 TAG 范围', async () => {
    await request(orders[0].id, 'POST', pair);
    await request(orders[0].id, 'POST', second);
    await request(orders[1].id, 'POST', { serialBarcode: 'HIDDEN0001' }, 'admin');
    const search = async keyword => {
      try {
        const res = await fetch(
          `${baseUrl}/orders?keyword=${encodeURIComponent(keyword)}&limit=1`,
          { headers: { 'x-test-role': 'staff' } }
        );
        expect(res.status).toBe(200);
        return (await res.json()).data;
      } catch (error) {
        throw new Error('序列号订单搜索失败', { cause: error });
      }
    };
    for (const keyword of ['TEST000001', 'test00000', '000002']) {
      const data = await search(keyword);
      expect(data.total).toBe(1);
      expect(data.orders).toHaveLength(1);
      expect(data.orders[0].id).toBe(orders[0].id);
      expect(data.orders[0].serial_numbers).toEqual(['TEST000001', 'TEST000002']);
    }
    expect((await search('HIDDEN0001')).total).toBe(0);
    expect((await search("' OR 1=1 --")).total).toBe(0);
    expect((await search(orders[2].orderNumber)).orders[0].serial_numbers).toEqual([]);
    expect(
      (await models.PickupDevice.findOne({ where: { orderId: orders[0].id } })).imei
    ).toBeNull();
  });

  test('读写均限制 TAG，功能权限独立校验', async () => {
    expect((await request(orders[1].id)).status).toBe(404);
    expect((await request(orders[1].id, 'POST', pair)).status).toBe(404);
    expect((await request(orders[0].id, 'POST', pair, 'read')).status).toBe(403);
    expect((await request(orders[0].id, 'POST', pair, 'editOnly')).status).toBe(403);
    expect((await request(orders[0].id, 'GET', undefined, 'denied')).status).toBe(403);
    expect((await request(orders[0].id, 'GET', undefined, 'read')).status).toBe(200);
    expect(await models.PickupDevice.count()).toBe(0);
  });

  test('非法输入和不完整号码不能入库', async () => {
    for (const body of [
      {},
      { serialBarcode: '195951411859' },
      { serialBarcode: '' },
      { ...pair, serialBarcode: ['TEST000001'] },
    ]) {
      expect((await request(orders[0].id, 'POST', body)).status).toBe(400);
    }
    expect((await request('1.5', 'POST', pair)).status).toBe(400);
    expect(await models.PickupRecord.count()).toBe(0);
  });

  test('同订单并发重试只创建一台设备和一条审计', async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () => request(orders[0].id, 'POST', pair))
    );
    expect(results.map(res => res.status).sort()).toEqual([200, 200, 200, 201]);
    expect(await models.PickupDevice.count()).toBe(1);
    expect(await models.PickupRecordEvent.count()).toBe(1);
  });

  test('不同订单并发竞争同一设备，全局唯一约束兜底', async () => {
    const results = await Promise.all([
      request(orders[0].id, 'POST', pair),
      request(orders[2].id, 'POST', pair),
    ]);
    expect(results.map(res => res.status).sort()).toEqual([201, 409]);
    expect(await models.PickupDevice.count()).toBe(1);
    expect(await models.PickupRecord.count()).toBe(1);
    expect(await models.PickupRecordEvent.count()).toBe(1);
  });

  test('审计写入失败时设备和取货记录一起回滚', async () => {
    const spy = jest
      .spyOn(models.PickupRecordEvent, 'create')
      .mockRejectedValueOnce(new Error('synthetic audit failure'));
    try {
      expect((await request(orders[0].id, 'POST', pair)).status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(await models.PickupDevice.count()).toBe(0);
    expect(await models.PickupRecord.count()).toBe(0);
  });

  test('解除绑定权限、事务回滚、重复重试和重新绑定隔离', async () => {
    const first = await request(orders[0].id, 'POST', pair);
    const id = first.body.data.device.id;
    expect((await request(orders[0].id, 'DELETE', undefined, 'read', id)).status).toBe(403);
    expect((await request(orders[1].id, 'DELETE', undefined, 'staff', id)).status).toBe(404);
    expect((await request(orders[2].id, 'DELETE', undefined, 'staff', id)).body.data.removed).toBe(
      false
    );
    const spy = jest
      .spyOn(models.PickupRecordEvent, 'create')
      .mockRejectedValueOnce(new Error('synthetic audit failure'));
    try {
      expect((await request(orders[0].id, 'DELETE', undefined, 'staff', id)).status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(await models.PickupDevice.count()).toBe(1);
    expect((await models.PickupRecord.findOne()).version).toBe(1);
    expect((await request(orders[0].id, 'DELETE', undefined, 'staff', id)).body.data.removed).toBe(
      true
    );
    expect((await request(orders[0].id, 'DELETE', undefined, 'staff', id)).body.data.removed).toBe(
      false
    );
    expect(await models.PickupDevice.count()).toBe(0);
    const event = await models.PickupRecordEvent.findOne({
      where: { eventType: 'device_removed' },
    });
    expect(event.changes.device.serialNumber).toBe('TEST000001');
    expect(event.actorUserId).toBe(user.id);
    const record = await models.PickupRecord.findOne();
    expect(record.status).toBe('pending');
    expect(record.version).toBe(2);
    const rebound = await request(orders[2].id, 'POST', pair);
    expect(rebound.status).toBe(201);
    expect(rebound.body.data.device.id).not.toBe(id);
    await request(orders[0].id, 'DELETE', undefined, 'staff', id);
    expect(await models.PickupDevice.count()).toBe(1);
    expect(await models.PickupRecordEvent.count({ where: { eventType: 'device_removed' } })).toBe(
      1
    );
  });

  test('已取货和结款记录保持原值，扫码仅增加版本和历史', async () => {
    const time = new Date('2026-09-23T01:00:00Z');
    await models.PickupRecord.create({
      orderId: orders[0].id,
      status: 'picked_up',
      pickedUpAt: time,
      settlementAmount: 88,
      notes: '保留备注',
      version: 3,
    });
    expect((await request(orders[0].id, 'POST', pair)).status).toBe(201);
    const record = await models.PickupRecord.findOne();
    expect(record.status).toBe('picked_up');
    expect(record.pickedUpAt).toEqual(time);
    expect(Number(record.settlementAmount)).toBe(88);
    expect(record.notes).toBe('保留备注');
    expect(record.version).toBe(4);
  });
  test('OCR 月度预占并发下不越过上限，失败预算不重置', async () => {
    await models.sequelize.query('TRUNCATE ocr_monthly_usage');
    const { reserveQuota } = require('../src/services/pickupOcrService');
    const previous = process.env.PICKUP_OCR_MONTHLY_LIMIT;
    process.env.PICKUP_OCR_MONTHLY_LIMIT = '3';
    try {
      const results = await Promise.allSettled(Array.from({ length: 12 }, () => reserveQuota()));
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(3);
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(9);
      const [rows] = await models.sequelize.query('SELECT used FROM ocr_monthly_usage');
      expect(rows[0].used).toBe(3);
      await expect(reserveQuota()).rejects.toMatchObject({ code: 'OCR_MONTHLY_LIMIT' });
    } finally {
      if (previous === undefined) delete process.env.PICKUP_OCR_MONTHLY_LIMIT;
      else process.env.PICKUP_OCR_MONTHLY_LIMIT = previous;
    }
  });
});
