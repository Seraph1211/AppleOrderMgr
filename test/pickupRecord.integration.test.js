const run = process.env.RUN_PICKUP_INTEGRATION === 'true';
const suite = run ? describe : describe.skip;

suite('取货记录数据库与 TAG 范围', () => {
  let models;
  let controller;
  let user;
  let visibleOrder;
  let hiddenOrder;
  let server;
  let baseUrl;

  async function request(path, query = {}, role = 'staff') {
    try {
      return await fetch(`${baseUrl}${path}?${new URLSearchParams(query)}`, {
        headers: { 'x-test-role': role },
      });
    } catch (error) {
      throw new Error('隔离验收请求失败', { cause: error });
    }
  }

  function response() {
    return {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    };
  }

  beforeAll(async () => {
    if (
      !/^apple_order_mgr_pickup_test_\d+$/.test(process.env.DB_NAME || '') ||
      process.env.DATABASE_URL
    ) {
      throw new Error('只允许明确的取货记录隔离测试库');
    }
    models = require('../src/models');
    controller = require('../src/controllers/pickupController');
    await models.sequelize.query(
      'TRUNCATE pickup_record_events, pickup_evidence, pickup_records, users, orders RESTART IDENTITY CASCADE'
    );
    user = await models.User.create({
      username: 'pickup_staff_test',
      password: 'Synthetic-Pickup-Password-1!',
      role: 'pickupStaff',
      orderAccess: { mode: 'tags', tags: ['TAG-INTERNAL'] },
    });
    const express = require('express');
    const app = express();
    app.use((req, _res, next) => {
      req.user = {
        id: user.id,
        role: req.headers['x-test-role'] === 'admin' ? 'admin' : 'pickupStaff',
        orderAccess: user.orderAccess,
        permissions:
          req.headers['x-test-role'] === 'denied'
            ? []
            : ['pickups.read', 'pickups.export', 'orders.read', 'orders.export'],
      };
      next();
    });
    app.use('/pickups', require('../src/routes/pickups'));
    app.use('/orders', require('../src/routes/orders'));
    app.use(require('../src/middleware/errorHandler'));
    await new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    [visibleOrder, hiddenOrder] = await models.Order.bulkCreate([
      {
        orderNumber: 'W9700000001',
        tag: 'TAG-INTERNAL',
        recipientName: '合成取机人甲',
        products: [{ name: '合成手机', model: 'TEST-1', quantity: 2 }],
        emailPickupDate: '2026-09-23',
        emailPickupInfo: {
          storeName: '合成门店',
          pickupDate: '2026-09-23',
          startTime: '10:00',
          endTime: '10:15',
        },
      },
      {
        orderNumber: 'W9700000002',
        tag: 'TAG-EXTERNAL',
        recipientName: '合成取机人乙',
        products: [{ name: '合成手机', model: 'TEST-2', quantity: 1 }],
      },
    ]);
  });

  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await models.sequelize.close();
  });

  test('列表和待取货筛选只返回授权订单 TAG', async () => {
    const res = response();
    await controller.list(
      {
        query: { page: '1', pageSize: '20', status: 'pending' },
        user: { id: user.id, role: user.role, orderAccess: user.orderAccess },
      },
      res
    );
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.items.map(item => item.orderId)).toEqual([visibleOrder.id]);
  });

  test('登记已取货自动写时间并追加操作记录', async () => {
    const res = response();
    await controller.update(
      {
        params: { orderId: String(visibleOrder.id) },
        body: {
          status: 'picked_up',
          settlementAmount: '88.50',
          settlementPerson: '测试结款人',
          notes: '',
          expectedVersion: 0,
        },
        user: {
          id: user.id,
          role: user.role,
          username: user.username,
          nickname: '测试员工',
          orderAccess: user.orderAccess,
        },
      },
      res
    );
    expect(res.body.data.status).toBe('picked_up');
    expect(res.body.data.pickedUpAt).toBeTruthy();
    expect(Number(res.body.data.settlementAmount)).toBe(88.5);
    expect(await models.PickupRecordEvent.count({ where: { orderId: visibleOrder.id } })).toBe(1);
  });

  test('越权订单和陈旧版本均被拒绝', async () => {
    await expect(
      controller.update(
        {
          params: { orderId: String(hiddenOrder.id) },
          body: { status: 'picked_up', expectedVersion: 0 },
          user: { id: user.id, role: user.role, orderAccess: user.orderAccess },
        },
        response()
      )
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      controller.update(
        {
          params: { orderId: String(visibleOrder.id) },
          body: { status: 'exception', expectedVersion: 0 },
          user: { id: user.id, role: user.role, orderAccess: user.orderAccess },
        },
        response()
      )
    ).rejects.toMatchObject({ statusCode: 409, code: 'CONCURRENT_MODIFICATION' });
  });

  test('TAG 候选、列表和导出保持范围交集，多选保留逗号及引号', async () => {
    const unusualTag = "TAG, O'Neil";
    const extra = await models.Order.create({
      orderNumber: 'W9700000003',
      tag: unusualTag,
      products: [{ name: '合成手机', quantity: 1 }],
    });
    user.orderAccess = { mode: 'tags', tags: ['TAG-INTERNAL', unusualTag] };
    const options = await request('/pickups/filter-options');
    expect(options.status).toBe(200);
    expect((await options.json()).data.tags.sort()).toEqual(['TAG-INTERNAL', unusualTag].sort());
    const query = {
      tags: JSON.stringify(['TAG-INTERNAL', unusualTag, 'TAG-EXTERNAL']),
      pageSize: 1,
    };
    const first = await (await request('/pickups', query)).json();
    const second = await (await request('/pickups', { ...query, page: 2 })).json();
    expect(first.data.total).toBe(2);
    expect([first.data.items[0].orderId, second.data.items[0].orderId].sort()).toEqual(
      [visibleOrder.id, extra.id].sort()
    );
    const pending = await (await request('/pickups', { ...query, status: 'pending' })).json();
    expect(pending.data.items.map(row => row.orderId)).toEqual([extra.id]);
    const exported = await request('/pickups/export', { ...query, status: 'pending' });
    const XLSX = require('xlsx');
    const workbook = XLSX.read(Buffer.from(await exported.arrayBuffer()), { type: 'buffer' });
    expect(XLSX.utils.sheet_to_json(workbook.Sheets['取货清单']).map(row => row['订单号'])).toEqual(
      [extra.orderNumber]
    );
    expect((await request('/pickups', { tags: JSON.stringify([unusualTag]) })).status).toBe(200);
    const legacy = await (await request('/pickups', { tag: unusualTag })).json();
    expect(legacy.data.total).toBe(1);
  });

  test('功能权限和范围分别生效，非法筛选失败关闭', async () => {
    for (const path of [
      '/pickups',
      '/pickups/filter-options',
      '/pickups/export',
      `/pickups/${visibleOrder.id}/events`,
    ]) {
      expect((await request(path, {}, 'denied')).status).toBe(403);
    }
    expect((await request(`/pickups/${hiddenOrder.id}/events`)).status).toBe(404);
    const none = await (await request('/pickups', { tags: '["TAG-EXTERNAL"]' })).json();
    expect(none.data.total).toBe(0);
    for (const query of [
      { tags: '[' },
      { tags: '{}' },
      { tags: '[null]' },
      { tags: '[" "]' },
      { status: 'invalid' },
      { page: '1.5' },
      { pageSize: '-1' },
    ]) {
      expect((await request('/pickups', query)).status).toBe(400);
    }
    expect((await request('/pickups/export', { status: 'invalid' })).status).toBe(400);
  });

  test('邮件门店真实 SQL、候选、组合多选与导出口径一致', async () => {
    await visibleOrder.update({ pickupStore: '旧字段门店', emailOrderStatus: 'ready_for_pickup' });
    await hiddenOrder.update({ emailPickupInfo: { storeName: '范围外门店' } });
    const other = await models.Order.create({
      orderNumber: 'W9700000004',
      tag: 'TAG-INTERNAL',
      emailOrderStatus: 'processing',
      products: [{ name: '合成手机', quantity: 1 }],
      emailPickupInfo: { storeName: "Apple 测试'门店" },
    });
    const query = {
      pickupStores: JSON.stringify(['合成门店']),
      emailOrderStatuses: '["processing","ready_for_pickup"]',
    };
    const listResponse = await request('/orders', query);
    expect(listResponse.status).toBe(200);
    const listData = (await listResponse.json()).data;
    expect(listData.total).toBe(1);
    expect(listData.orders[0].id).toBe(visibleOrder.id);
    const optionResponse = await request('/orders/filter-options', query);
    expect(optionResponse.status).toBe(200);
    const options = (await optionResponse.json()).data;
    expect(options.stores.sort()).toEqual(['合成门店', "Apple 测试'门店"].sort());
    expect(options.stores).not.toContain('旧字段门店');
    expect(options.stores).not.toContain('范围外门店');
    const multi = await (
      await request('/orders', { ...query, pickupStores: JSON.stringify(options.stores) })
    ).json();
    expect(multi.data.orders.map(row => row.id).sort()).toEqual([visibleOrder.id, other.id].sort());
    const single = await (await request('/orders', { pickupStore: '合成门店' })).json();
    expect(single.data.total).toBe(1);
    const exported = await request('/orders/export', { ...query, fields: '["orderNumber"]' });
    expect(exported.status).toBe(200);
    const XLSX = require('xlsx');
    const workbook = XLSX.read(Buffer.from(await exported.arrayBuffer()), { type: 'buffer' });
    expect(XLSX.utils.sheet_to_json(workbook.Sheets['订单']).map(row => row['官网订单号'])).toEqual(
      [visibleOrder.orderNumber]
    );
  });
});
