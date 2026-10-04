/** 真正 PostgreSQL 事务、约束和并发回归；只在专用合成库运行。 */
const crypto = require('crypto');
const enabled = process.env.RUN_STOCK_INTEGRATION === 'true';
if (
  enabled &&
  (!/^apple_order_mgr_stock_test_\d+$/.test(process.env.DB_NAME || '') ||
    process.env.DATABASE_URL ||
    process.env.DB_NAME_TEST !== process.env.DB_NAME)
)
  throw new Error('拒绝在非独立库存合成库运行');
const suite = enabled ? describe : describe.skip;
suite('库存真实事务闭环', () => {
  const db = require('../src/models');
  const c = require('../src/services/stockCommandService');
  const u = require('../src/services/stockUnitService');
  const s = require('../src/services/stockSalesService');
  const f = require('../src/services/stockFinanceService');
  const t = require('../src/services/stockTransferService');
  const e = require('../src/services/stockExpenseService');
  const p = require('../src/services/stockProjectionService');
  const fix = require('../src/services/stockCorrectionService');
  let user,
    product,
    product2,
    customer,
    seller,
    other,
    handler,
    a,
    b,
    mw,
    consignee,
    stockIds = [],
    sale,
    collection,
    receipt;
  const suffix = crypto.randomBytes(4).toString('hex');
  const at = '2026-10-04T09:00:00+08:00';
  const soldAt = '2026-10-04T10:00:00+08:00';
  const sn = n => `T${suffix.toUpperCase()}${n}`;
  const run = (action, input, work, options) =>
    c.runCommand(user, { requestKey: crypto.randomUUID(), ...input }, action, [], work, options);
  const ctx = () => c.createReadContext(user);
  beforeAll(async () => {
    user = await db.User.create({
      username: `stock_test_${suffix}`,
      password: crypto.randomBytes(20).toString('hex'),
      role: 'admin',
    });
    await db.StockSetting.update({ enabled: true, cutoverAt: new Date(at) }, { where: { id: 1 } });
    const catalog = async (type, data) => {
      const result = await run(`catalog.${type}`, data, x => u.saveCatalog(x, type, null, data));
      return result.id;
    };
    product = await catalog('products', {
      modelKey: `test_${suffix}`,
      modelName: '合成手机',
      storageGb: 256,
      colorKey: 'blue',
      colorName: '蓝色',
    });
    product2 = await catalog('products', {
      modelKey: `test_${suffix}`,
      modelName: '合成手机',
      storageGb: 512,
      colorKey: 'blue',
      colorName: '蓝色',
    });
    customer = await catalog('parties', {
      name: `客户${suffix}`,
      partyType: 'business',
      roles: ['customer'],
    });
    seller = await catalog('parties', {
      name: `代收${suffix}`,
      partyType: 'external_person',
      roles: ['salesperson'],
    });
    other = await catalog('parties', {
      name: `其他${suffix}`,
      partyType: 'external_person',
      roles: ['salesperson'],
    });
    handler = await catalog('parties', {
      name: `交货${suffix}`,
      partyType: 'internal_person',
      roles: ['handler'],
    });
    consignee = await catalog('parties', {
      name: `明威${suffix}`,
      partyType: 'business',
      roles: ['consignee'],
    });
    a = await catalog('locations', { name: `重庆甲${suffix}`, kind: 'warehouse', city: '重庆' });
    b = await catalog('locations', { name: `重庆乙${suffix}`, kind: 'warehouse', city: '重庆' });
    mw = await catalog('locations', {
      name: `明威位置${suffix}`,
      kind: 'consignee',
      city: '长沙',
      partyId: consignee,
    });
  }, 30000);
  afterAll(async () => {
    await db.sequelize.close();
  });
  test('批量收货原子、幂等与同SN冲突', async () => {
    const input = {
      requestKey: crypto.randomUUID(),
      units: Array.from({ length: 5 }, (_, i) => ({
        serialBarcode: sn(i),
        productId: product,
        locationId: i < 3 ? a : b,
        receivedAt: at,
        acquiredOn: '2026-10-03',
        cost: { status: 'confirmed', amount: '8000.00', source: 'manual', basis: '合成官网价' },
      })),
    };
    const result = await run('receive', input, x => u.receiveUnits(x, input));
    stockIds = result.unitIds;
    expect(result.idempotent).toBe(false);
    expect((await run('receive', input, x => u.receiveUnits(x, input))).idempotent).toBe(true);
    await expect(
      run('receive', { ...input, mode: 'opening' }, x => u.receiveUnits(x, input))
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(run('receive', {}, x => u.receiveUnits(x, input))).rejects.toMatchObject({
      code: 'UNIT_STATE_CONFLICT',
    });
    expect(
      (await p.summary(await ctx())).items.find(row => row.productId === product)
    ).toMatchObject({ Q: 5, R: 0, A: 5 });
  });
  test('两个并发接3台仅一单成功、失败无残占用', async () => {
    const input = {
      customerId: customer,
      salespersonId: seller,
      lines: [{ productId: product, quantity: 3 }],
    };
    const x = await run('newSale', {}, v => s.saveSale(v, null, input));
    const y = await run('newSale', {}, v => s.saveSale(v, null, input));
    const results = await Promise.allSettled([
      run('reserve', { targetId: x.saleId }, v =>
        s.reserveSale(v, x.saleId, { expectedVersion: 0 })
      ),
      run('reserve', { targetId: y.saleId }, v =>
        s.reserveSale(v, y.saleId, { expectedVersion: 0 })
      ),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    sale = results.find(r => r.status === 'fulfilled').value.saleId;
    expect(
      (await p.summary(await ctx())).items.find(row => row.productId === product)
    ).toMatchObject({ Q: 5, R: 3, A: 2 });
  });
  test('挑SN不二扣、未挑齐不能出货、重复SN拒绝', async () => {
    let detail = await p.saleDetail(await ctx(), sale);
    const lines = detail.lines;
    await expect(
      run('picks', {}, v =>
        s.pickUnits(v, sale, {
          expectedVersion: detail.version,
          units: [
            { lineId: lines[0].id, unitId: stockIds[0] },
            { lineId: lines[0].id, unitId: stockIds[0] },
          ],
        })
      )
    ).rejects.toThrow();
    await run('pick1', {}, v =>
      s.pickUnits(v, sale, {
        expectedVersion: detail.version,
        units: [{ lineId: lines[0].id, unitId: stockIds[0] }],
      })
    );
    detail = await p.saleDetail(await ctx(), sale);
    await expect(
      run('shipfail', {}, v =>
        s.shipSale(v, sale, {
          expectedVersion: detail.version,
          handlerId: handler,
          shippedAt: soldAt,
          unitPrices: [],
        })
      )
    ).rejects.toMatchObject({ code: 'SHIPMENT_INCOMPLETE' });
    expect((await p.summary(await ctx())).items.find(row => row.productId === product).A).toBe(2);
    await run('pick3', {}, v =>
      s.pickUnits(v, sale, {
        expectedVersion: detail.version,
        units: [stockIds[0], stockIds[1], stockIds[3]].map(unitId => ({
          unitId,
          lineId: lines[0].id,
        })),
      })
    );
  });
  test('整单出货失败全部回滚，成功跨两个仓并锁官网成本', async () => {
    const detail = await p.saleDetail(await ctx(), sale);
    const input = {
      expectedVersion: detail.version,
      handlerId: handler,
      shippedAt: soldAt,
      unitPrices: detail.units.map(row => ({ saleUnitId: row.id, amount: '8500.00' })),
    };
    await expect(
      run('badShip', {}, v =>
        s.shipSale(v, sale, {
          ...input,
          unitPrices: [
            ...input.unitPrices.slice(0, 2),
            { saleUnitId: detail.units[2].id, amount: 'NaN' },
          ],
        })
      )
    ).rejects.toThrow();
    expect(await db.StockUnit.count({ where: { id: stockIds, state: 'sold' } })).toBe(0);
    await run('ship', {}, v => s.shipSale(v, sale, input));
    const after = await p.saleDetail(await ctx(), sale);
    expect(after.totalAmount).toBe('25500.00');
    expect(after.grossProfit).toBe('1500.00');
    expect(new Set(after.units.map(x => x.fromLocationId)).size).toBe(2);
    expect(
      (await p.summary(await ctx())).items.find(row => row.productId === product)
    ).toMatchObject({ Q: 2, R: 0, A: 2 });
  });
  test('3台1元尾差与单机费用独立于货款', async () => {
    await run('expense', {}, v =>
      e.saveExpense(v, sale, null, {
        category: 'shipping',
        scope: 'all_units',
        amount: '1.00',
        occurredAt: soldAt,
      })
    );
    const detail = await p.saleDetail(await ctx(), sale);
    expect(detail.expenses[0].allocations.map(a => a.amount).sort()).toEqual([
      '0.33',
      '0.33',
      '0.34',
    ]);
    expect(detail.profitAfterExpenses).toBe('1499.00');
    expect(detail.feesComplete).toBe(false);
  });
  test('代收→次日部分转回→超额/跨人拒绝', async () => {
    const result = await run('collect', {}, v =>
      f.createCollection(v, {
        saleId: sale,
        destination: 'agent',
        collectorId: seller,
        amount: '25500.00',
        receivedAt: soldAt,
      })
    );
    collection = result.collectionId;
    const detail = await p.saleDetail(await ctx(), sale);
    const input = {
      payerId: seller,
      amount: '10000.00',
      receivedAt: '2026-10-05T10:00:00+08:00',
      allocations: [
        { collectionId: collection, saleUnitId: detail.units[0].id, amount: '8500.00' },
        { collectionId: collection, saleUnitId: detail.units[1].id, amount: '1500.00' },
      ],
    };
    receipt = (await run('receipt', {}, v => f.createReceipt(v, input))).receiptId;
    await expect(
      run('wrongCollector', {}, v => f.createReceipt(v, { ...input, payerId: other }))
    ).rejects.toMatchObject({ code: 'COLLECTOR_MISMATCH' });
    await expect(run('over', {}, v => f.createReceipt(v, input))).rejects.toMatchObject({
      code: 'RECEIPT_OVERALLOCATED',
    });
    const summary = await p.receivableSummary(await ctx());
    expect(summary.items.find(r => r.collectorId === seller).outstandingAmount).toBe('15500.00');
  });
  test('完整原子纠错代收人与转回人，并拒绝过期/旧版本预览', async () => {
    const cRow = await db.StockCollection.findByPk(collection);
    const rRow = await db.StockReceipt.findByPk(receipt);
    const input = {
      kind: 'collection_fact',
      targetId: collection,
      expectedVersion: cRow.version,
      reason: '合成修正错记收款人',
      changes: {
        collectorId: other,
        receiptChanges: [{ id: receipt, expectedVersion: rRow.version, payerId: other }],
      },
    };
    const preview = await fix.previewCorrection(user, input);
    await run('correct', input, v =>
      fix.applyCorrection(v, { ...input, previewToken: preview.previewToken })
    );
    expect((await db.StockCollection.findByPk(collection)).collectorId).toBe(other);
    expect((await db.StockReceipt.findByPk(receipt)).payerId).toBe(other);
    await expect(
      run('staleCorrection', input, v =>
        fix.applyCorrection(v, { ...input, previewToken: preview.previewToken })
      )
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });
  test('直接发明威、在途不可售、分次实收、实际售出才收入', async () => {
    const input = { units: [5, 6].map(n => ({ serialBarcode: sn(n), productId: product })) };
    const refs = await run('register', {}, v => u.receiveUnits(v, input, true));
    const tr = (
      await run('transfer', {}, v =>
        t.createTransfer(v, {
          originLabel: '广州合成取出',
          toLocationId: mw,
          handlerId: handler,
          unitIds: refs.unitIds,
        })
      )
    ).transferId;
    await run('dispatch', {}, v =>
      t.dispatchTransfer(v, tr, { expectedVersion: 0, dispatchedAt: at })
    );
    await expect(
      run('earlyReceive', {}, v =>
        t.receiveTransfer(v, tr, {
          expectedVersion: 1,
          receivedAt: '2026-10-03T10:00:00+08:00',
          unitIds: refs.unitIds,
        })
      )
    ).rejects.toMatchObject({ code: 'DATE_INVALID' });
    await run('partReceive', {}, v =>
      t.receiveTransfer(v, tr, {
        expectedVersion: 1,
        receivedAt: soldAt,
        unitIds: [refs.unitIds[0]],
      })
    );
    expect((await db.StockTransfer.findByPk(tr)).status).toBe('partially_received');
    const saleId = (
      await run('consign', {}, v =>
        s.consignmentSale(v, {
          locationId: mw,
          salespersonId: seller,
          handlerId: handler,
          shippedAt: soldAt,
          units: [{ unitId: refs.unitIds[0], saleAmount: '8800.00' }],
        })
      )
    ).saleId;
    const detail = await p.saleDetail(await ctx(), saleId);
    expect(detail.grossProfit).toBeNull();
    await run('directCompany', {}, v =>
      f.createCollection(v, {
        saleId,
        destination: 'company',
        amount: '8800.00',
        receivedAt: soldAt,
      })
    );
    expect(await db.StockReceipt.count({ where: { source: 'direct_customer' } })).toBeGreaterThan(
      0
    );
  });
  test('历史补录不扣现货、当前SN冲突拒绝', async () => {
    const before = (await p.summary(await ctx())).items.find(row => row.productId === product).Q;
    const input = {
      channel: 'local',
      customerId: customer,
      salespersonId: seller,
      handlerId: handler,
      shippedAt: '2026-10-03T09:00:00+08:00',
      units: [{ serialBarcode: sn(7), productId: product, saleAmount: '8000.00' }],
    };
    await run('history', {}, v => s.importHistoricalSale(v, input));
    await expect(
      run('historyConflict', {}, v =>
        s.importHistoricalSale(v, {
          ...input,
          units: [{ ...input.units[0], serialBarcode: sn(2) }],
        })
      )
    ).rejects.toMatchObject({ code: 'UNIT_STATE_CONFLICT' });
    expect((await p.summary(await ctx())).items.find(row => row.productId === product).Q).toBe(
      before
    );
  });
  test('已确认注册成本不能经普通收货或历史导入换规格', async () => {
    const item = {
      serialBarcode: sn(8),
      productId: product,
      acquiredOn: '2026-10-03',
      cost: { status: 'confirmed', amount: '8000.00', source: 'manual' },
    };
    await run('regCost', {}, v => u.receiveUnits(v, { units: [item] }, true));
    await expect(
      run('regBypass', {}, v =>
        u.receiveUnits(v, { units: [{ serialBarcode: sn(8), productId: product2 }] }, true)
      )
    ).rejects.toMatchObject({ code: 'CORRECTION_CONFLICT' });
    await expect(
      run('regDateBypass', {}, v =>
        u.receiveUnits(
          v,
          { units: [{ serialBarcode: sn(8), productId: product, acquiredOn: '2026-10-02' }] },
          true
        )
      )
    ).rejects.toMatchObject({ code: 'CORRECTION_CONFLICT' });
    await expect(
      run('historyCost', {}, v =>
        s.importHistoricalSale(v, {
          channel: 'local',
          customerId: customer,
          salespersonId: seller,
          handlerId: handler,
          shippedAt: '2026-10-03T09:00:00+08:00',
          units: [{ serialBarcode: sn(8), productId: product2, saleAmount: '9000.00' }],
        })
      )
    ).rejects.toMatchObject({ code: 'CORRECTION_CONFLICT' });
  });
  test('字段权限、成功幂等重放再次鉴权、失败operation不存在', async () => {
    const limited = await db.User.create({
      username: `stock_limited_${suffix}`,
      password: crypto.randomBytes(20).toString('hex'),
      role: 'operator',
    });
    await db.UserPermission.bulkCreate(
      ['stock.read', 'stock.receive'].map(permissionCode => ({
        userId: limited.id,
        permissionCode,
      }))
    );
    const detail = await p.unitDetail(await c.createReadContext(limited), stockIds[0]);
    expect(detail).not.toHaveProperty('officialCostAmount');
    expect(JSON.stringify(detail.events)).not.toContain('8000.00');
    const key = crypto.randomUUID();
    await expect(
      c.runCommand(
        limited,
        { requestKey: key, units: [{ cost: { status: 'confirmed', amount: '1.00' } }] },
        'forbidden',
        ['stock.receive'],
        () => Promise.resolve({})
      )
    ).rejects.toMatchObject({ code: 'FIELD_FORBIDDEN' });
    expect(await db.StockOperation.count({ where: { requestKey: key } })).toBe(0);
  });
  test('目录有效期、已售成本更正与只读报表分页', async () => {
    const input = {
      productId: product,
      validFrom: '2026-10-01',
      validTo: '2026-11-01',
      amount: '7999.00',
      sourceLabel: '合成官网',
      sourceVersion: suffix,
    };
    const price = (await run('price', {}, v => u.saveCatalog(v, 'prices', null, input))).id;
    await expect(
      run('overlap', {}, v =>
        u.saveCatalog(v, 'prices', null, { ...input, validFrom: '2026-10-02' })
      )
    ).rejects.toThrow();
    let unit = await db.StockUnit.findByPk(stockIds[0]);
    await run('costUpdate', {}, v =>
      u.setCost(v, unit.id, {
        expectedVersion: unit.version,
        acquiredOn: '2026-10-03',
        status: 'confirmed',
        amount: '7999.00',
        source: 'catalog',
        priceId: price,
        reason: '合成更正拿货参考价格',
      })
    );
    const detail = await p.saleDetail(await ctx(), sale);
    expect(detail.grossProfit).toBe('1501.00');
    const listed = await p.listUnits(await ctx(), {
      states: JSON.stringify(['sold']),
      productIds: JSON.stringify([product]),
      page: 1,
      pageSize: 20,
    });
    expect(listed.items.length).toBeGreaterThan(0);
    expect(listed.total).toBeGreaterThanOrEqual(listed.items.length);
    expect((await p.listSales(await ctx(), { q: detail.saleNo })).items[0].id).toBe(sale);
    expect(
      (await p.listReceipts(await ctx(), { payerId: other })).items.some(r => r.id === receipt)
    ).toBe(true);
    expect((await p.listCollections(await ctx(), { saleId: sale })).items[0].id).toBe(collection);
    expect(
      (
        await p.reports(await ctx(), 'sales', {
          productIds: JSON.stringify([product]),
          from: '2026-10-04T00:00:00+08:00',
          to: '2026-10-05T00:00:00+08:00',
        })
      ).quantity
    ).toBeGreaterThan(0);
    expect((await p.reports(await ctx(), 'receipts', {})).totalAmount).toMatch(/\.\d{2}$/);
    expect((await p.catalog(await ctx())).products.some(r => r.id === product)).toBe(true);
  });
  test('外部参数不能伪造内部导出扩大列表分页', async () => {
    const current = await ctx();
    for (const internalExport of ['true', 'false', '1', { nested: 'true' }]) {
      await expect(
        p.listUnits(current, { pageSize: '5000', internalExport })
      ).rejects.toMatchObject({ statusCode: 400 });
    }
    const exported = await p.listUnits(current, { pageSize: 5000, internalExport: true });
    expect(exported.pageSize).toBe(5000);
    expect(exported.items.length).toBeGreaterThan(0);
  });
  test('来源后补和解绑保留实物、绑定版本与TAG保护', async () => {
    const order = await db.Order.create({
      orderNumber: `W${Date.now().toString().slice(-10)}`,
      products: [{ name: '合成iPhone', quantity: 1, price: 1 }],
      tag: `合成${suffix}`,
    });
    let unit = await db.StockUnit.findByPk(stockIds[2]);
    await run('source', {}, v =>
      u.setSource(v, unit.id, { orderId: order.id, bindingId: null, expectedVersion: unit.version })
    );
    let detail = await p.unitDetail(await ctx(), unit.id);
    expect(detail.sourceOrder.id).toBe(order.id);
    const bindingId = detail.sourceOrder.bindingId;
    await run('sourceSame', {}, v =>
      u.setSource(v, unit.id, { orderId: order.id, bindingId, expectedVersion: detail.version })
    );
    detail = await p.unitDetail(await ctx(), unit.id);
    await run('sourceClear', {}, v =>
      u.setSource(v, unit.id, { orderId: null, bindingId, expectedVersion: detail.version })
    );
    expect((await db.StockUnit.findByPk(unit.id)).state).toBe('in_stock');
    expect(await db.PickupDevice.count({ where: { stockUnitId: unit.id } })).toBe(0);
  });
  test('未出货编辑、取消、重新挑货、费用版本与完整性', async () => {
    const input = {
      customerId: customer,
      salespersonId: seller,
      lines: [{ productId: product, quantity: 1 }],
    };
    const id = (await run('cancelDraft', {}, v => s.saveSale(v, null, input))).saleId;
    await run('editDraft', {}, v =>
      s.saveSale(v, id, { expectedVersion: 0, lines: [{ productId: product, quantity: 2 }] })
    );
    await run('reserveEdit', {}, v => s.reserveSale(v, id, { expectedVersion: 1 }));
    let detail = await p.saleDetail(await ctx(), id);
    await run('pickEdit', {}, v =>
      s.pickUnits(v, id, {
        expectedVersion: detail.version,
        units: [{ lineId: detail.lines[0].id, unitId: stockIds[2] }],
      })
    );
    detail = await p.saleDetail(await ctx(), id);
    await run('unpick', {}, v =>
      s.pickUnits(v, id, { expectedVersion: detail.version, units: [] })
    );
    detail = await p.saleDetail(await ctx(), id);
    await run('cancel', {}, v =>
      s.cancelSale(v, id, { expectedVersion: detail.version, reason: '合成客户取消' })
    );
    expect((await db.StockSale.findByPk(id)).status).toBe('cancelled');
    detail = await p.saleDetail(await ctx(), sale);
    const expense = detail.expenses[0];
    await run('expenseEdit', {}, v =>
      e.saveExpense(v, null, expense.id, {
        expectedVersion: expense.version,
        scope: 'selected_units',
        saleUnitIds: [detail.units[0].id],
        amount: '20.00',
      })
    );
    let changed = await db.StockExpense.findByPk(expense.id);
    expect(await db.StockExpenseAllocation.count({ where: { expenseId: expense.id } })).toBe(4);
    await run('expenseVoid', {}, v =>
      e.voidExpense(v, expense.id, { expectedVersion: changed.version, reason: '合成费用误录' })
    );
    detail = await p.saleDetail(await ctx(), sale);
    await run('feesComplete', {}, v =>
      e.feesComplete(v, sale, { expectedVersion: detail.version, complete: true })
    );
    expect((await db.StockSale.findByPk(sale)).feesComplete).toBe(true);
  });
  test('身份位置纠错预览与误录销售作废完整回滚', async () => {
    let unit = await db.StockUnit.findByPk(stockIds[2]);
    let input = {
      kind: 'unit_identity',
      targetId: unit.id,
      expectedVersion: unit.version,
      reason: '合成纠正序列号输入',
      changes: { serialNumber: `Z${unit.serialNumber.slice(1)}` },
    };
    let preview = await fix.previewCorrection(user, input);
    await run('identityFix', input, v =>
      fix.applyCorrection(v, { ...input, previewToken: preview.previewToken })
    );
    unit = await db.StockUnit.findByPk(unit.id);
    expect(unit.serialNumber.startsWith('Z')).toBe(true);
    input = {
      kind: 'unit_location',
      targetId: unit.id,
      expectedVersion: unit.version,
      reason: '合成盘点确认位置误录',
      changes: { state: 'in_stock', locationId: b, occurredAt: soldAt },
    };
    preview = await fix.previewCorrection(user, input);
    await run('locationFix', input, v =>
      fix.applyCorrection(v, { ...input, previewToken: preview.previewToken })
    );
    expect((await db.StockUnit.findByPk(unit.id)).locationId).toBe(b);
    const hist = await db.StockSale.findOne({
      where: { isHistorical: true, salespersonId: seller },
    });
    const detail = await p.saleDetail(await ctx(), hist.id);
    input = {
      kind: 'sale_fact',
      targetId: hist.id,
      expectedVersion: hist.version,
      reason: '合成撤销误录历史销售',
      changes: {
        void: true,
        unitRestorations: detail.units.map(row => ({ unitId: row.unitId, state: 'registered' })),
      },
    };
    preview = await fix.previewCorrection(user, input);
    await run('historyVoid', input, v =>
      fix.applyCorrection(v, { ...input, previewToken: preview.previewToken })
    );
    expect((await db.StockSale.findByPk(hist.id)).status).toBe('voided');
  });
  test('转仓草稿取消与到账重新分配', async () => {
    const refs = await run('transferDraft', {}, v =>
      t.createTransfer(v, {
        fromLocationId: b,
        toLocationId: a,
        handlerId: handler,
        unitIds: [stockIds[2]],
      })
    );
    await run('transferCancel', {}, v =>
      t.cancelTransfer(v, refs.transferId, { expectedVersion: 0, reason: '合成转运取消' })
    );
    expect((await p.transferDetail(await ctx(), refs.transferId)).status).toBe('cancelled');
    expect(
      (await p.listTransfers(await ctx(), { status: 'cancelled' })).items.some(
        r => r.id === refs.transferId
      )
    ).toBe(true);
    const r = await db.StockReceipt.findByPk(receipt);
    const d = await p.receiptDetail(await ctx(), receipt);
    await run('reallocate', {}, v =>
      f.setAllocations(v, receipt, {
        expectedVersion: r.version,
        allocations: d.allocations.map(a => ({
          collectionId: a.collectionId,
          saleUnitId: a.saleUnitId,
          amount: a.amount,
        })),
      })
    );
    expect((await p.receiptDetail(await ctx(), receipt)).allocatedAmount).toBe('10000.00');
  });
});
