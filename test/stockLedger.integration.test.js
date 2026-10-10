/** 简化台账真实 PostgreSQL 回归；只追加带随机前缀的合成资料。 */
const crypto = require('crypto');
const logger = require('../src/utils/logger');

const enabled = process.env.RUN_STOCK_INTEGRATION === 'true';
if (
  enabled &&
  (process.env.DB_NAME !== 'apple_order_mgr_stock_test_1007' ||
    process.env.DB_NAME_TEST !== process.env.DB_NAME ||
    process.env.DATABASE_URL)
)
  throw new Error('简化台账测试仅允许独立合成库1007');

(enabled ? describe : describe.skip)('简化库存台账真实事务', () => {
  const db = require('../src/models');
  const command = require('../src/services/stockCommandService');
  const ledger = enabled ? require('../src/services/stockLedgerService') : null;
  const projection = enabled ? require('../src/services/stockLedgerProjectionService') : null;
  const oldProjection = require('../src/services/stockProjectionService');
  const oldUnits = require('../src/services/stockUnitService');
  const oldSales = require('../src/services/stockSalesService');
  const oldFinance = require('../src/services/stockFinanceService');
  const pickupController = require('../src/controllers/pickupDeviceController');
  const { decryptJson, encrypt } = require('../src/utils/fieldEncryption');
  const prefix = crypto.randomBytes(3).toString('hex').toUpperCase();
  let sequence = 0;
  let admin, limited, product, warehouseA, warehouseB, consignee, outside, settingsBefore;

  const serial = () => `L${prefix}${String(++sequence).padStart(3, '0')}`;
  const newInput = () => ({
    serialNumber: serial(),
    productId: product.id,
    warehouseId: warehouseA.id,
    receivedOn: '2026-10-03',
  });
  const saleInput = units => ({
    units: units.map(unit => ({
      id: unit.id,
      expectedVersion: unit.version,
      saleAmount: '9000.00',
      settlementAmount: '9000.00',
    })),
    salespersonName: `销售${prefix}`,
    handlerName: `出货${prefix}`,
    soldOn: '2026-10-04',
    payment: { status: 'unpaid' },
  });

  async function execute(method, input, actor = admin, id = null) {
    try {
      const payload = { requestKey: crypto.randomUUID(), ...input };
      return await command.runCommand(
        actor,
        payload,
        `ledger.${method}${id ? `.${id}` : ''}`,
        ['stock.read'],
        ctx => (id ? ledger[method](ctx, id, payload) : ledger[method](ctx, payload))
      );
    } catch (error) {
      logger.debug('台账合成验证未完成', { code: error.code || error.name });
      throw error;
    }
  }
  async function detail(id, actor = admin) {
    try {
      return await projection.detail(await command.createReadContext(actor), id);
    } catch (error) {
      logger.debug('台账合成验证未完成', { code: error.code || error.name });
      throw error;
    }
  }
  async function receive(items) {
    try {
      const result = await execute('receiveUnits', { units: items });
      return await db.StockUnit.findAll({
        where: { id: result.ledgerUnitIds },
        order: [['serialNumber', 'ASC']],
      });
    } catch (error) {
      logger.debug('台账合成验证未完成', { code: error.code || error.name });
      throw error;
    }
  }
  async function legacy(method, input) {
    try {
      const service = {
        receiveUnits: oldUnits,
        saveSale: oldSales,
        reserveSale: oldSales,
        pickUnits: oldSales,
        shipSale: oldSales,
        createCollection: oldFinance,
        createReceipt: oldFinance,
      }[method];
      return await command.runCommand(
        admin,
        { requestKey: crypto.randomUUID(), ...input },
        `ledger.fixture.${method}`,
        [],
        ctx => {
          const { id, ...body } = input;
          return ['saveSale', 'reserveSale', 'pickUnits', 'shipSale'].includes(method)
            ? service[method](ctx, id || null, body)
            : service[method](ctx, body);
        }
      );
    } catch (error) {
      logger.debug('台账合成验证未完成', { code: error.code || error.name });
      throw error;
    }
  }

  beforeAll(async () => {
    try {
      await db.sequelize.authenticate();
      admin = await db.User.create({
        username: `ledger_admin_${prefix}`,
        password: crypto.randomBytes(20).toString('hex'),
        role: 'admin',
      });
      limited = await db.User.create({
        username: `ledger_limited_${prefix}`,
        password: crypto.randomBytes(20).toString('hex'),
        role: 'operator',
        orderAccess: { mode: 'tags', tags: [`allowed_${prefix}`] },
      });
      await db.UserPermission.bulkCreate(
        [
          'stock.read',
          'stock.receive',
          'stock.sales.read',
          'stock.sales.edit',
          'stock.sales.ship',
        ].map(permissionCode => ({ userId: limited.id, permissionCode }))
      );
      product = await db.StockProduct.create({
        modelKey: `ledger_${prefix}`,
        modelName: `台账合成机${prefix}`,
        storageGb: 256,
        colorKey: `blue_${prefix}`,
        colorName: '蓝色',
      });
      warehouseA = await db.StockLocation.create({
        name: `台账甲仓${prefix}`,
        kind: 'warehouse',
        city: '重庆',
      });
      warehouseB = await db.StockLocation.create({
        name: `台账乙仓${prefix}`,
        kind: 'warehouse',
        city: '重庆',
      });
      consignee = await db.StockParty.create({
        name: `台账代卖商${prefix}`,
        partyType: 'business',
        roles: ['consignee'],
      });
      outside = await db.StockLocation.create({
        name: `台账代卖位置${prefix}`,
        kind: 'consignee',
        city: '长沙',
        partyId: consignee.id,
      });
      settingsBefore = (await db.StockSetting.findByPk(1)).toJSON();
      await db.StockSetting.update({ enabled: true, cutoverAt: null }, { where: { id: 1 } });
    } catch (error) {
      logger.debug('台账合成验证未完成', { code: error.code || error.name });
      throw error;
    }
  }, 30000);
  afterAll(async () => {
    try {
      if (settingsBefore)
        await db.StockSetting.update(
          { enabled: settingsBefore.enabled, cutoverAt: settingsBefore.cutoverAt },
          { where: { id: 1 } }
        );
    } finally {
      await db.sequelize.close();
    }
  });

  test('设备整数编号由数据库递增生成，跨状态固定且并发不重复', async () => {
    const batches = await Promise.all([
      receive([newInput(), newInput()]),
      receive([newInput(), newInput()]),
    ]);
    const rows = batches.flat();
    const numbers = rows.map(row => row.deviceNumber).sort((a, b) => a - b);
    expect(numbers.every(number => Number.isInteger(number) && number > 0)).toBe(true);
    expect(new Set(numbers).size).toBe(4);
    expect(numbers).toEqual(Array.from({ length: 4 }, (_, index) => numbers[0] + index));
    const row = rows[0];
    const before = await detail(row.id);
    await execute('sellUnits', saleInput([row]));
    const sold = await detail(row.id);
    expect(sold.deviceNumber).toBe(before.deviceNumber);
    await execute(
      'recoverUnit',
      {
        expectedVersion: sold.version,
        warehouseId: warehouseA.id,
        confirmInWarehouse: true,
        reason: '合成编号恢复验证',
      },
      admin,
      row.id
    );
    expect((await detail(row.id)).deviceNumber).toBe(before.deviceNumber);
    const after = await receive([newInput()]);
    expect(after[0].deviceNumber).toBeGreaterThan(numbers[3]);
    await execute(
      'editUnit',
      {
        expectedVersion: (await detail(row.id)).version,
        deviceNumber: 99999,
      },
      admin,
      row.id
    );
    expect((await detail(row.id)).deviceNumber).toBe(before.deviceNumber);
  });

  test('设备编号禁止重复或非正数，已有实物时迁移回退拒绝删除编号', async () => {
    const [row] = await receive([newInput()]);
    const create = deviceNumber =>
      db.StockUnit.create({
        serialNumber: serial(),
        originMode: 'current',
        state: 'registered',
        deviceNumber,
      });
    await expect(create(row.deviceNumber)).rejects.toMatchObject({
      name: 'SequelizeUniqueConstraintError',
    });
    await expect(create(0)).rejects.toMatchObject({ parent: { code: '23514' } });
    const migration = require('../migrations/20261007000002-add-stock-device-number');
    await expect(migration.down(db.sequelize.getQueryInterface())).rejects.toThrow('已有设备编号');
    expect((await detail(row.id)).deviceNumber).toBe(row.deviceNumber);
  });

  test('入库无需订单和拿货日期，逐台成本待补；同表单就地创建并复用规格', async () => {
    const specification = {
      modelName: `就地机型${prefix}`,
      storageGb: 512,
      colorName: `合成白${prefix}`,
    };
    const inputs = [newInput(), newInput()].map((item, index) => ({
      ...item,
      productId: undefined,
      product: specification,
      ...(index ? { officialCostAmount: '8999.99' } : {}),
    }));
    const rows = await receive(inputs);
    const first = await detail(rows[0].id);
    const second = await detail(rows[1].id);
    expect(first).toMatchObject({
      state: 'in_stock',
      receivedOn: '2026-10-03',
      officialCostAmount: null,
      costStatus: 'pending',
      acquiredOn: null,
    });
    expect(second).toMatchObject({
      officialCostAmount: '8999.99',
      acquiredOn: null,
      costStatus: 'confirmed',
    });
    expect(rows[0].productId).toBe(rows[1].productId);
    expect(+rows[0].firstReceivedAt).toBe(+new Date('2026-10-03T00:00:00+08:00'));
    expect(first.extraExpenseAmount).toBeNull();
  });

  test('入库幂等、重复SN与批量末项非法不留下半批资料', async () => {
    const input = { requestKey: crypto.randomUUID(), units: [newInput(), newInput()] };
    const result = await execute('receiveUnits', input);
    const replay = await execute('receiveUnits', input);
    expect(replay.ledgerUnitIds).toEqual(result.ledgerUnitIds);
    expect(replay.idempotent).toBe(true);
    await expect(
      execute('receiveUnits', { ...input, units: input.units.slice(0, 1) })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(execute('receiveUnits', { units: input.units })).rejects.toMatchObject({
      statusCode: 409,
    });
    const failed = {
      requestKey: crypto.randomUUID(),
      units: [newInput(), { ...newInput(), receivedOn: '2026-02-30' }],
    };
    await expect(execute('receiveUnits', failed)).rejects.toMatchObject({ statusCode: 400 });
    expect(
      await db.StockUnit.count({
        where: { serialNumber: failed.units.map(item => item.serialNumber) },
      })
    ).toBe(0);
    expect(await db.StockOperation.count({ where: { requestKey: failed.requestKey } })).toBe(0);
    for (const method of ['receiveUnits', 'importHistory']) {
      const duplicate = newInput();
      const duplicateInput = {
        requestKey: crypto.randomUUID(),
        units: [duplicate, { ...duplicate, serialNumber: duplicate.serialNumber.toLowerCase() }],
      };
      if (method === 'importHistory') {
        duplicateInput.units = duplicateInput.units.map(item => ({
          ...item,
          saleAmount: '9000.00',
          settlementAmount: '9000.00',
        }));
        Object.assign(duplicateInput, {
          salespersonName: null,
          handlerName: null,
          soldOn: '2026-10-04',
          payment: { status: 'unknown' },
        });
      }
      const error = await execute(method, duplicateInput).catch(caught => caught);
      expect(error).toMatchObject({ statusCode: 409, code: 'SN_EXISTS' });
      expect(error.details?.existingUnitId).toBeUndefined();
      expect(error.details?.unitId).toBeUndefined();
      expect(await db.StockUnit.count({ where: { serialNumber: duplicate.serialNumber } })).toBe(0);
      expect(
        await db.StockOperation.count({ where: { requestKey: duplicateInput.requestKey } })
      ).toBe(0);
    }
  });

  test('同订单两台身份独立，后补订单号不改成本或库存，已有订单关联保留TAG边界', async () => {
    const orderNumber = `W${Date.now().toString().slice(-10)}`;
    const rows = await receive(
      [newInput(), newInput()].map(item => ({
        ...item,
        orderNumber,
        officialCostAmount: '8000.00',
      }))
    );
    expect((await detail(rows[0].id)).orderNumber).toBe(orderNumber);
    expect((await detail(rows[1].id)).orderNumber).toBe(orderNumber);
    expect(await db.PickupDevice.count({ where: { stockUnitId: rows.map(row => row.id) } })).toBe(
      0
    );
    const order = await db.Order.create({
      orderNumber,
      products: [{ name: '合成手机', quantity: 2 }],
      tag: `forbidden_${prefix}`,
    });
    await execute('editUnit', { expectedVersion: rows[0].version, orderNumber }, admin, rows[0].id);
    const reread = await detail(rows[0].id);
    expect(reread).toMatchObject({
      orderNumber,
      orderLinked: true,
      officialCostAmount: '8000.00',
      state: 'in_stock',
    });
    expect((await db.PickupDevice.findOne({ where: { stockUnitId: rows[0].id } })).orderId).toBe(
      order.id
    );
    const hidden = await detail(rows[0].id, limited);
    expect(hidden).not.toHaveProperty('orderNumber');
    expect(hidden).not.toHaveProperty('officialCostAmount');
    expect(hidden).not.toHaveProperty('grossProfit');
  });

  test('旧取货绑定和解绑清理待关联号码，不绕过TAG权限且保留物理与资金事实', async () => {
    const orderNumber = `W${Date.now().toString().slice(-10)}`;
    const units = await receive([newInput(), newInput()].map(item => ({ ...item, orderNumber })));
    for (const unit of units) {
      expect((await db.StockUnit.findByPk(unit.id)).orderNumberText).toBe(orderNumber);
      expect(await detail(unit.id)).toMatchObject({ orderLinked: false, orderNumber });
    }
    const order = await db.Order.create({
      orderNumber,
      products: [{ name: '合成手机', quantity: 2 }],
      tag: `forbidden_cleanup_${prefix}`,
    });
    const viewer = await db.User.create({
      username: `ledger_tag_viewer_${prefix}`,
      password: crypto.randomBytes(20).toString('hex'),
      role: 'operator',
      orderAccess: { mode: 'tags', tags: [`allowed_cleanup_${prefix}`] },
    });
    await db.UserPermission.bulkCreate(
      ['stock.read', 'stock.sales.read', 'orders.read', 'pickups.read'].map(permissionCode => ({
        userId: viewer.id,
        permissionCode,
      }))
    );
    const viewerCtx = await command.createReadContext(viewer);
    expect(viewerCtx.permissions.has('orders.read')).toBe(true);
    function response() {
      return {
        statusCode: 200,
        setHeader() {
          return this;
        },
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(payload) {
          this.payload = payload;
          return this;
        },
      };
    }
    const request = (who, unit, deviceId) => ({
      user: who,
      params: { orderId: order.id, deviceId },
      body: { serialBarcode: unit.serialNumber },
    });
    async function expectOrderHidden() {
      try {
        for (const unit of units) {
          const current = await projection.detail(viewerCtx, unit.id);
          const listed = await projection.list(viewerCtx, { view: 'all', q: unit.serialNumber });
          const oldDetail = await oldProjection.unitDetail(viewerCtx, unit.id);
          const oldList = await oldProjection.listUnits(viewerCtx, { q: unit.serialNumber });
          const events = await oldProjection.listEvents(viewerCtx, 'StockUnit', unit.id);
          expect(listed.total).toBe(1);
          expect(listed.items[0].id).toBe(unit.id);
          expect(current.orderNumber).toBeNull();
          for (const payload of [current, listed, oldDetail, oldList, events]) {
            expect(JSON.stringify(payload)).not.toContain(orderNumber);
          }
        }
        const search = await projection.list(viewerCtx, { view: 'all', q: orderNumber });
        expect(search.total).toBe(0);
        expect(search.items).toHaveLength(0);
        await expect(
          pickupController.list(request(viewer, units[0]), response())
        ).rejects.toMatchObject({ statusCode: 404 });
      } catch (error) {
        logger.debug('订单范围合成验证未完成', { code: error.code || error.name });
        throw error;
      }
    }

    await execute(
      'editUnit',
      { expectedVersion: units[0].version, orderNumber },
      admin,
      units[0].id
    );
    expect((await db.StockUnit.findByPk(units[0].id)).orderNumberText).toBeNull();
    const firstBinding = await db.PickupDevice.findOne({ where: { stockUnitId: units[0].id } });
    expect(firstBinding.orderId).toBe(order.id);
    const newBindingResponse = response();
    await pickupController.create(request(admin, units[1]), newBindingResponse);
    expect(newBindingResponse.payload.data.alreadyBound).toBe(false);
    expect((await db.StockUnit.findByPk(units[1].id)).orderNumberText).toBeNull();
    const secondBinding = await db.PickupDevice.findOne({ where: { stockUnitId: units[1].id } });
    await execute('sellUnits', {
      ...saleInput([await db.StockUnit.findByPk(units[0].id)]),
      payment: { status: 'company_received', receivedOn: '2026-10-04' },
    });
    const sold = await detail(units[0].id);
    const saleBefore = (await db.StockSale.findByPk(sold.saleId)).toJSON();
    const saleUnitBefore = (
      await db.StockSaleUnit.findOne({ where: { stockUnitId: units[0].id, status: 'shipped' } })
    ).toJSON();
    const collectionBefore = (
      await db.StockCollection.findOne({ where: { saleId: sold.saleId, status: 'posted' } })
    ).toJSON();
    const receiptBefore = (
      await db.StockReceipt.findOne({
        where: { collectionId: collectionBefore.id, status: 'posted' },
      })
    ).toJSON();
    const allocationBefore = (
      await db.StockReceiptAllocation.findOne({
        where: { saleUnitId: saleUnitBefore.id, status: 'active' },
      })
    ).toJSON();
    const inventoryBefore = await db.StockUnit.count({
      where: { productId: product.id, state: 'in_stock' },
    });

    // 模拟旧版已经落库的冗余文本，实际旧重扫必须清理，同时保持绑定UUID。
    await db.StockUnit.update({ orderNumberText: orderNumber }, { where: { id: units[0].id } });
    const sameBindingResponse = response();
    await pickupController.create(request(admin, units[0]), sameBindingResponse);
    expect(sameBindingResponse.payload.data.alreadyBound).toBe(true);
    expect(sameBindingResponse.payload.data.device.id).toBe(firstBinding.id);
    expect((await db.StockUnit.findByPk(units[0].id)).orderNumberText).toBeNull();

    // 再模拟旧冗余资料，解绑前后的公开投影都不能通过待关联文本泄漏原订单号。
    await db.StockUnit.update(
      { orderNumberText: orderNumber },
      { where: { id: units.map(unit => unit.id) } }
    );
    await expectOrderHidden();
    for (const [index, binding] of [firstBinding, secondBinding].entries()) {
      const removed = response();
      await pickupController.remove(request(admin, units[index], binding.id), removed);
      expect(removed.payload.data.removed).toBe(true);
      expect(await db.PickupDevice.findByPk(binding.id)).toBeNull();
      expect((await db.StockUnit.findByPk(units[index].id)).orderNumberText).toBeNull();
      await expectOrderHidden();
    }
    expect(await db.StockUnit.count({ where: { id: units.map(unit => unit.id) } })).toBe(2);
    expect((await db.StockUnit.findByPk(units[0].id)).state).toBe('sold');
    expect((await db.StockUnit.findByPk(units[1].id)).state).toBe('in_stock');
    expect(await db.StockUnit.count({ where: { productId: product.id, state: 'in_stock' } })).toBe(
      inventoryBefore
    );
    expect((await db.StockSale.findByPk(sold.saleId)).toJSON()).toEqual(saleBefore);
    expect((await db.StockSaleUnit.findByPk(saleUnitBefore.id)).toJSON()).toEqual(saleUnitBefore);
    expect((await db.StockCollection.findByPk(collectionBefore.id)).toJSON()).toEqual(
      collectionBefore
    );
    expect((await db.StockReceipt.findByPk(receiptBefore.id)).toJSON()).toEqual(receiptBefore);
    expect((await db.StockReceiptAllocation.findByPk(allocationBefore.id)).toJSON()).toEqual(
      allocationBefore
    );
    for (const unit of units) {
      expect(
        await db.StockEvent.count({
          where: { entityId: unit.id, action: 'legacy.source_unbind', actorUserId: admin.id },
        })
      ).toBe(1);
    }
    expect(
      await db.PickupRecordEvent.count({
        where: { orderId: order.id, eventType: 'device_removed', actorUserId: admin.id },
      })
    ).toBe(2);
  });

  test('旧取货身份的空白订单和成本表单不覆盖已核定事实，非空不同成本仍拒绝', async () => {
    const order = await db.Order.create({
      orderNumber: `W${Date.now().toString().slice(-10)}`,
      products: [{ name: '合成手机', quantity: 2 }],
      tag: `allowed_${prefix}`,
    });
    for (const method of ['receiveUnits', 'importHistory']) {
      const unit = await db.StockUnit.create({
        serialNumber: serial(),
        productId: product.id,
        originMode: 'legacy_binding',
        state: 'registered',
        costStatus: 'confirmed',
        officialCostAmount: '8000.01',
        acquiredOn: '2026-10-02',
        costSource: 'manual',
      });
      const binding = await db.PickupDevice.create({
        stockUnitId: unit.id,
        orderId: order.id,
        serialNumber: unit.serialNumber,
        serialBarcode: unit.serialNumber,
        scannedBy: admin.id,
      });
      const item = {
        serialNumber: unit.serialNumber,
        productId: product.id,
        warehouseId: warehouseA.id,
        receivedOn: '2026-10-03',
        orderNumber: null,
        officialCostAmount: null,
        acquiredOn: null,
        ...(method === 'importHistory'
          ? { saleAmount: '9000.00', settlementAmount: '9000.00' }
          : {}),
      };
      const input = { units: [item] };
      if (method === 'importHistory') {
        Object.assign(input, {
          salespersonName: null,
          handlerName: null,
          soldOn: '2026-10-04',
          payment: { status: 'unknown' },
        });
      }
      await expect(
        execute(method, { ...input, units: [{ ...item, officialCostAmount: '7999.99' }] })
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        execute(method, { ...input, units: [{ ...item, acquiredOn: '2026-10-01' }] })
      ).rejects.toMatchObject({ statusCode: 409 });
      expect((await db.StockUnit.findByPk(unit.id)).state).toBe('registered');
      const result = await execute(method, input);
      expect(result.ledgerUnitIds).toEqual([unit.id]);
      expect(await detail(unit.id)).toMatchObject({
        id: unit.id,
        serialNumber: unit.serialNumber,
        state: method === 'importHistory' ? 'sold' : 'in_stock',
        orderNumber: order.orderNumber,
        orderLinked: true,
        costStatus: 'confirmed',
        officialCostAmount: '8000.01',
        acquiredOn: '2026-10-02',
      });
      expect((await db.StockUnit.findByPk(unit.id)).costSource).toBe('manual');
      const currentBinding = await db.PickupDevice.findByPk(binding.id);
      expect(currentBinding).toMatchObject({
        stockUnitId: unit.id,
        orderId: order.id,
        serialNumber: unit.serialNumber,
      });
      expect(+currentBinding.createdAt).toBe(+binding.createdAt);
      expect(await db.StockUnit.count({ where: { serialNumber: unit.serialNumber } })).toBe(1);
      if (method === 'importHistory') {
        expect((await detail(unit.id)).grossProfit).toBe('999.99');
        expect(
          (await db.StockSaleUnit.findOne({ where: { stockUnitId: unit.id, status: 'shipped' } }))
            .costAmountSnapshot
        ).toBe('8000.01');
      }
    }
  });

  test('批量跨仓直接售出各台独立价费，结算毛利不重复扣费用，销售和出货人不混同', async () => {
    const rows = await receive([
      { ...newInput(), officialCostAmount: '8000.01' },
      { ...newInput(), warehouseId: warehouseB.id, officialCostAmount: '8000.01' },
    ]);
    const input = saleInput(rows);
    input.units[0] = {
      ...input.units[0],
      saleAmount: '9000.02',
      settlementAmount: '9000.02',
      extraExpenseAmount: '10.03',
    };
    input.units[1] = { ...input.units[1], saleAmount: '7999.99', settlementAmount: '7999.99' };
    await execute('sellUnits', input);
    const a = await detail(rows[0].id);
    const b = await detail(rows[1].id);
    expect(a).toMatchObject({
      state: 'sold',
      saleAmount: '9000.02',
      settlementAmount: '9000.02',
      grossProfit: '1000.01',
      extraExpenseAmount: '10.03',
      profitAfterExpenses: '1000.01',
      salespersonName: input.salespersonName,
      handlerName: input.handlerName,
      paymentStatus: 'unpaid',
    });
    expect(b).toMatchObject({ grossProfit: '-0.02', extraExpenseAmount: null });
    expect(a.sourceWarehouse.id).toBe(warehouseA.id);
    expect(b.sourceWarehouse.id).toBe(warehouseB.id);
    expect(a.saleId).not.toBe(b.saleId);
    expect(await db.StockCollection.count({ where: { saleId: [a.saleId, b.saleId] } })).toBe(0);
  });

  test('正常销售人员、日期和货款必填，不能接受历史待核实或非法金额', async () => {
    const [row] = await receive([newInput()]);
    for (const change of [
      { salespersonName: null },
      { handlerName: '' },
      { soldOn: '2026-02-30' },
      { payment: { status: 'unknown' } },
      { payment: { status: 'company_received' } },
    ]) {
      await expect(execute('sellUnits', { ...saleInput([row]), ...change })).rejects.toMatchObject({
        statusCode: 400,
      });
    }
    for (const saleAmount of ['0.00', '-1.00', 'NaN', '1.001']) {
      const input = saleInput([row]);
      input.units[0].saleAmount = saleAmount;
      await expect(execute('sellUnits', input)).rejects.toMatchObject({ statusCode: 400 });
    }
    expect((await db.StockUnit.findByPk(row.id)).state).toBe('in_stock');
    expect(await db.StockSaleUnit.count({ where: { stockUnitId: row.id } })).toBe(0);
  });

  test('批量最后一台无效回滚销售、人员、费用和货款；同时售出同台仅一请求成功', async () => {
    const rows = await receive([newInput(), newInput()]);
    const input = {
      ...saleInput(rows),
      requestKey: crypto.randomUUID(),
      salespersonName: `回滚销售${prefix}`,
      payment: { status: 'company_received', receivedOn: '2026-10-04' },
    };
    input.units[0].extraExpenseAmount = '3.21';
    input.units[1].saleAmount = 'NaN';
    await expect(execute('sellUnits', input)).rejects.toMatchObject({ statusCode: 400 });
    expect(
      await db.StockUnit.count({ where: { id: rows.map(row => row.id), state: 'in_stock' } })
    ).toBe(2);
    expect(await db.StockSaleUnit.count({ where: { stockUnitId: rows.map(row => row.id) } })).toBe(
      0
    );
    expect(await db.StockParty.count({ where: { name: input.salespersonName } })).toBe(0);
    expect(await db.StockOperation.count({ where: { requestKey: input.requestKey } })).toBe(0);
    const result = await Promise.allSettled([
      execute('sellUnits', saleInput([rows[0]])),
      execute('sellUnits', saleInput([rows[0]])),
    ]);
    expect(result.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(result.filter(item => item.status === 'rejected')).toHaveLength(1);
    expect(
      await db.StockSaleUnit.count({ where: { stockUnitId: rows[0].id, status: 'shipped' } })
    ).toBe(1);
  });

  test('收款三态跨日保持销售日期，代收全额和费用独立，公司到账重试不重复', async () => {
    const [row] = await receive([{ ...newInput(), officialCostAmount: '8000.00' }]);
    const input = saleInput([row]);
    input.units[0].extraExpenseAmount = '50.00';
    input.payment = { status: 'agent_pending', collectedOn: '2026-10-04' };
    await execute('sellUnits', input);
    const before = await detail(row.id);
    expect(before).toMatchObject({
      paymentStatus: 'agent_pending',
      collectorName: input.salespersonName,
      collectedOn: '2026-10-04',
      soldOn: '2026-10-04',
    });
    const collect = await db.StockCollection.findOne({
      where: { saleId: before.saleId, status: 'posted' },
    });
    expect(collect.amount).toBe('9000.00');
    const payment = {
      requestKey: crypto.randomUUID(),
      units: [{ id: row.id, expectedVersion: before.version }],
      payment: { status: 'company_received', receivedOn: '2026-10-05' },
    };
    await execute('setPayment', payment);
    expect((await execute('setPayment', payment)).idempotent).toBe(true);
    const after = await detail(row.id);
    expect(after).toMatchObject({
      paymentStatus: 'company_received',
      collectorName: input.salespersonName,
      collectedOn: '2026-10-04',
      companyReceivedOn: '2026-10-05',
      soldOn: '2026-10-04',
      grossProfit: '1000.00',
      profitAfterExpenses: '1000.00',
    });
    const saleUnit = await db.StockSaleUnit.findOne({
      where: { stockUnitId: row.id, status: 'shipped' },
    });
    expect(
      await db.StockReceiptAllocation.sum('amount', {
        where: { saleUnitId: saleUnit.id, status: 'active' },
      })
    ).toBe(9000);
    expect(
      await db.StockReceiptAllocation.count({
        where: { saleUnitId: saleUnit.id, status: 'active' },
      })
    ).toBe(1);
  });

  test('公司直收只有一份全款，正常到账日期必填，已知资金回退需原因和更正权限', async () => {
    const [row] = await receive([newInput()]);
    await execute('sellUnits', {
      ...saleInput([row]),
      payment: { status: 'company_received', receivedOn: '2026-10-04' },
    });
    const sold = await detail(row.id);
    const collection = await db.StockCollection.findOne({
      where: { saleId: sold.saleId, status: 'posted' },
    });
    expect(collection).toMatchObject({
      destination: 'company',
      collectorId: null,
      amount: '9000.00',
    });
    expect(
      await db.StockReceipt.count({ where: { collectionId: collection.id, status: 'posted' } })
    ).toBe(1);
    await expect(
      execute('setPayment', {
        units: [{ id: row.id, expectedVersion: sold.version }],
        payment: { status: 'unpaid' },
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    await execute('setPayment', {
      units: [{ id: row.id, expectedVersion: sold.version }],
      payment: { status: 'unpaid' },
      reason: '合成错记到账更正',
    });
    expect((await detail(row.id)).paymentStatus).toBe('unpaid');
    expect(
      await db.StockCollection.count({ where: { saleId: sold.saleId, status: 'posted' } })
    ).toBe(0);
    expect(
      await db.StockReceipt.count({ where: { collectionId: collection.id, status: 'posted' } })
    ).toBe(0);
  });

  test('付款与交货前后两讫可保存真实先收款日期，不强制编造成销售日', async () => {
    const rows = await receive([newInput(), newInput()]);
    await execute('sellUnits', {
      ...saleInput([rows[0]]),
      payment: { status: 'company_received', receivedOn: '2026-10-03' },
    });
    await execute('sellUnits', {
      ...saleInput([rows[1]]),
      payment: { status: 'agent_pending', collectedOn: '2026-10-03' },
    });
    expect(await detail(rows[0].id)).toMatchObject({
      soldOn: '2026-10-04',
      companyReceivedOn: '2026-10-03',
    });
    expect(await detail(rows[1].id)).toMatchObject({
      soldOn: '2026-10-04',
      collectedOn: '2026-10-03',
    });
  });

  test('批量更新货款遇到末项旧版本，第一台的到账与操作记录全部回滚', async () => {
    const rows = await receive([newInput(), newInput()]);
    await execute('sellUnits', saleInput(rows));
    const first = await detail(rows[0].id);
    const second = await detail(rows[1].id);
    const input = {
      requestKey: crypto.randomUUID(),
      units: [
        { id: first.id, expectedVersion: first.version },
        { id: second.id, expectedVersion: second.version - 1 },
      ],
      payment: { status: 'company_received', receivedOn: '2026-10-05' },
    };
    await expect(execute('setPayment', input)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(await detail(first.id)).toMatchObject({
      version: first.version,
      paymentStatus: 'unpaid',
    });
    expect(
      await db.StockCollection.count({ where: { saleId: first.saleId, status: 'posted' } })
    ).toBe(0);
    expect(await db.StockOperation.count({ where: { requestKey: input.requestKey } })).toBe(0);
  });

  test('代收转回是正向流程，但同时更改已知代收人或日期仍需更正权限和原因', async () => {
    const [row] = await receive([newInput()]);
    await execute('sellUnits', {
      ...saleInput([row]),
      payment: { status: 'agent_pending', collectedOn: '2026-10-04' },
    });
    const current = await detail(row.id);
    const cashier = await db.User.create({
      username: `ledger_cashier_${prefix}`,
      password: crypto.randomBytes(20).toString('hex'),
      role: 'operator',
    });
    await db.UserPermission.bulkCreate(
      [
        'stock.read',
        'stock.sales.read',
        'stock.collections.read',
        'stock.collections.edit',
        'stock.receipts.read',
        'stock.receipts.edit',
      ].map(permissionCode => ({ userId: cashier.id, permissionCode }))
    );
    const input = {
      units: [{ id: current.id, expectedVersion: current.version }],
      payment: {
        status: 'company_received',
        collectorName: `另一个代收人${prefix}`,
        receivedOn: '2026-10-05',
      },
    };
    await expect(
      execute('setPayment', { ...input, reason: '合成核对代收人' }, cashier)
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(execute('setPayment', input)).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      execute('setPayment', {
        ...input,
        payment: {
          status: 'company_received',
          collectedOn: '2026-10-03',
          receivedOn: '2026-10-05',
        },
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await detail(row.id)).toMatchObject({
      version: current.version,
      paymentStatus: 'agent_pending',
      collectorName: `销售${prefix}`,
      collectedOn: '2026-10-04',
    });
    await execute('setPayment', { ...input, reason: '合成核对实际代收人为另一个人' });
    expect(await detail(row.id)).toMatchObject({
      paymentStatus: 'company_received',
      collectorName: `另一个代收人${prefix}`,
      collectedOn: '2026-10-04',
      companyReceivedOn: '2026-10-05',
    });
  });

  test('历史人员、出库仓、入库和收款日期未知可留空，缺成本不伪造毛利，现货数量不变', async () => {
    const before = await db.StockUnit.count({
      where: { productId: product.id, state: 'in_stock' },
    });
    const input = {
      units: [
        {
          serialNumber: serial(),
          productId: product.id,
          saleAmount: '8500.00',
          settlementAmount: '8500.00',
        },
      ],
      salespersonName: null,
      handlerName: null,
      soldOn: '2026-09-15',
      payment: { status: 'unknown' },
    };
    const result = await execute('importHistory', input);
    const reread = await detail(result.ledgerUnitIds[0]);
    expect(reread).toMatchObject({
      state: 'sold',
      isHistorical: true,
      soldOn: '2026-09-15',
      salespersonName: null,
      handlerName: null,
      receivedOn: null,
      sourceWarehouse: null,
      grossProfit: null,
      paymentStatus: 'unknown',
    });
    expect(await db.StockUnit.count({ where: { productId: product.id, state: 'in_stock' } })).toBe(
      before
    );
    expect((await db.StockSetting.findByPk(1)).cutoverAt).toBeNull();
    expect(+new Date((await db.StockSale.findByPk(reread.saleId)).createdAt)).toBeGreaterThan(
      +new Date('2026-09-15T00:00:00+08:00')
    );
    await expect(execute('importHistory', input)).rejects.toMatchObject({ statusCode: 409 });
  });

  test('历史已知到账但日期不明可留空，后来补成本/人员/日期不改变销售日与库存', async () => {
    const result = await execute('importHistory', {
      units: [
        {
          serialNumber: serial(),
          productId: product.id,
          saleAmount: '8000.00',
          settlementAmount: '8000.00',
        },
      ],
      salespersonName: null,
      handlerName: null,
      soldOn: '2026-09-20',
      payment: { status: 'company_received' },
    });
    const id = result.ledgerUnitIds[0];
    const before = await detail(id);
    expect(before.companyReceivedOn).toBeNull();
    const collection = await db.StockCollection.findOne({
      where: { saleId: before.saleId, status: 'posted' },
    });
    expect(collection.receivedAt).toBeNull();
    await execute(
      'editUnit',
      {
        expectedVersion: before.version,
        officialCostAmount: '7999.99',
        sale: {
          salespersonName: `补销售${prefix}`,
          handlerName: `补出货${prefix}`,
          payment: { status: 'company_received', receivedOn: '2026-09-21' },
        },
        reason: '合成补齐历史记录',
      },
      admin,
      id
    );
    expect(await detail(id)).toMatchObject({
      state: 'sold',
      soldOn: '2026-09-20',
      grossProfit: '0.01',
      salespersonName: `补销售${prefix}`,
      handlerName: `补出货${prefix}`,
      companyReceivedOn: '2026-09-21',
    });
  });

  test('历史补录可复用旧取货身份，在库/在途/已售SN冲突不能静默覆盖', async () => {
    const old = await db.StockUnit.create({
      serialNumber: serial(),
      productId: product.id,
      originMode: 'legacy_binding',
      state: 'registered',
    });
    const base = {
      salespersonName: null,
      handlerName: null,
      soldOn: '2026-09-18',
      payment: { status: 'unknown' },
    };
    const result = await execute('importHistory', {
      ...base,
      units: [
        {
          serialNumber: old.serialNumber,
          productId: product.id,
          saleAmount: '8500.00',
          settlementAmount: '8500.00',
        },
      ],
    });
    expect(result.ledgerUnitIds).toEqual([old.id]);
    const [current] = await receive([newInput()]);
    const transit = await db.StockUnit.create({
      serialNumber: serial(),
      productId: product.id,
      originMode: 'current',
      state: 'in_transit',
    });
    for (const row of [old, current, transit]) {
      await expect(
        execute('importHistory', {
          ...base,
          units: [
            {
              serialNumber: row.serialNumber,
              productId: product.id,
              saleAmount: '8500.00',
              settlementAmount: '8500.00',
            },
          ],
        })
      ).rejects.toMatchObject({ statusCode: 409 });
    }
    expect((await db.StockUnit.findByPk(current.id)).state).toBe('in_stock');
    expect((await db.StockUnit.findByPk(transit.id)).state).toBe('in_transit');
  });

  test('在库更改仓库和资料有版本保护，未知日期不能自然归一化，审计可查前后值', async () => {
    const [row] = await receive([newInput()]);
    await execute(
      'editUnit',
      { expectedVersion: row.version, warehouseId: warehouseB.id, notes: '合成移动库位' },
      admin,
      row.id
    );
    const current = await detail(row.id);
    expect(current.warehouse.id).toBe(warehouseB.id);
    expect(current.notes).toBe('合成移动库位');
    await expect(
      execute('editUnit', { expectedVersion: row.version, notes: '覆盖旧版本' }, admin, row.id)
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(
      execute(
        'editUnit',
        { expectedVersion: current.version, receivedOn: '2026-02-30' },
        admin,
        row.id
      )
    ).rejects.toMatchObject({ statusCode: 400 });
    const events = await db.StockEvent.findAll({
      where: { entityId: row.id },
      order: [['id', 'ASC']],
    });
    const snapshots = events.map(event => decryptJson(event.changesCiphertext));
    expect(
      snapshots.some(
        event =>
          event.before?.locationId === warehouseA.id && event.after?.locationId === warehouseB.id
      )
    ).toBe(true);
    expect(events.every(event => event.actorUserId === admin.id)).toBe(true);
  });

  test('已关联订单的SN更正维持同一物理身份和绑定，重复SN更正全部回滚', async () => {
    const order = await db.Order.create({
      orderNumber: `W${Date.now().toString().slice(-10)}`,
      products: [{ name: '合成手机', quantity: 2 }],
      tag: `allowed_${prefix}`,
    });
    const rows = await receive(
      [newInput(), newInput()].map(item => ({ ...item, orderNumber: order.orderNumber }))
    );
    const binding = await db.PickupDevice.findOne({ where: { stockUnitId: rows[0].id } });
    const changedSerial = serial();
    await execute(
      'editUnit',
      { expectedVersion: rows[0].version, serialNumber: changedSerial },
      admin,
      rows[0].id
    );
    expect(await detail(rows[0].id)).toMatchObject({
      id: rows[0].id,
      serialNumber: changedSerial,
      orderLinked: true,
    });
    expect((await db.PickupDevice.findByPk(binding.id)).serialNumber).toBe(changedSerial);
    const current = await detail(rows[0].id);
    await expect(
      execute(
        'editUnit',
        {
          expectedVersion: current.version,
          serialNumber: rows[1].serialNumber,
          notes: '冲突备注不得保存',
        },
        admin,
        current.id
      )
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await detail(current.id)).toMatchObject({
      version: current.version,
      serialNumber: changedSerial,
    });
    expect((await detail(current.id)).notes).not.toBe('冲突备注不得保存');
    expect((await db.PickupDevice.findByPk(binding.id)).stockUnitId).toBe(current.id);
  });

  test('已售售价、代收人、费用更正同步资金事实，不出现旧额或错误付款人', async () => {
    const [row] = await receive([{ ...newInput(), officialCostAmount: '8000.00' }]);
    await execute('sellUnits', {
      ...saleInput([row]),
      payment: { status: 'agent_pending', collectedOn: '2026-10-04' },
    });
    let current = await detail(row.id);
    await execute('setPayment', {
      units: [{ id: row.id, expectedVersion: current.version }],
      payment: { status: 'company_received', receivedOn: '2026-10-05' },
    });
    current = await detail(row.id);
    await execute(
      'editUnit',
      {
        expectedVersion: current.version,
        extraExpenseAmount: '20.00',
        sale: {
          saleAmount: '8500.25',
          settlementAmount: '8500.25',
          payment: {
            status: 'company_received',
            collectorName: `实际代收${prefix}`,
            collectedOn: '2026-10-04',
            receivedOn: '2026-10-05',
          },
        },
        reason: '合成纠正售价与代收人',
      },
      admin,
      row.id
    );
    const after = await detail(row.id);
    expect(after).toMatchObject({
      saleAmount: '8500.25',
      settlementAmount: '8500.25',
      grossProfit: '500.25',
      profitAfterExpenses: '500.25',
      paymentStatus: 'company_received',
      collectorName: `实际代收${prefix}`,
    });
    const collection = await db.StockCollection.findOne({
      where: { saleId: after.saleId, status: 'posted' },
    });
    expect(collection.amount).toBe('8500.25');
    const saleUnit = await db.StockSaleUnit.findOne({
      where: { stockUnitId: row.id, status: 'shipped' },
    });
    const allocations = await db.StockReceiptAllocation.findAll({
      where: { saleUnitId: saleUnit.id, status: 'active' },
    });
    expect(allocations).toHaveLength(1);
    const receipt = await db.StockReceipt.findByPk(allocations[0].receiptId);
    expect(receipt).toMatchObject({
      amount: '8500.25',
      payerId: collection.collectorId,
      status: 'posted',
    });
  });

  test('已售更正末项非法时资料、成本快照、费用、资金与版本均不部分保存', async () => {
    const [row] = await receive([{ ...newInput(), officialCostAmount: '8000.00' }]);
    await execute('sellUnits', {
      ...saleInput([row]),
      payment: { status: 'company_received', receivedOn: '2026-10-04' },
    });
    const before = await detail(row.id);
    const input = {
      requestKey: crypto.randomUUID(),
      expectedVersion: before.version,
      officialCostAmount: '7999.99',
      extraExpenseAmount: '11.11',
      notes: '失败更正不得保存',
      sale: { saleAmount: 'NaN', settlementAmount: 'NaN' },
      reason: '合成测试整笔失败',
    };
    await expect(execute('editUnit', input, admin, row.id)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(await detail(row.id)).toMatchObject({
      version: before.version,
      saleAmount: '9000.00',
      settlementAmount: '9000.00',
      officialCostAmount: '8000.00',
      grossProfit: '1000.00',
      extraExpenseAmount: null,
      paymentStatus: 'company_received',
    });
    expect((await detail(row.id)).notes).not.toBe('失败更正不得保存');
    const saleUnit = await db.StockSaleUnit.findOne({
      where: { stockUnitId: row.id, status: 'shipped' },
    });
    expect(saleUnit.costAmountSnapshot).toBe('8000.00');
    expect(
      await db.StockReceiptAllocation.sum('amount', {
        where: { saleUnitId: saleUnit.id, status: 'active' },
      })
    ).toBe(9000);
    expect(await db.StockOperation.count({ where: { requestKey: input.requestKey } })).toBe(0);
  });

  test('误售恢复需要实物确认和原因，销售/费用/货款同时作废，可再次正常出售', async () => {
    const [row] = await receive([newInput()]);
    const input = saleInput([row]);
    input.units[0].extraExpenseAmount = '5.00';
    input.payment = { status: 'company_received', receivedOn: '2026-10-04' };
    await execute('sellUnits', input);
    const sold = await detail(row.id);
    const payload = {
      expectedVersion: sold.version,
      warehouseId: warehouseB.id,
      confirmInWarehouse: true,
      reason: '合成误点售出，实物仍在仓',
    };
    await expect(
      execute('recoverUnit', { ...payload, confirmInWarehouse: false }, admin, row.id)
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      execute('recoverUnit', { ...payload, reason: '' }, admin, row.id)
    ).rejects.toMatchObject({ statusCode: 400 });
    await execute('recoverUnit', payload, admin, row.id);
    const recovered = await detail(row.id);
    expect(recovered).toMatchObject({ state: 'in_stock', extraExpenseAmount: null });
    expect(recovered.receivedOn).toBe('2026-10-03');
    expect(recovered.warehouse.id).toBe(warehouseB.id);
    expect((await db.StockSale.findByPk(sold.saleId)).status).toBe('voided');
    expect(await db.StockExpense.count({ where: { saleId: sold.saleId, status: 'active' } })).toBe(
      0
    );
    expect(
      await db.StockCollection.count({ where: { saleId: sold.saleId, status: 'posted' } })
    ).toBe(0);
    const saleUnit = await db.StockSaleUnit.findOne({
      where: { stockUnitId: row.id, status: 'voided' },
    });
    expect(
      await db.StockReceiptAllocation.count({
        where: { saleUnitId: saleUnit.id, status: 'active' },
      })
    ).toBe(0);
    await execute('sellUnits', saleInput([await db.StockUnit.findByPk(row.id)]));
    expect(
      await db.StockSaleUnit.count({ where: { stockUnitId: row.id, status: 'shipped' } })
    ).toBe(1);
  });

  test('历史未知入库日期的误售恢复必须补真实日期，失败不改销售费用或资金', async () => {
    const result = await execute('importHistory', {
      units: [
        {
          serialNumber: serial(),
          productId: product.id,
          saleAmount: '9000.00',
          settlementAmount: '9000.00',
          extraExpenseAmount: '6.75',
        },
      ],
      salespersonName: null,
      handlerName: null,
      soldOn: '2026-10-01',
      payment: { status: 'unknown' },
    });
    const id = result.ledgerUnitIds[0];
    const before = await detail(id);
    expect(before).toMatchObject({ receivedOn: null, paymentStatus: 'unknown', state: 'sold' });
    const unitBefore = (await db.StockUnit.findByPk(id)).toJSON();
    const saleBefore = (await db.StockSale.findByPk(before.saleId)).toJSON();
    const expenseBefore = (
      await db.StockExpense.findOne({ where: { saleId: before.saleId, status: 'active' } })
    ).toJSON();
    const eventCount = await db.StockEvent.count({ where: { entityId: [id, before.saleId] } });
    const input = {
      requestKey: crypto.randomUUID(),
      expectedVersion: before.version,
      warehouseId: warehouseA.id,
      confirmInWarehouse: true,
      reason: '合成历史误录售出，已核对实物仍在仓',
    };
    await expect(execute('recoverUnit', input, admin, id)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect((await db.StockUnit.findByPk(id)).toJSON()).toEqual(unitBefore);
    expect((await db.StockSale.findByPk(before.saleId)).toJSON()).toEqual(saleBefore);
    expect((await db.StockExpense.findByPk(expenseBefore.id)).toJSON()).toEqual(expenseBefore);
    expect(await db.StockCollection.count({ where: { saleId: before.saleId } })).toBe(0);
    expect(await db.StockOperation.count({ where: { requestKey: input.requestKey } })).toBe(0);
    expect(await db.StockEvent.count({ where: { entityId: [id, before.saleId] } })).toBe(
      eventCount
    );
    await execute('recoverUnit', { ...input, receivedOn: '2026-09-30' }, admin, id);
    expect(await detail(id)).toMatchObject({
      state: 'in_stock',
      receivedOn: '2026-09-30',
      extraExpenseAmount: null,
    });
    expect(+(await db.StockUnit.findByPk(id)).firstReceivedAt).toBe(
      +new Date('2026-09-30T00:00:00+08:00')
    );
    expect((await db.StockSale.findByPk(before.saleId)).status).toBe('voided');
    expect((await db.StockExpense.findByPk(expenseBefore.id)).status).toBe('voided');
  });

  test('普通授权人员可无成本入库，敏感字段写入/历史更正和成功请求撤权重放均拒绝', async () => {
    const input = { requestKey: crypto.randomUUID(), units: [newInput()] };
    const result = await execute('receiveUnits', input, limited);
    const id = result.ledgerUnitIds[0];
    await expect(
      execute(
        'receiveUnits',
        { units: [{ ...newInput(), officialCostAmount: '1234.56' }] },
        limited
      )
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      execute('receiveUnits', { units: [{ ...newInput(), extraExpenseAmount: '12.34' }] }, limited)
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      execute(
        'importHistory',
        {
          units: [
            {
              serialNumber: serial(),
              productId: product.id,
              saleAmount: '9000.00',
              settlementAmount: '9000.00',
            },
          ],
          salespersonName: null,
          handlerName: null,
          soldOn: '2026-09-01',
          payment: { status: 'unknown' },
        },
        limited
      )
    ).rejects.toMatchObject({ statusCode: 403 });
    const masked = await detail(id, limited);
    for (const field of [
      'officialCostAmount',
      'grossProfit',
      'profitAfterExpenses',
      'extraExpenseAmount',
      'paymentStatus',
    ])
      expect(masked).not.toHaveProperty(field);
    await db.UserPermission.destroy({
      where: { userId: limited.id, permissionCode: 'stock.receive' },
    });
    await expect(execute('receiveUnits', input, limited)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(await db.StockUnit.count({ where: { id } })).toBe(1);
  });

  test('普通销售授权可记未收款销售，但不能写已收款或通过筛选获知资金', async () => {
    const rows = await receive([newInput(), newInput()]);
    await execute('sellUnits', saleInput([rows[0]]), limited);
    const visible = await detail(rows[0].id, limited);
    expect(visible).toMatchObject({
      state: 'sold',
      saleAmount: '9000.00',
      settlementAmount: '9000.00',
    });
    expect(visible).not.toHaveProperty('paymentStatus');
    await expect(
      execute(
        'sellUnits',
        { ...saleInput([rows[1]]), payment: { status: 'agent_pending' } },
        limited
      )
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      execute(
        'setPayment',
        {
          units: [{ id: visible.id, expectedVersion: visible.version }],
          payment: { status: 'company_received', receivedOn: '2026-10-05' },
        },
        limited
      )
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      projection.list(await command.createReadContext(limited), {
        view: 'sold',
        paymentStatus: 'company_received',
      })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect((await db.StockUnit.findByPk(rows[1].id)).state).toBe('in_stock');
  });

  test('无费用编辑权限的销售可自动结转已存单台费用，手工改费仍拒绝', async () => {
    const rows = await receive([
      { ...newInput(), officialCostAmount: '8000.00', extraExpenseAmount: '15.25' },
      { ...newInput(), officialCostAmount: '8000.00', extraExpenseAmount: '12.34' },
    ]);
    const request = { ...saleInput([rows[0]]), requestKey: crypto.randomUUID() };
    await execute('sellUnits', request, limited);
    expect((await execute('sellUnits', request, limited)).idempotent).toBe(true);
    const sold = await detail(rows[0].id);
    expect(sold).toMatchObject({
      state: 'sold',
      saleAmount: '9000.00',
      settlementAmount: '9000.00',
      extraExpenseAmount: '15.25',
      grossProfit: '1000.00',
      profitAfterExpenses: '1000.00',
      paymentStatus: 'unpaid',
    });
    expect(await detail(rows[0].id, limited)).not.toHaveProperty('extraExpenseAmount');
    const expenses = await db.StockExpense.findAll({
      where: { saleId: sold.saleId, status: 'active' },
    });
    expect(expenses).toHaveLength(1);
    expect(expenses[0]).toMatchObject({ amount: '15.25', createdBy: limited.id });
    const saleUnit = await db.StockSaleUnit.findOne({
      where: { stockUnitId: rows[0].id, status: 'shipped' },
    });
    const allocations = await db.StockExpenseAllocation.findAll({
      where: { expenseId: expenses[0].id },
    });
    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatchObject({ saleUnitId: saleUnit.id, amount: '15.25' });
    const manual = saleInput([rows[1]]);
    manual.units[0].extraExpenseAmount = '1.00';
    await expect(execute('sellUnits', manual, limited)).rejects.toMatchObject({ statusCode: 403 });
    expect(await detail(rows[1].id)).toMatchObject({
      state: 'in_stock',
      extraExpenseAmount: '12.34',
    });
    expect(await db.StockSaleUnit.count({ where: { stockUnitId: rows[1].id } })).toBe(0);
  });

  test('机型容量颜色精确多选在分页前筛选，库存销售计数一致且包含停用历史规格', async () => {
    const name = `筛选'_%${prefix}`;
    const variants = await db.StockProduct.bulkCreate(
      [
        {
          modelKey: `filter_a_${prefix}`,
          modelName: name,
          storageGb: 256,
          colorKey: 'blue',
          colorName: '筛选蓝',
        },
        {
          modelKey: `filter_a_${prefix}`,
          modelName: name,
          storageGb: 512,
          colorKey: 'blue',
          colorName: '筛选蓝',
        },
        {
          modelKey: `filter_b_${prefix}`,
          modelName: `筛选B${prefix}`,
          storageGb: 256,
          colorKey: 'silver',
          colorName: '筛选银',
        },
      ],
      { returning: true }
    );
    const units = await receive(
      Array.from({ length: 26 }, (_, index) => ({
        ...newInput(),
        productId: variants[index < 24 ? 0 : index === 24 ? 1 : 2].id,
      }))
    );
    const sellable = units.filter(unit => unit.productId === variants[0].id).slice(0, 2);
    await execute('sellUnits', saleInput(sellable));
    const ctx = await command.createReadContext(limited);
    const query = {
      modelNames: JSON.stringify([name]),
      storageGbs: '[256,512]',
      colorNames: '["筛选蓝"]',
      warehouseId: warehouseA.id,
    };
    const page1 = await projection.list(ctx, { ...query, view: 'in_stock', page: 1, pageSize: 20 });
    const page2 = await projection.list(ctx, { ...query, view: 'in_stock', page: 2, pageSize: 20 });
    expect(page1.total).toBe(23);
    expect(page1.items).toHaveLength(20);
    expect(page2.items).toHaveLength(3);
    expect(new Set([...page1.items, ...page2.items].map(item => item.id)).size).toBe(23);
    expect(page1.counts).toEqual({ pending: 0, returned: 0, inStock: 23, sold: 2 });
    const sold = await projection.list(ctx, { ...query, view: 'sold' });
    expect(sold.total).toBe(2);
    expect(
      sold.items.every(
        item => !Object.hasOwn(item, 'officialCostAmount') && !Object.hasOwn(item, 'grossProfit')
      )
    ).toBe(true);
    expect((await projection.list(ctx, { ...query, colorNames: '["筛选银"]' })).total).toBe(0);
    expect(
      (
        await projection.list(ctx, {
          ...query,
          modelNames: JSON.stringify([name, `筛选B${prefix}`]),
          colorNames: '["筛选蓝","筛选银"]',
          view: 'all',
        })
      ).total
    ).toBe(26);
    expect((await projection.list(ctx, { ...query, warehouseId: warehouseB.id })).total).toBe(0);
    expect(
      (await projection.list(ctx, { ...query, modelNames: JSON.stringify(["' OR 1=1 --"]) })).total
    ).toBe(0);
    await variants[0].update({ isActive: false });
    const options = await projection.catalog(ctx);
    expect(options.filterOptions.modelNames).toContain(name);
    expect(options.products.some(row => row.id === variants[0].id)).toBe(false);
    expect((await projection.list(ctx, { ...query, view: 'sold' })).total).toBe(2);
    await expect(projection.list(ctx, { storageGbs: '["256"]' })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  test('备注模糊搜索在分页前执行，字面符号、组合筛选与售前售后设备ID一致', async () => {
    const marker = `备注AbC'_%\\${prefix}`;
    const rows = await receive(
      Array.from({ length: 23 }, (_, index) => ({
        ...newInput(),
        notes: `前缀 ${marker} 后缀 ${index}`,
      }))
    );
    const ctx = await command.createReadContext(admin);
    const query = { q: marker.toLowerCase(), view: 'all', pageSize: 20 };
    const first = await projection.list(ctx, query);
    const second = await projection.list(ctx, { ...query, page: 2 });
    expect(first.total).toBe(23);
    expect(first.counts).toEqual({ pending: 0, returned: 0, inStock: 23, sold: 0 });
    expect(first.items).toHaveLength(20);
    expect(second.items).toHaveLength(3);
    expect(new Set([...first.items, ...second.items].map(row => row.id)).size).toBe(23);
    expect((await projection.list(ctx, { ...query, warehouseId: warehouseB.id })).total).toBe(0);
    expect((await projection.list(ctx, { ...query, q: `${marker}不存在` })).total).toBe(0);
    expect((await projection.list(ctx, { ...query, q: rows[0].serialNumber })).items[0].id).toBe(
      rows[0].id
    );
    const originalId = rows[0].id;
    await execute('sellUnits', saleInput([rows[0]]));
    const sold = await projection.list(ctx, { ...query, view: 'sold' });
    expect(sold.items).toHaveLength(1);
    expect(sold.items[0].id).toBe(originalId);
    expect(sold.counts).toEqual({ pending: 0, returned: 0, inStock: 22, sold: 1 });
    const restricted = await projection.list(await command.createReadContext(limited), query);
    expect(restricted.total).toBe(23);
    expect(restricted.items[0]).not.toHaveProperty('officialCostAmount');
    await execute('editUnit', { expectedVersion: rows[1].version, notes: null }, admin, rows[1].id);
    expect((await projection.list(ctx, query)).total).toBe(22);
  });

  test('加密备注候选超过500条时跨批次完整搜索且不能搜索审计备注', async () => {
    const marker = `分批备注${prefix}`;
    await db.StockUnit.bulkCreate(
      Array.from({ length: 501 }, () => ({
        serialNumber: serial(),
        productId: product.id,
        locationId: warehouseB.id,
        state: 'in_stock',
        originMode: 'current',
        firstReceivedAt: new Date('2026-10-01T00:00:00+08:00'),
        notesCiphertext: encrypt(marker),
      }))
    );
    const ctx = await command.createReadContext(admin);
    const result = await projection.list(ctx, {
      q: marker,
      warehouseId: warehouseB.id,
      page: 26,
      pageSize: 20,
    });
    expect(result.total).toBe(501);
    expect(result.counts).toEqual({ pending: 0, returned: 0, inStock: 501, sold: 0 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].notes).toBe(marker);
    const [row] = await receive([newInput()]);
    await execute('sellUnits', { ...saleInput([row]), notes: `仅销售审计${prefix}` });
    const sold = await detail(row.id);
    await execute('editUnit', { expectedVersion: sold.version, notes: null }, admin, row.id);
    expect((await projection.list(ctx, { view: 'all', q: `仅销售审计${prefix}` })).total).toBe(0);
  });

  test('台账只纳入自有仓库现货和本地已售，筛选分页和北京时间销售日正确', async () => {
    const local = await receive([newInput()]);
    const outsideUnit = await db.StockUnit.create({
      serialNumber: serial(),
      productId: product.id,
      state: 'in_stock',
      locationId: outside.id,
      firstReceivedAt: '2026-10-03T00:00:00+08:00',
      originMode: 'current',
    });
    const registered = await db.StockUnit.create({
      serialNumber: serial(),
      productId: product.id,
      originMode: 'legacy_binding',
      state: 'registered',
    });
    await execute('sellUnits', saleInput(local));
    const ctx = await command.createReadContext(admin);
    const listed = await projection.list(ctx, {
      view: 'all',
      productId: product.id,
      page: 1,
      pageSize: 100,
    });
    expect(listed.items.some(item => item.id === local[0].id)).toBe(true);
    expect(listed.items.some(item => item.id === outsideUnit.id || item.id === registered.id)).toBe(
      false
    );
    const sold = await projection.list(ctx, {
      view: 'sold',
      q: local[0].serialNumber,
      soldFrom: '2026-10-04',
      soldTo: '2026-10-04',
      page: 1,
      pageSize: 20,
    });
    expect(sold.total).toBe(1);
    expect(sold.items[0].soldOn).toBe('2026-10-04');
    expect(
      (
        await projection.list(ctx, {
          view: 'sold',
          q: local[0].serialNumber,
          soldFrom: '2026-10-05',
          soldTo: '2026-10-05',
        })
      ).total
    ).toBe(0);
    await expect(projection.list(ctx, { pageSize: '5000' })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(projection.list(ctx, { soldFrom: '2026-02-30' })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  test('无资金读取权限仍显示旧部分共享记录的兼容限制，不泄露货款和审计状态', async () => {
    const viewer = await db.User.create({
      username: `ledger_viewer_${prefix}`,
      password: crypto.randomBytes(20).toString('hex'),
      role: 'operator',
    });
    await db.UserPermission.bulkCreate(
      ['stock.read', 'stock.sales.read', 'stock.receive'].map(permissionCode => ({
        userId: viewer.id,
        permissionCode,
      }))
    );
    const seller = await db.StockParty.create({
      name: `旧共享销售${prefix}`,
      partyType: 'external_person',
      roles: ['salesperson', 'handler'],
    });
    const customer = await db.StockParty.create({
      name: `旧共享客户${prefix}`,
      partyType: 'business',
      roles: ['customer'],
    });
    const received = await legacy('receiveUnits', {
      units: [1, 2].map(() => ({
        serialBarcode: serial(),
        productId: product.id,
        locationId: warehouseA.id,
        receivedAt: '2026-10-03T00:00:00+08:00',
      })),
    });
    const sale = await legacy('saveSale', {
      salespersonId: seller.id,
      customerId: customer.id,
      lines: [{ productId: product.id, quantity: 2 }],
    });
    await legacy('reserveSale', { id: sale.saleId, expectedVersion: 0 });
    const adminCtx = await command.createReadContext(admin);
    let old = await oldProjection.saleDetail(adminCtx, sale.saleId);
    await legacy('pickUnits', {
      id: sale.saleId,
      expectedVersion: old.version,
      units: received.unitIds.map(unitId => ({ unitId, lineId: old.lines[0].id })),
    });
    old = await oldProjection.saleDetail(adminCtx, sale.saleId);
    await legacy('shipSale', {
      id: sale.saleId,
      expectedVersion: old.version,
      handlerId: seller.id,
      shippedAt: '2026-10-04T00:00:00+08:00',
      unitPrices: old.units.map(unit => ({ saleUnitId: unit.id, amount: '9000.00' })),
    });
    const collection = await legacy('createCollection', {
      saleId: sale.saleId,
      destination: 'agent',
      collectorId: seller.id,
      amount: '18000.00',
      receivedAt: '2026-10-04T01:00:00+08:00',
    });
    old = await oldProjection.saleDetail(adminCtx, sale.saleId);
    await legacy('createReceipt', {
      payerId: seller.id,
      amount: '2000.00',
      receivedAt: '2026-10-05T02:00:00+08:00',
      allocations: old.units.map(unit => ({
        collectionId: collection.collectionId,
        saleUnitId: unit.id,
        amount: '1000.00',
      })),
    });
    const ctx = await command.createReadContext(viewer);
    expect(ctx.permissions.has('stock.collections.read')).toBe(false);
    expect(ctx.permissions.has('stock.receipts.read')).toBe(false);
    for (const id of received.unitIds) {
      const item = await projection.detail(ctx, id);
      expect(item.compatibilityReason).toBeTruthy();
      expect(item.allowedActions).toContain('edit');
      expect(item.allowedActions).not.toContain('payment');
      expect(item.allowedActions).not.toContain('recover');
      expect(item.saleAmount).toBe('9000.00');
      for (const field of [
        'paymentStatus',
        'collectorName',
        'collectedOn',
        'companyReceivedOn',
        'collectionAmount',
        'receivedAmount',
        'outstandingAmount',
        'paymentVerification',
      ]) {
        expect(item).not.toHaveProperty(field);
        expect(JSON.stringify(item.events)).not.toContain(`"${field}":`);
      }
      expect(JSON.stringify(item)).not.toContain('1000.00');
      expect(JSON.stringify(item)).not.toContain('2000.00');
      expect(JSON.stringify(item)).not.toContain('18000.00');
      const oldDetail = await oldProjection.saleDetail(ctx, sale.saleId);
      expect(oldDetail).not.toHaveProperty('paymentVerification');
      expect(oldDetail).not.toHaveProperty('receivedAmount');
      expect(oldDetail).not.toHaveProperty('outstandingAmount');
    }
  });

  test('旧单台未登记付款保持待核实，改单不编造未收款，核实后三态与筛选一致', async () => {
    const seller = await db.StockParty.create({
      name: `旧待核实销售${prefix}`,
      partyType: 'external_person',
      roles: ['salesperson', 'handler'],
    });
    const customer = await db.StockParty.create({
      name: `旧待核实客户${prefix}`,
      partyType: 'business',
      roles: ['customer'],
    });
    const ctx = await command.createReadContext(admin);
    for (const status of ['unpaid', 'agent_pending', 'company_received']) {
      const received = await legacy('receiveUnits', {
        units: [
          {
            serialBarcode: serial(),
            productId: product.id,
            locationId: warehouseA.id,
            receivedAt: '2026-10-03T00:00:00+08:00',
          },
        ],
      });
      const sale = await legacy('saveSale', {
        salespersonId: seller.id,
        customerId: customer.id,
        lines: [{ productId: product.id, quantity: 1 }],
      });
      await legacy('reserveSale', { id: sale.saleId, expectedVersion: 0 });
      let old = await oldProjection.saleDetail(ctx, sale.saleId);
      await legacy('pickUnits', {
        id: sale.saleId,
        expectedVersion: old.version,
        units: [{ unitId: received.unitIds[0], lineId: old.lines[0].id }],
      });
      old = await oldProjection.saleDetail(ctx, sale.saleId);
      await legacy('shipSale', {
        id: sale.saleId,
        expectedVersion: old.version,
        handlerId: seller.id,
        shippedAt: '2026-10-04T00:00:00+08:00',
        unitPrices: [{ saleUnitId: old.units[0].id, amount: '9000.00' }],
      });
      const id = received.unitIds[0];
      let item = await detail(id);
      expect(item).toMatchObject({ isHistorical: false, paymentStatus: 'unknown' });
      expect(await db.StockSale.findByPk(item.saleId)).toMatchObject({
        simpleLedger: false,
        paymentVerification: 'known',
        isHistorical: false,
      });
      expect(await db.StockCollection.count({ where: { saleId: item.saleId } })).toBe(0);
      expect((await ledger.saleFacts(ctx, await db.StockUnit.findByPk(id))).status).toBe('unknown');
      expect(
        (
          await projection.list(ctx, {
            view: 'sold',
            q: item.serialNumber,
            paymentStatus: 'unknown',
          })
        ).total
      ).toBe(1);
      expect(
        (
          await projection.list(ctx, {
            view: 'sold',
            q: item.serialNumber,
            paymentStatus: 'unpaid',
          })
        ).total
      ).toBe(0);
      await execute(
        'editUnit',
        {
          expectedVersion: item.version,
          sale: { saleAmount: '9100.25', settlementAmount: '9100.25', soldOn: '2026-10-05' },
          reason: '合成核对旧售价与销售日，货款仍待核实',
        },
        admin,
        id
      );
      item = await detail(id);
      expect(item).toMatchObject({
        paymentStatus: 'unknown',
        saleAmount: '9100.25',
        settlementAmount: '9100.25',
        soldOn: '2026-10-05',
        isHistorical: false,
      });
      expect((await db.StockSale.findByPk(item.saleId)).simpleLedger).toBe(false);
      expect(await db.StockCollection.count({ where: { saleId: item.saleId } })).toBe(0);
      expect(
        (
          await projection.list(ctx, {
            view: 'sold',
            q: item.serialNumber,
            paymentStatus: 'unknown',
          })
        ).items[0].paymentStatus
      ).toBe('unknown');
      const payment = { status };
      if (status === 'agent_pending') payment.collectedOn = '2026-10-05';
      if (status === 'company_received') payment.receivedOn = '2026-10-06';
      await execute('setPayment', { units: [{ id, expectedVersion: item.version }], payment });
      const verified = await detail(id);
      expect(verified).toMatchObject({
        paymentStatus: status,
        saleAmount: '9100.25',
        settlementAmount: '9100.25',
        soldOn: '2026-10-05',
      });
      expect(await db.StockSale.findByPk(verified.saleId)).toMatchObject({
        simpleLedger: true,
        paymentVerification: 'known',
      });
      expect((await ledger.saleFacts(ctx, await db.StockUnit.findByPk(id))).status).toBe(status);
      const filtered = await projection.list(ctx, {
        view: 'sold',
        q: verified.serialNumber,
        paymentStatus: status,
      });
      expect(filtered.total).toBe(1);
      expect(filtered.items[0].paymentStatus).toBe(status);
      expect(
        (
          await projection.list(ctx, {
            view: 'sold',
            q: verified.serialNumber,
            paymentStatus: 'unknown',
          })
        ).total
      ).toBe(0);
      const collections = await db.StockCollection.findAll({
        where: { saleId: verified.saleId, status: 'posted' },
      });
      if (status === 'unpaid') expect(collections).toHaveLength(0);
      else {
        expect(collections).toHaveLength(1);
        expect(collections[0].amount).toBe('9100.25');
      }
    }
    const [fresh] = await receive([newInput()]);
    await execute('sellUnits', saleInput([fresh]));
    expect((await detail(fresh.id)).paymentStatus).toBe('unpaid');
    expect(
      (await projection.list(ctx, { view: 'sold', q: fresh.serialNumber, paymentStatus: 'unpaid' }))
        .total
    ).toBe(1);
    expect(
      (
        await projection.list(ctx, {
          view: 'sold',
          q: fresh.serialNumber,
          paymentStatus: 'unknown',
        })
      ).total
    ).toBe(0);
  });

  test('旧多台销售和部分到账仍可查、只限不兼容操作，不能被简化流程误认为全额到账', async () => {
    const seller = await db.StockParty.create({
      name: `旧销售${prefix}`,
      partyType: 'external_person',
      roles: ['salesperson'],
    });
    const handler = await db.StockParty.create({
      name: `旧出货${prefix}`,
      partyType: 'internal_person',
      roles: ['handler'],
    });
    const customer = await db.StockParty.create({
      name: `旧客户${prefix}`,
      partyType: 'business',
      roles: ['customer'],
    });
    const received = await legacy('receiveUnits', {
      units: [1, 2].map(() => ({
        serialBarcode: serial(),
        productId: product.id,
        locationId: warehouseA.id,
        receivedAt: '2026-10-03T00:00:00+08:00',
      })),
    });
    const sale = await legacy('saveSale', {
      salespersonId: seller.id,
      customerId: customer.id,
      lines: [{ productId: product.id, quantity: 2 }],
    });
    await legacy('reserveSale', { id: sale.saleId, expectedVersion: 0 });
    const ctx = await command.createReadContext(admin);
    let old = await oldProjection.saleDetail(ctx, sale.saleId);
    await legacy('pickUnits', {
      id: sale.saleId,
      expectedVersion: old.version,
      units: received.unitIds.map(unitId => ({ unitId, lineId: old.lines[0].id })),
    });
    old = await oldProjection.saleDetail(ctx, sale.saleId);
    await legacy('shipSale', {
      id: sale.saleId,
      expectedVersion: old.version,
      handlerId: handler.id,
      shippedAt: '2026-10-04T00:00:00+08:00',
      unitPrices: old.units.map(unit => ({ saleUnitId: unit.id, amount: '9000.00' })),
    });
    const collection = await legacy('createCollection', {
      saleId: sale.saleId,
      destination: 'agent',
      collectorId: seller.id,
      amount: '18000.00',
      receivedAt: '2026-10-04T00:00:00+08:00',
    });
    old = await oldProjection.saleDetail(ctx, sale.saleId);
    await legacy('createReceipt', {
      payerId: seller.id,
      amount: '1000.00',
      receivedAt: '2026-10-05T00:00:00+08:00',
      allocations: [
        { collectionId: collection.collectionId, saleUnitId: old.units[0].id, amount: '1000.00' },
      ],
    });
    const item = await detail(old.units[0].stockUnitId);
    expect(item.paymentStatus).toBe('legacy_partial');
    expect(item.compatibilityReason).toBeTruthy();
    expect(item.allowedActions).not.toContain('payment');
    expect(item.allowedActions).not.toContain('recover');
    await expect(
      execute('setPayment', {
        units: [{ id: item.id, expectedVersion: item.version }],
        payment: { status: 'company_received', receivedOn: '2026-10-05' },
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    await execute(
      'editUnit',
      { expectedVersion: item.version, notes: '旧复杂销售补备注' },
      admin,
      item.id
    );
    expect((await detail(item.id)).notes).toBe('旧复杂销售补备注');
    expect(
      await db.StockReceiptAllocation.sum('amount', {
        where: { saleUnitId: old.units[0].id, status: 'active' },
      })
    ).toBe(1000);
    const remaining = await detail(old.units[1].stockUnitId);
    expect(remaining.paymentStatus).toBe('agent_pending');
    expect(remaining.compatibilityReason).toBeTruthy();
    expect(remaining.allowedActions).not.toContain('payment');
    const filtered = await projection.list(ctx, {
      view: 'sold',
      q: remaining.serialNumber,
      paymentStatus: 'agent_pending',
    });
    expect(filtered.total).toBe(1);
    expect(filtered.items[0].paymentStatus).toBe('agent_pending');
    expect(
      (
        await projection.list(ctx, {
          view: 'sold',
          q: remaining.serialNumber,
          paymentStatus: 'legacy_partial',
        })
      ).total
    ).toBe(0);
  });
  test('人工结算决定毛利和货款，其他费用不重复扣减，补改全程留痕', async () => {
    const [row] = await receive([
      { ...newInput(), officialCostAmount: '11999.00', notes: '入库备注' },
    ]);
    const input = saleInput([row]);
    input.units[0] = {
      ...input.units[0],
      saleAmount: '13200.00',
      settlementAmount: '12900.00',
      extraExpenseAmount: '100.00',
    };
    input.payment = { status: 'agent_pending', collectedOn: '2026-10-04' };
    await execute('sellUnits', input);
    let current = await detail(row.id);
    expect(current).toMatchObject({
      notes: '入库备注',
      settlementAmount: '12900.00',
      grossProfit: '901.00',
      profitAfterExpenses: '901.00',
      paymentStatus: 'agent_pending',
    });
    expect(
      (await db.StockCollection.findOne({ where: { saleId: current.saleId, status: 'posted' } }))
        .amount
    ).toBe('12900.00');
    await execute('setPayment', {
      units: [{ id: row.id, expectedVersion: current.version }],
      payment: { status: 'company_received', receivedOn: '2026-10-05' },
    });
    current = await detail(row.id);
    expect(current.paymentStatus).toBe('company_received');
    const ctx = await command.createReadContext(admin);
    expect(
      (
        await projection.list(ctx, {
          view: 'sold',
          q: row.serialNumber,
          paymentStatus: 'company_received',
        })
      ).total
    ).toBe(1);
    await execute(
      'editUnit',
      {
        expectedVersion: current.version,
        notes: '售后备注',
        sale: { settlementAmount: '12800.00' },
        reason: '核对渠道结算',
      },
      admin,
      row.id
    );
    current = await detail(row.id);
    expect(current).toMatchObject({
      notes: '售后备注',
      grossProfit: '801.00',
      paymentStatus: 'company_received',
    });
    expect(
      (await db.StockCollection.findOne({ where: { saleId: current.saleId, status: 'posted' } }))
        .amount
    ).toBe('12800.00');
    const old = await oldProjection.saleDetail(ctx, current.saleId);
    expect(old.grossProfit).toBe('801.00');
    expect(old.profitAfterExpenses).toBe('801.00');
    await execute('editUnit', { expectedVersion: current.version, notes: null }, admin, row.id);
    expect((await detail(row.id)).notes).toBeNull();
  });

  test('结算未知不推算、零结算允许负毛利，非法金额和旧版本整笔拒绝', async () => {
    const [row] = await receive([{ ...newInput(), officialCostAmount: '100.00' }]);
    const input = saleInput([row]);
    delete input.units[0].settlementAmount;
    await execute('sellUnits', input);
    let current = await detail(row.id);
    expect(current.settlementAmount).toBeNull();
    expect(current.grossProfit).toBeNull();
    await expect(
      execute('setPayment', {
        units: [{ id: row.id, expectedVersion: current.version }],
        payment: { status: 'company_received', receivedOn: '2026-10-05' },
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    for (const value of ['-0.01', 'NaN', 'Infinity', '9000.01', '1.001']) {
      await expect(
        execute(
          'editUnit',
          {
            expectedVersion: current.version,
            sale: { settlementAmount: value },
            reason: '边界测试',
          },
          admin,
          row.id
        )
      ).rejects.toMatchObject({ statusCode: 400 });
    }
    expect((await detail(row.id)).version).toBe(current.version);
    await execute(
      'editUnit',
      {
        expectedVersion: current.version,
        sale: { settlementAmount: '0.00' },
        reason: '零结算核定',
      },
      admin,
      row.id
    );
    current = await detail(row.id);
    expect(current).toMatchObject({
      settlementAmount: '0.00',
      grossProfit: '-100.00',
      paymentStatus: 'unpaid',
    });
    await expect(
      execute(
        'editUnit',
        { expectedVersion: current.version - 1, notes: '过期更改' },
        admin,
        row.id
      )
    ).rejects.toMatchObject({ statusCode: 409 });
    const hidden = await detail(row.id, limited);
    expect(hidden).not.toHaveProperty('grossProfit');
    expect(hidden).not.toHaveProperty('officialCostAmount');
  });

  test('人员预置按角色返回，移出不删除历史姓名与备注', async () => {
    let result = await command.runCommand(
      admin,
      { requestKey: crypto.randomUUID() },
      'test.preset',
      ['stock.catalog.manage'],
      ctx =>
        oldUnits.saveCatalog(ctx, 'parties', null, {
          name: `预置${prefix}`,
          partyType: 'external_person',
          roles: ['salesperson', 'handler'],
          isActive: true,
        })
    );
    const ctx = await command.createReadContext(admin);
    const people = (await projection.catalog(ctx)).people;
    const person = people.find(item => item.id === result.id);
    expect(person.roles).toEqual(['salesperson', 'handler']);
    expect(person.version).toBe(0);
    await command.runCommand(
      admin,
      { requestKey: crypto.randomUUID() },
      'test.preset.remove',
      ['stock.catalog.manage'],
      context =>
        oldUnits.saveCatalog(context, 'parties', person.id, {
          expectedVersion: person.version,
          isActive: false,
        })
    );
    expect((await projection.catalog(ctx)).people.some(item => item.id === person.id)).toBe(false);
    expect(await db.StockParty.findByPk(person.id)).not.toBeNull();
  });

  test('数据库拒绝非法结算且有结算资料时正式down保护数据', async () => {
    const [row] = await receive([newInput()]);
    await execute('sellUnits', saleInput([row]));
    const saleUnit = await db.StockSaleUnit.findOne({
      where: { stockUnitId: row.id, status: 'shipped' },
    });
    for (const amount of ['-0.01', 'NaN', 'Infinity', '9000.01']) {
      await expect(
        db.sequelize.query('UPDATE stock_sale_units SET settlement_amount=:amount WHERE id=:id', {
          replacements: { amount, id: saleUnit.id },
        })
      ).rejects.toMatchObject({ original: { code: expect.stringMatching(/^(23514|22003)$/) } });
    }
    const migration = require('../migrations/20261005000003-add-stock-settlement');
    await expect(migration.down(db.sequelize.getQueryInterface())).rejects.toThrow(
      '已有结算业务资料'
    );
    expect((await detail(row.id)).settlementAmount).toBe('9000.00');
  });
  const dispatchInput = async (overrides = {}) => {
    try {
      const fixed = await db.StockProduct.findOne({ where: { skuCode: 'MJY64CH/A' } });
      return {
        ...saleInput([]),
        unit: {
          serialNumber: serial(),
          needsReceive: true,
          productId: fixed.id,
          warehouseId: warehouseA.id,
          receivedOn: '2026-10-03',
          saleAmount: '12000.00',
          ...overrides,
        },
      };
    } catch (error) {
      logger.debug('出库合成输入失败', { code: error.code || error.name });
      throw error;
    }
  };

  test('待补代收迁移空字段 down/up 保留业务记录及约束', async () => {
    const migration = require('../migrations/20261009000001-add-stock-pending-collection');
    const qi = db.sequelize.getQueryInterface();
    const before = await db.StockSale.count();
    await migration.down(qi);
    expect((await qi.describeTable('stock_sales')).pending_collector_id).toBeUndefined();
    await migration.up(qi);
    expect(await db.StockSale.count()).toBe(before);
    expect((await qi.describeTable('stock_sales')).pending_collector_id.allowNull).toBe(true);
  });

  test('单台出库未入库时原子创建入库销售及默认成本，重复提交只产生一份', async () => {
    const input = await dispatchInput();
    input.requestKey = crypto.randomUUID();
    const preview = await projection.dispatchPreview(await command.createReadContext(admin), {
      serialNumber: input.unit.serialNumber,
    });
    expect(preview).toEqual({ needsReceive: true, unit: null });
    const result = await execute('dispatchUnit', input);
    const repeated = await execute('dispatchUnit', input);
    expect(repeated.ledgerUnitIds).toEqual(result.ledgerUnitIds);
    const current = await detail(result.ledgerUnitIds[0]);
    expect(current).toMatchObject({
      state: 'sold',
      officialCostAmount: '10999.00',
      settlementAmount: null,
      receivedOn: '2026-10-03',
      soldOn: '2026-10-04',
      isHistorical: false,
      sourceWarehouse: { id: warehouseA.id },
    });
    expect(current.events.map(event => event.action)).toEqual(
      expect.arrayContaining(['ledger_receive', 'ledger_sold', 'ledger_sale'])
    );
    expect(
      await db.StockSaleUnit.count({ where: { stockUnitId: current.id, status: 'shipped' } })
    ).toBe(1);
    await expect(
      projection.dispatchPreview(await command.createReadContext(admin), {
        serialNumber: current.serialNumber,
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      execute('dispatchUnit', { ...input, requestKey: crypto.randomUUID() })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test('出库任一步失败不留下设备、销售、代收或入库事件', async () => {
    for (const changes of [
      { payment: { status: 'company_received', receivedOn: '2026-10-04' } },
      { salespersonName: '' },
      { handlerName: '' },
      { soldOn: '2026-10-02' },
    ]) {
      const input = { ...(await dispatchInput()), ...changes };
      const before = await db.StockEvent.count();
      await expect(execute('dispatchUnit', input)).rejects.toMatchObject({ statusCode: 400 });
      expect(await db.StockUnit.count({ where: { serialNumber: input.unit.serialNumber } })).toBe(
        0
      );
      expect(await db.StockEvent.count()).toBe(before);
    }
  });

  test('已有库存沿用成本，可手改且销售快照一致；旧版本和规格冲突拒绝', async () => {
    const input = await dispatchInput();
    const [unit] = await receive([
      {
        serialNumber: input.unit.serialNumber,
        productId: input.unit.productId,
        warehouseId: warehouseA.id,
        receivedOn: '2026-10-03',
        officialCostAmount: '10000.00',
      },
    ]);
    const preview = await projection.dispatchPreview(await command.createReadContext(admin), {
      serialNumber: unit.serialNumber,
    });
    expect(preview).toMatchObject({
      needsReceive: false,
      unit: { officialCostAmount: '10000.00' },
    });
    input.unit = {
      serialNumber: unit.serialNumber,
      productId: unit.productId,
      id: unit.id,
      expectedVersion: unit.version,
      needsReceive: false,
      saleAmount: '12000.00',
    };
    await expect(
      execute('dispatchUnit', {
        ...input,
        unit: { ...input.unit, expectedVersion: unit.version + 1 },
      })
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const other = await db.StockProduct.findOne({ where: { skuCode: 'MJY74CH/A' } });
    if (other)
      await expect(
        execute('dispatchUnit', { ...input, unit: { ...input.unit, productId: other.id } })
      ).rejects.toMatchObject({ statusCode: 409 });
    await execute('dispatchUnit', {
      ...input,
      unit: { ...input.unit, officialCostAmount: '10100.00' },
    });
    expect((await detail(unit.id)).officialCostAmount).toBe('10100.00');
    const saleUnit = await db.StockSaleUnit.findOne({
      where: { stockUnitId: unit.id, status: 'shipped' },
    });
    expect(saleUnit.costAmountSnapshot).toBe('10100.00');
  });

  test('出库权限、未知型号、无效仓库和并发状态必须在提交时重验', async () => {
    const input = await dispatchInput();
    await expect(
      execute(
        'dispatchUnit',
        { ...input, unit: { ...input.unit, officialCostAmount: '1.00' } },
        limited
      )
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      execute('dispatchUnit', { ...input, unit: { ...input.unit, productId: product.id } })
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      execute('dispatchUnit', { ...input, unit: { ...input.unit, warehouseId: null } })
    ).rejects.toMatchObject({ statusCode: 400 });
    const races = await Promise.allSettled([
      execute('dispatchUnit', input),
      execute('dispatchUnit', input),
    ]);
    expect(races.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(races.filter(result => result.status === 'rejected')[0].reason.statusCode).toBe(409);
  });

  test('registered 身份原地补入库、手改成本并售出，保留唯一设备', async () => {
    const input = await dispatchInput();
    const unit = await db.StockUnit.create({
      serialNumber: input.unit.serialNumber,
      state: 'registered',
      originMode: 'current',
      productId: input.unit.productId,
      officialCostAmount: '9999.00',
      costStatus: 'confirmed',
      costSource: 'manual',
    });
    const preview = await projection.dispatchPreview(await command.createReadContext(limited), {
      serialNumber: unit.serialNumber,
    });
    expect(preview).toMatchObject({
      needsReceive: true,
      unit: { id: unit.id, version: unit.version },
    });
    expect(preview.unit).not.toHaveProperty('officialCostAmount');
    input.unit = {
      ...input.unit,
      id: unit.id,
      expectedVersion: unit.version,
      officialCostAmount: '10200.00',
    };
    const result = await execute('dispatchUnit', input);
    expect(result.ledgerUnitIds).toEqual([unit.id]);
    expect((await detail(unit.id)).officialCostAmount).toBe('10200.00');
  });

  test('结算待补代收不产生金额，补齐后转明确收款并可到账；列表和权限一致', async () => {
    const input = await dispatchInput();
    input.payment = {
      status: 'agent_pending',
      collectorName: `代收${prefix}`,
      collectedOn: '2026-10-04',
    };
    const result = await execute('dispatchUnit', input);
    const id = result.ledgerUnitIds[0];
    let current = await detail(id);
    expect(current).toMatchObject({
      paymentStatus: 'agent_pending',
      collectorName: `代收${prefix}`,
      collectedOn: '2026-10-04',
      settlementAmount: null,
      grossProfit: null,
    });
    expect(await db.StockCollection.count({ where: { saleId: current.saleId } })).toBe(0);
    const rows = await projection.list(await command.createReadContext(admin), {
      q: current.serialNumber,
      view: 'sold',
      paymentStatus: 'agent_pending',
    });
    expect(rows.items.map(row => row.id)).toContain(id);
    const restricted = await detail(id, limited);
    expect(restricted).not.toHaveProperty('collectorName');
    expect(JSON.stringify(restricted.events)).not.toContain('pendingCollectorId');
    const migration = require('../migrations/20261009000001-add-stock-pending-collection');
    await expect(migration.down(db.sequelize.getQueryInterface())).rejects.toThrow(
      '已有待补代收事实'
    );
    await expect(
      execute('setPayment', {
        units: [{ id, expectedVersion: current.version }],
        payment: { status: 'company_received', receivedOn: '2026-10-04' },
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    await execute(
      'editUnit',
      {
        expectedVersion: current.version,
        sale: { settlementAmount: '11500.00' },
        reason: '核对实际结算',
      },
      admin,
      id
    );
    current = await detail(id);
    const sale = await db.StockSale.findByPk(current.saleId);
    expect(sale.pendingCollectorId).toBeNull();
    const collection = await db.StockCollection.findOne({
      where: { saleId: sale.id, status: 'posted' },
    });
    expect(collection.amount).toBe('11500.00');
    expect(current.collectorName).toBe(`代收${prefix}`);
    await execute('setPayment', {
      units: [{ id, expectedVersion: current.version }],
      payment: { status: 'company_received', receivedOn: '2026-10-05' },
    });
    expect((await detail(id)).paymentStatus).toBe('company_received');
  });

  test('金额待补代收误售恢复保留审计，必须具有资金更正权限', async () => {
    const input = await dispatchInput();
    input.payment = { status: 'agent_pending', collectorName: `待补${prefix}` };
    const result = await execute('dispatchUnit', input);
    const id = result.ledgerUnitIds[0];
    const current = await detail(id);
    await execute(
      'recoverUnit',
      {
        expectedVersion: current.version,
        warehouseId: warehouseA.id,
        confirmInWarehouse: true,
        reason: '合成误售恢复',
      },
      admin,
      id
    );
    const sale = await db.StockSale.findByPk(current.saleId);
    expect(sale.pendingCollectorId).toBeNull();
    expect((await detail(id)).state).toBe('in_stock');
  });
  test('出库 API 精确预览、字段拒绝、事务返回与幂等状态码', async () => {
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = admin;
      next();
    });
    app.use('/api/stock', require('../src/routes/stock'));
    const server = await new Promise(resolve => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    try {
      const url = `http://127.0.0.1:${server.address().port}/api/stock/ledger`;
      const input = await dispatchInput();
      delete input.units;
      input.requestKey = crypto.randomUUID();
      const preview = await fetch(
        `${url}/dispatch-preview?serialNumber=${input.unit.serialNumber}`
      );
      expect(preview.status).toBe(200);
      expect(preview.headers.get('cache-control')).toBe('no-store');
      expect((await preview.json()).data).toEqual({ needsReceive: true, unit: null });
      const invalid = await fetch(`${url}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...input, units: [] }),
      });
      expect(invalid.status).toBe(400);
      for (const expected of [201, 200]) {
        const response = await fetch(`${url}/dispatch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        const body = await response.json();
        expect({ status: response.status, error: body.error }).toEqual({ status: expected });
        expect(body.data.items[0]).toMatchObject({
          state: 'sold',
          serialNumber: input.unit.serialNumber,
        });
      }
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('仅销售人员可售已有库存，缺少入库权限无法补入库；原成本保持', async () => {
    const seller = await db.User.create({
      username: `dispatch_${prefix}`,
      password: crypto.randomBytes(20).toString('hex'),
      role: 'operator',
    });
    await db.UserPermission.bulkCreate(
      ['stock.read', 'stock.sales.read', 'stock.sales.edit', 'stock.sales.ship'].map(
        permissionCode => ({ userId: seller.id, permissionCode })
      )
    );
    const input = await dispatchInput();
    await expect(execute('dispatchUnit', input, seller)).rejects.toMatchObject({ statusCode: 403 });
    expect(await db.StockUnit.count({ where: { serialNumber: input.unit.serialNumber } })).toBe(0);
    const [unit] = await receive([
      {
        serialNumber: input.unit.serialNumber,
        productId: input.unit.productId,
        warehouseId: warehouseA.id,
        receivedOn: '2026-10-03',
        officialCostAmount: '9999.00',
      },
    ]);
    input.unit = {
      serialNumber: unit.serialNumber,
      productId: unit.productId,
      id: unit.id,
      expectedVersion: unit.version,
      needsReceive: false,
      saleAmount: '12000.00',
    };
    await execute('dispatchUnit', input, seller);
    expect((await detail(unit.id)).officialCostAmount).toBe('9999.00');
  });
});
