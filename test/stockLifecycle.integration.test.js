/* eslint-disable no-magic-numbers, camelcase -- 隔离合成库覆盖生命周期、队列与真实事务。 */
const crypto = require('crypto');
const enabled = process.env.RUN_STOCK_INTEGRATION === 'true';
if (
  enabled &&
  (process.env.DB_NAME !== 'apple_order_mgr_stock_test_1007' ||
    process.env.DB_NAME_TEST !== process.env.DB_NAME ||
    process.env.DATABASE_URL)
)
  throw new Error('仅允许独立库存合成库');
(enabled ? describe : describe.skip)('库存生命周期真实数据库', () => {
  const db = require('../src/models');
  const cmd = require('../src/services/stockCommandService');
  const service = require('../src/services/stockLifecycleService');
  const ledger = require('../src/services/stockLedgerService');
  const projection = require('../src/services/stockLedgerProjectionService');
  const queue = require('../src/services/officialOrderRefreshService');
  const { scheduleReturns } = require('../src/services/stockReturnScheduler');
  const prefix = crypto.randomBytes(3).toString('hex').toUpperCase();
  let admin,
    limited,
    warehouse,
    product,
    seq = 0;
  const serial = () => `Z${prefix}${String(++seq).padStart(3, '0')}`;
  const run = async (method, input, id, user = admin) => {
    try {
      return await cmd.runCommand(
        user,
        { requestKey: crypto.randomUUID(), ...input },
        `lifecycle.test.${method}`,
        [],
        ctx => service[method](ctx, id, input)
      );
    } catch (error) {
      error.component = 'stockLifecycleTest';
      throw error;
    }
  };
  const observe = async (order, items, error = null) => {
    try {
      return await db.sequelize.transaction(async transaction => {
        await cmd.lockStock(transaction);
        await service.observe(
          transaction,
          order.id,
          error ? null : { items, observedAt: new Date().toISOString() },
          error
        );
      });
    } catch (error) {
      error.component = 'stockLifecycleTest';
      throw error;
    }
  };
  const fixture = async ({ states = ['registered', 'registered'], picked = true } = {}) => {
    try {
      const order = await db.Order.create({
        orderNumber: `W${String(7000000000 + Math.floor(Math.random() * 999999999))}`,
        status: picked ? 'picked_up' : 'processing',
        actualPickupDate: picked ? '2020-01-01' : null,
        appleId: `test${prefix}${seq}@example.test`,
        products: [{ name: '合成设备', quantity: states.length }],
      });
      const units = [];
      for (const state of states) {
        const unit = await db.StockUnit.create({
          serialNumber: serial(),
          state,
          originMode: 'legacy_binding',
          productId: product.id,
          locationId: state === 'in_stock' ? warehouse.id : null,
          firstReceivedAt: state === 'in_stock' ? new Date('2026-10-01') : null,
        });
        await db.PickupDevice.create({
          orderId: order.id,
          stockUnitId: unit.id,
          serialNumber: unit.serialNumber,
          serialBarcode: unit.serialNumber,
          scannedBy: admin.id,
        });
        units.push(unit);
      }
      return { order, units };
    } catch (error) {
      error.component = 'stockLifecycleTest';
      throw error;
    }
  };
  const item = (quantity = 1, serialNumbers = [], rawStatus = 'RETURN_STARTED') => ({
    key: 'item1',
    name: '合成设备',
    quantity,
    serialNumbers,
    rawStatus,
  });
  beforeAll(async () => {
    try {
      admin = await db.User.create({
        username: `life_${prefix}`,
        password: crypto.randomUUID(),
        role: 'admin',
      });
      limited = await db.User.create({
        username: `life_limit_${prefix}`,
        password: crypto.randomUUID(),
        role: 'operator',
        orderAccess: { mode: 'tags', tags: ['not-allowed'] },
      });
      await db.UserPermission.bulkCreate(
        ['stock.read', 'stock.receive', 'stock.correct', 'orders.read'].map(permissionCode => ({
          userId: limited.id,
          permissionCode,
        }))
      );
      warehouse = await db.StockLocation.create({
        name: `生命周期仓${prefix}`,
        kind: 'warehouse',
        city: '测试',
      });
      product = await db.StockProduct.create({
        modelKey: `life_${prefix}`,
        modelName: `生命周期机型${prefix}`,
        storageGb: 512,
        colorKey: 'blue',
        colorName: '蓝色',
      });
      await db.StockSetting.update({ enabled: true }, { where: { id: 1 } });
    } catch (error) {
      error.component = 'stockLifecycleTest';
      throw error;
    }
  });
  afterAll(async () => {
    try {
      await db.sequelize.close();
    } catch (error) {
      error.component = 'stockLifecycleTest';
      throw error;
    }
  });
  test('历史已取货关联SN自动进入未入库；明确人工取货登记同样生效', async () => {
    const { order, units } = await fixture({ picked: false });
    const ctx = await cmd.createReadContext(admin);
    expect(
      await projection.byIds(
        ctx,
        units.map(u => u.id)
      )
    ).toHaveLength(0);
    await db.PickupRecord.create({
      orderId: order.id,
      status: 'picked_up',
      notes: '现场照片确认取货',
      lastUpdatedBy: admin.id,
    });
    expect(
      await projection.byIds(
        ctx,
        units.map(u => u.id)
      )
    ).toHaveLength(2);
    const list = await projection.list(ctx, { view: 'registered', q: units[0].serialNumber });
    expect(list.total).toBe(1);
    expect(list.counts.pending).toBe(1);
  });
  test('订单两台只退明确的一台，原仓与另一台在库状态保留', async () => {
    const { order, units } = await fixture({ states: ['in_stock', 'in_stock'] });
    await observe(order, [
      item(1, [units[0].serialNumber]),
      { ...item(1, [units[1].serialNumber], 'PICKED_UP'), key: 'item2' },
    ]);
    await units[0].reload();
    await units[1].reload();
    expect(units[0]).toMatchObject({
      state: 'returned',
      returnLocationId: warehouse.id,
      locationId: null,
    });
    expect(units[1].state).toBe('in_stock');
    const row = await projection.detail(await cmd.createReadContext(admin), units[0].id);
    expect(row.warehouse.id).toBe(warehouse.id);
    await expect(
      cmd.runCommand(admin, { requestKey: crypto.randomUUID() }, 'test.receive', [], ctx =>
        ledger.receiveUnits(ctx, { units: [{ serialNumber: units[0].serialNumber }] })
      )
    ).rejects.toThrow('退货');
  });
  test('只有数量时不改状态，人工选一台后排除另一台；重复请求幂等', async () => {
    const { order, units } = await fixture();
    await observe(order, [item()]);
    await units[0].reload();
    expect(units[0].state).toBe('registered');
    expect(units[0].lifecycleIssue).toBe('return_pending');
    const check = await service.returnReview(await cmd.createReadContext(admin), order.id);
    const payload = {
      requestKey: crypto.randomUUID(),
      fingerprint: check.fingerprint,
      serialNumbers: [units[0].serialNumber],
      reason: '人工核对盒标与退货凭证',
    };
    const execute = () =>
      cmd.runCommand(admin, payload, 'lifecycle.confirm', [], ctx =>
        service.confirmReturns(ctx, order.id, payload)
      );
    await execute();
    expect((await execute()).idempotent).toBe(true);
    await units[0].reload();
    await units[1].reload();
    expect(units[0].state).toBe('returned');
    expect(units[1].lifecycleIssue).toBeNull();
    expect(units[1].state).toBe('registered');
    await observe(order, [item()]);
    await units[1].reload();
    expect(units[1].lifecycleIssue).toBeNull();
    await expect(
      run(
        'confirmReturns',
        { ...payload, requestKey: crypto.randomUUID(), fingerprint: 'outdated' },
        order.id
      )
    ).rejects.toThrow('变化');
  });
  test('已售退货冲突不撤销销售资金；核实保留后相同观测不重复报警', async () => {
    const { order, units } = await fixture({ states: ['sold'] });
    await observe(order, [item(1, [units[0].serialNumber])]);
    await units[0].reload();
    expect(units[0]).toMatchObject({ state: 'sold', lifecycleIssue: 'sold_return_conflict' });
    await run(
      'resolveReturn',
      {
        expectedVersion: units[0].version,
        resolution: 'keep_sold',
        reason: '核对发货证据保留已售',
      },
      units[0].id
    );
    await observe(order, [item(1, [units[0].serialNumber])]);
    await units[0].reload();
    expect(units[0]).toMatchObject({ state: 'sold', lifecycleIssue: null });
    await observe(order, [item(1, [units[0].serialNumber], 'PICKED_UP')]);
    await observe(order, [item(1, [units[0].serialNumber])]);
    await units[0].reload();
    expect(units[0].lifecycleIssue).toBe('sold_return_conflict');
  });
  test('退货撤销只提示，人工恢复及过期版本保护', async () => {
    const { order, units } = await fixture({ states: ['in_stock'] });
    await observe(order, [item(1, [units[0].serialNumber])]);
    await observe(order, [item(1, [units[0].serialNumber], 'PICKED_UP')]);
    await units[0].reload();
    expect(units[0]).toMatchObject({ state: 'returned', lifecycleIssue: 'return_withdrawn' });
    await expect(
      run(
        'resolveReturn',
        { expectedVersion: 0, resolution: 'restore_previous', reason: '确认撤销' },
        units[0].id
      )
    ).rejects.toThrow('已更新');
    await run(
      'resolveReturn',
      {
        expectedVersion: units[0].version,
        resolution: 'restore_previous',
        reason: '确认设备仍在原仓',
      },
      units[0].id
    );
    await units[0].reload();
    expect(units[0]).toMatchObject({
      state: 'in_stock',
      locationId: warehouse.id,
      returnedAt: null,
    });
  });
  test('官网失败保留原状态和上次成功时间；跨订单SN或重复SN不误退', async () => {
    const { order, units } = await fixture();
    await observe(order, [item(1, ['Q123456789'])]);
    await units[0].reload();
    expect(units[0].state).toBe('registered');
    const before = await service.checkForOrder(order.id);
    await observe(order, [], 'HTTP_541');
    const after = await service.checkForOrder(order.id);
    expect(after.observed_at).toEqual(before.observed_at);
    expect(after.error_code).toBe('HTTP_541');
    await observe(order, [
      item(1, [units[0].serialNumber]),
      { ...item(1, [units[0].serialNumber], 'PICKED_UP'), key: 'item2' },
    ]);
    await units[0].reload();
    expect(units[0].state).toBe('registered');
  });
  test('退货人工确认执行订单范围权限，数量冲突整体拒绝', async () => {
    const { order, units } = await fixture();
    await observe(order, [item()]);
    const check = await service.returnReview(await cmd.createReadContext(admin), order.id);
    await expect(
      run(
        'confirmReturns',
        {
          fingerprint: check.fingerprint,
          serialNumbers: units.map(u => u.serialNumber),
          reason: '测试',
        },
        order.id
      )
    ).rejects.toThrow('数量');
    await expect(
      service.returnReview(await cmd.createReadContext(limited), order.id)
    ).rejects.toThrow('不可访问');
    await expect(
      run(
        'confirmReturns',
        { fingerprint: check.fingerprint, serialNumbers: [units[0].serialNumber], reason: '测试' },
        order.id,
        limited
      )
    ).rejects.toThrow('不可访问');
  });
  test('统计全量、不受分页限制，多状态和未分配仓库正确；缺规格不漏计', async () => {
    const { units } = await fixture();
    await units[0].update({ productId: null });
    const ctx = await cmd.createReadContext(admin);
    const result = await projection.list(
      ctx,
      { q: units[0].serialNumber, states: '["registered"]', warehouseIds: '["unassigned"]' },
      true
    );
    expect(result.total).toBe(1);
    expect(result.items[0].modelName).toBe('机型待补');
    const scoped = await projection.list(
      ctx,
      { productId: product.id, states: '["registered","returned"]' },
      true
    );
    expect(scoped.total).toBe(scoped.items.reduce((n, row) => n + row.count, 0));
    await expect(projection.list(ctx, { states: '["invalid"]' }, true)).rejects.toThrow();
  });
  test('全历史调度每订单一次，30分钟内不重排队，暂停任务保留且系统身份领取回写', async () => {
    const { order, units } = await fixture();
    // 本测试只处理合成库，先结束历史合成任务，固定领取目标。
    await db.sequelize.query(
      "UPDATE official_order_refresh_jobs SET state='cancelled' WHERE state IN ('queued','running')"
    );
    await db.sequelize.transaction(async transaction => {
      await db.sequelize.query('SELECT pg_advisory_xact_lock(26100371)', { transaction });
      await scheduleReturns(transaction);
    });
    const [jobs] = await db.sequelize.query(
      'SELECT j.*,b.purpose,b.requested_by FROM official_order_refresh_jobs j JOIN official_order_refresh_batches b ON b.id=j.batch_id WHERE j.order_id=:id',
      { replacements: { id: order.id } }
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].purpose).toBe('stock_returns');
    expect(jobs[0].requested_by).toBeNull();
    await db.sequelize.query(
      "UPDATE official_order_refresh_jobs SET state='cancelled' WHERE order_id<>:id AND state IN ('queued','running')",
      { replacements: { id: order.id } }
    );
    const job = await queue.claimHttp();
    expect(job.orderId).toBe(order.id);
    const result = await queue.finish({
      id: job.id,
      leaseToken: job.leaseToken,
      outcome: 'SUCCEEDED',
      transport: 'http',
      result: {
        systemOrderId: order.id,
        orderNumber: order.orderNumber,
        identityMatched: true,
        sourceModel: 'orderDetail',
        completeItemCount: 1,
        products: [item(1, [units[0].serialNumber])],
        source: {
          provider: 'Apple official website',
          status: 200,
          cached: false,
          host: 'secure.www.apple.com.cn',
          sha256: 'a'.repeat(64),
          runId: 1,
          observedAt: new Date().toISOString(),
        },
      },
    });
    expect(result.state).toBe('succeeded');
    await units[0].reload();
    expect(units[0].state).toBe('returned');
    const count = await db.sequelize.transaction(transaction => scheduleReturns(transaction));
    expect(count).toBe(0);
  });
  test('实际销售及已代收资金在官网退货冲突后完整保留', async () => {
    const { order, units } = await fixture({ states: ['in_stock'] });
    await cmd.runCommand(
      admin,
      { requestKey: crypto.randomUUID() },
      'lifecycle.fixture.sale',
      [],
      ctx =>
        ledger.sellUnits(ctx, {
          units: [
            {
              id: units[0].id,
              expectedVersion: units[0].version,
              saleAmount: '10000.00',
              settlementAmount: '9900.00',
            },
          ],
          salespersonName: '生命周期销售',
          handlerName: '生命周期交货',
          soldOn: '2026-10-09',
          payment: {
            status: 'agent_pending',
            collectorName: '生命周期代收',
            collectedOn: '2026-10-09',
          },
        })
    );
    const ctx = await cmd.createReadContext(admin);
    const before = await projection.detail(ctx, units[0].id);
    await observe(order, [item(1, [units[0].serialNumber])]);
    const after = await projection.detail(ctx, units[0].id);
    for (const key of [
      'saleId',
      'saleAmount',
      'settlementAmount',
      'paymentStatus',
      'collectorName',
      'collectedOn',
    ])
      expect(after[key]).toEqual(before[key]);
    expect(after.state).toBe('sold');
    expect(after.lifecycleIssue).toBe('sold_return_conflict');
  });
  test('官网单一取货依据转退货后仍保留历史监控资格，部分退货待确认不漏设备', async () => {
    const { order, units } = await fixture({ picked: false });
    await order.update({ officialRawStatus: 'PICKED_UP' });
    await db.sequelize.transaction(async transaction => {
      await cmd.lockStock(transaction);
      await order.update({ officialRawStatus: 'RETURN_STARTED' }, { transaction });
      await service.observe(
        transaction,
        order.id,
        { items: [item()], observedAt: new Date().toISOString() },
        null,
        'PICKED_UP'
      );
    });
    expect(
      await projection.byIds(
        await cmd.createReadContext(admin),
        units.map(u => u.id)
      )
    ).toHaveLength(2);
    expect((await service.checkForOrder(order.id)).pickup_verified).toBe(true);
  });
  test('统计超过一页仍完整计数；重复和并发退货确认均保持SN互斥', async () => {
    const { order, units } = await fixture({ states: Array(25).fill('registered') });
    const ctx = await cmd.createReadContext(admin);
    const filters = { productId: product.id, view: 'all', states: '["registered","returned"]' };
    const list = await projection.list(ctx, filters);
    const stats = await projection.list(ctx, filters, true);
    expect(list.items.length).toBe(20);
    expect(stats.total).toBe(list.total);
    expect(stats.total).toBeGreaterThan(20);
    await observe(order, [item()]);
    const check = await service.returnReview(await cmd.createReadContext(admin), order.id);
    const values = {
      fingerprint: check.fingerprint,
      serialNumbers: [units[0].serialNumber],
      reason: '合成并发确认',
    };
    const concurrent = await Promise.allSettled([
      run('confirmReturns', values, order.id),
      run('confirmReturns', { ...values, serialNumbers: [units[1].serialNumber] }, order.id),
    ]);
    expect(concurrent.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.filter(result => result.status === 'rejected')).toHaveLength(1);
    const count = await db.StockUnit.count({
      where: { id: units.map(u => u.id), state: 'returned' },
    });
    expect(count).toBe(1);
  });
  test('暂停自动批次不会被重排，模块关闭只保存观测不改变库存', async () => {
    const { order, units } = await fixture();
    await db.sequelize.transaction(transaction => scheduleReturns(transaction));
    const [jobs] = await db.sequelize.query(
      'SELECT id,batch_id FROM official_order_refresh_jobs WHERE order_id=:id',
      { replacements: { id: order.id } }
    );
    expect(jobs).toHaveLength(1);
    await db.sequelize.query(
      "UPDATE official_order_refresh_batches SET paused_at=now(),pause_reason='HTTP_541' WHERE id=:id",
      { replacements: { id: jobs[0].batch_id } }
    );
    await db.sequelize.query(
      "UPDATE stock_order_checks SET last_enqueued_at=now()-interval '1 hour' WHERE order_id=:id",
      { replacements: { id: order.id } }
    );
    await db.sequelize.transaction(transaction => scheduleReturns(transaction));
    const [again] = await db.sequelize.query(
      'SELECT id FROM official_order_refresh_jobs WHERE order_id=:id',
      { replacements: { id: order.id } }
    );
    expect(again).toHaveLength(1);
    const recent = await queue.listBatches(admin);
    expect(
      recent.some(batch => batch.id === jobs[0].batch_id && batch.purpose === 'stock_returns')
    ).toBe(true);
    await db.StockSetting.update({ enabled: false }, { where: { id: 1 } });
    try {
      await observe(order, [item(1, [units[0].serialNumber])]);
      await units[0].reload();
      expect(units[0].state).toBe('registered');
      expect(await db.sequelize.transaction(transaction => scheduleReturns(transaction))).toBe(0);
    } finally {
      await db.StockSetting.update({ enabled: true }, { where: { id: 1 } });
    }
  });
  test('有退货与观测事实后迁移down拒绝删除', async () => {
    const migration = require('../migrations/20261010000001-stock-lifecycle');
    await expect(migration.down(db.sequelize.getQueryInterface())).rejects.toThrow('回退被拒绝');
  });
});
