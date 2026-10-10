/* eslint-disable no-magic-numbers -- 独立隔离库与合成退货业务边界。 */
const enabled = process.env.RUN_OFFICIAL_RETURN_INTEGRATION === 'true';
(enabled ? describe : describe.skip)('官网负数量真实队列事务独立验收', () => {
  let db, service, admin, order;
  const crypto = require('crypto');
  const { parseOfficialOrderDetail } = require('../src/services/officialOrderParser');
  const { buildLifecycleJson } = require('./fixtures/officialOrderLifecycle');
  const query = async (sql, replacements = {}) => {
    try {
      return (await db.sequelize.query(sql, { replacements }))[0];
    } catch (error) {
      error.component = 'independentReturnQuantity';
      throw error;
    }
  };
  const orderHash = async () => {
    try {
      return (
        await query(
          "SELECT md5((to_jsonb(o)-ARRAY['official_raw_status','official_status_observed_at'])::text) AS hash FROM orders o WHERE id=:id",
          { id: order.id }
        )
      )[0].hash;
    } catch (error) {
      error.component = 'independentReturnProtection';
      throw error;
    }
  };
  const business = async () => {
    try {
      const output = {};
      for (const table of [
        'payment_tasks',
        'payment_task_events',
        'pickup_records',
        'pickup_devices',
        'order_mail_events',
        'order_mail_messages',
      ]) {
        output[table] = (
          await query(
            `SELECT count(*)::int AS count,md5(COALESCE(string_agg(to_jsonb(t)::text,',' ORDER BY id),'')) AS hash FROM ${table} t`
          )
        )[0];
      }
      return output;
    } catch (error) {
      error.component = 'independentReturnBusinessProtection';
      throw error;
    }
  };
  beforeAll(async () => {
    try {
      if (process.env.DB_NAME !== 'apple_official_test_20261010' || process.env.DATABASE_URL)
        throw new Error('仅允许独立合成测试库');
      db = require('../src/models');
      service = require('../src/services/officialOrderRefreshService');
      await query('TRUNCATE orders,official_order_refresh_batches,users RESTART IDENTITY CASCADE');
      admin = await db.User.create({
        username: 'return_quantity_independent',
        password: crypto.randomUUID(),
        role: 'admin',
        status: 'active',
      });
      order = await db.Order.create({
        orderNumber: 'W1234567890',
        appleId: 'return-independent@example.test',
        products: [{ name: '合成设备', quantity: 2 }],
        emailOrderStatus: 'return_requested',
        emailStatusVersion: 15,
        emailStatusNeedsReview: true,
        emailStatusReviewReasons: ['UNKNOWN_LIFECYCLE_TEMPLATE'],
        actualPickupDate: '2026-09-25',
        notes: '人工备注保持',
        officialRawStatus: 'PICKED_UP',
      });
      await db.StockSetting.upsert({ id: 1, enabled: true });
    } catch (error) {
      error.component = 'independentReturnSetup';
      throw error;
    }
  });
  afterAll(async () => {
    try {
      if (db) await db.sequelize.close();
    } catch (error) {
      error.component = 'independentReturnCleanup';
      throw error;
    }
  });
  const finish = async () => {
    try {
      await service.claimHttp();
      await service.enqueue(admin, {
        selection: 'ids',
        requestKey: crypto.randomUUID(),
        orderIds: [order.id],
      });
      const job = await service.claimHttp();
      expect(job.orderId).toBe(order.id);
      const value = buildLifecycleJson('RETURN_STARTED');
      const key = value.orderDetail.orderItems.c[0];
      value.orderDetail.orderItems[key].orderItemDetails.d.quantity = -1;
      value.orderDetail.orderItems[key].orderItemDetails.d.serialNumbers = ['Z123456789'];
      const parsed = parseOfficialOrderDetail(JSON.stringify(value), order.orderNumber);
      return service.finish({
        ...job,
        outcome: 'SUCCEEDED',
        transport: 'http',
        result: {
          ...parsed,
          systemOrderId: order.id,
          source: {
            provider: 'Apple official website',
            host: 'secure6.www.apple.com.cn',
            status: 200,
            cached: false,
            runId: 1,
            sha256: 'd'.repeat(64),
            observedAt: new Date().toISOString(),
          },
        },
      });
    } catch (error) {
      error.component = 'independentReturnFinish';
      throw error;
    }
  };
  test('未绑定设备：仅改官网两列，保留邮件人工状态/日期/付款等业务', async () => {
    try {
      const before = await orderHash();
      const tables = await business();
      const stocks = (
        await query(
          "SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,',' ORDER BY id),'')) AS hash FROM stock_units t"
        )
      )[0];
      expect(await finish()).toMatchObject({ state: 'succeeded', errorCode: null });
      await order.reload();
      expect(order.officialRawStatus).toBe('RETURN_STARTED');
      expect(order.emailOrderStatus).toBe('return_requested');
      expect(order.emailStatusVersion).toBe(15);
      expect(await orderHash()).toBe(before);
      expect(await business()).toEqual(tables);
      expect(
        (
          await query(
            "SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,',' ORDER BY id),'')) AS hash FROM stock_units t"
          )
        )[0]
      ).toEqual(stocks);
    } catch (error) {
      error.component = 'independentReturnUnbound';
      throw error;
    }
  });
  test('绑定设备：兼容负数附带SN仍只待确认，不自动退库', async () => {
    try {
      const warehouse = await db.StockLocation.create({
        name: `独立退货测试仓${crypto.randomUUID().slice(0, 8)}`,
        kind: 'warehouse',
        city: '合成',
      });
      const product = await db.StockProduct.create({
        modelKey: crypto.randomUUID(),
        modelName: '独立合成机型',
        storageGb: 512,
        colorKey: 'blue',
        colorName: '蓝色',
      });
      const unit = await db.StockUnit.create({
        productId: product.id,
        serialNumber: 'Z123456789',
        state: 'in_stock',
        locationId: warehouse.id,
        firstReceivedAt: new Date('2026-09-25'),
        originMode: 'legacy_binding',
      });
      await db.PickupDevice.create({
        orderId: order.id,
        stockUnitId: unit.id,
        serialNumber: unit.serialNumber,
        serialBarcode: unit.serialNumber,
        scannedBy: admin.id,
      });
      const before = await orderHash();
      const tables = await business();
      const stockBefore = (
        await query(
          `SELECT md5((to_jsonb(u)-ARRAY[
          'lifecycle_issue','version','updated_by','updated_at'])::text) AS hash
         FROM stock_units u WHERE id=:id`,
          { id: unit.id }
        )
      )[0].hash;
      expect(await finish()).toMatchObject({ state: 'succeeded' });
      await unit.reload();
      expect(unit.state).toBe('in_stock');
      expect(unit.locationId).toBe(warehouse.id);
      expect(unit.returnedAt).toBeNull();
      expect(unit.lifecycleIssue).toBe('return_pending');
      expect(
        (
          await query(
            `SELECT md5((to_jsonb(u)-ARRAY[
          'lifecycle_issue','version','updated_by','updated_at'])::text) AS hash
         FROM stock_units u WHERE id=:id`,
            { id: unit.id }
          )
        )[0].hash
      ).toBe(stockBefore);
      expect(await orderHash()).toBe(before);
      expect(await business()).toEqual(tables);
      const checks = await query('SELECT items FROM stock_order_checks WHERE order_id=:id', {
        id: order.id,
      });
      expect(checks[0].items[0]).toMatchObject({
        rawQuantity: -1,
        quantityInterpretation: 'return_started_negative_one',
        serialNumbers: [],
      });
    } catch (error) {
      error.component = 'independentReturnBound';
      throw error;
    }
  });
});
