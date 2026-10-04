/** 仅在显式启用的自有库存隔离库执行；只清理由本测试用户创建的合成记录。 */
const crypto = require('crypto');
const XLSX = require('xlsx');
const suite = process.env.RUN_STOCK_INTEGRATION === 'true' ? describe : describe.skip;

suite('库存四类导入真实数据库闭环', () => {
  let db;
  let service;
  let command;
  let admin;
  let limited;
  let product;
  let warehouse;
  let consignee;
  let salesperson;
  let customer;
  let settingBefore;
  let cutover;
  const maintenanceOperationIds = [];
  const suffix = crypto.randomBytes(4).toString('hex');
  const sn = index => `I${suffix}${index}`.toUpperCase();
  const sourceLabel = `import-integration-${suffix}`;

  function fileFrom(rows) {
    const fields = [...new Set(rows.flatMap(row => Object.keys(row)))];
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([fields, ...rows.map(row => fields.map(field => row[field] ?? ''))]),
      '数据'
    );
    return {
      originalname: '合成验收.xlsx',
      buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }),
    };
  }

  async function importRows(kind, rows, user = admin) {
    try {
      const preview = await service.previewImport(user, {
        kind,
        sourceLabel,
        file: fileFrom(rows),
      });
      expect(preview.errors).toEqual([]);
      const input = {
        requestKey: crypto.randomUUID(),
        expectedVersion: preview.version,
        previewHash: preview.previewHash,
        importId: preview.id,
      };
      const refs = await command.runCommand(
        user,
        input,
        'import.commit',
        ['stock.import'],
        async ctx => {
          try {
            const { importId, ...body } = input;
            return await service.commitImport(ctx, importId, body);
          } catch (error) {
            throw new Error('合成导入提交失败', { cause: error });
          }
        }
      );
      const result = await service.getImport(user, refs.importId);
      expect(result.status).toBe('committed');
      const replay = await command.runCommand(
        user,
        input,
        'import.commit',
        ['stock.import'],
        async () => {
          await Promise.resolve();
          throw new Error('幂等重放不应再次执行业务');
        }
      );
      expect(replay.idempotent).toBe(true);
      return result;
    } catch (error) {
      throw new Error(`合成${kind}导入失败`, { cause: error });
    }
  }

  beforeAll(async () => {
    try {
      if (
        !/^apple_order_mgr_stock_test_[0-9]+$/.test(process.env.DB_NAME || '') ||
        process.env.DATABASE_URL ||
        process.env.DB_NAME_TEST !== process.env.DB_NAME
      )
        throw new Error('只允许明确匹配DB_NAME_TEST的库存隔离库');
      db = require('../src/models');
      service = require('../src/services/stockImportService');
      command = require('../src/services/stockCommandService');
      await db.sequelize.authenticate();
      const settings = await db.StockSetting.findByPk(1);
      settingBefore = settings.toJSON();
      cutover = settings.cutoverAt || new Date('2026-10-01T00:00:00+08:00');
      await settings.update({ enabled: true, cutoverAt: cutover });
      admin = await db.User.create({
        username: `stock_import_${suffix}`,
        password: crypto.randomBytes(32).toString('hex'),
        role: 'admin',
        status: 'active',
      });
      limited = await db.User.create({
        username: `stock_limited_${suffix}`,
        password: crypto.randomBytes(32).toString('hex'),
        role: 'operator',
        status: 'active',
      });
      await db.UserPermission.bulkCreate(
        ['stock.read', 'stock.import', 'stock.receive', 'stock.export'].map(permissionCode => ({
          userId: limited.id,
          permissionCode,
          grantedBy: admin.id,
        }))
      );
      const actor = { createdBy: admin.id, updatedBy: admin.id };
      product = await db.StockProduct.create({
        modelKey: `synthetic-${suffix}`,
        modelName: `导入合成机型${suffix}`,
        storageGb: 256,
        colorKey: 'blue',
        colorName: '蓝色',
        ...actor,
      });
      salesperson = await db.StockParty.create({
        name: `导入销售人${suffix}`,
        partyType: 'external_person',
        roles: ['salesperson', 'handler'],
        ...actor,
      });
      customer = await db.StockParty.create({
        name: `导入商户${suffix}`,
        partyType: 'business',
        roles: ['customer', 'consignee'],
        ...actor,
      });
      warehouse = await db.StockLocation.create({
        name: `导入测试仓${suffix}`,
        kind: 'warehouse',
        city: '重庆',
        ...actor,
      });
      consignee = await db.StockLocation.create({
        name: `导入代卖地${suffix}`,
        kind: 'consignee',
        city: '长沙',
        partyId: customer.id,
        ...actor,
      });
    } catch (error) {
      throw new Error('库存导入集成前置失败', { cause: error });
    }
  });

  afterAll(async () => {
    if (!db) return;
    try {
      const userIds = [admin?.id, limited?.id].filter(Boolean);
      if (userIds.length) {
        const { Op } = require('sequelize');
        const createdBy = { [Op.in]: userIds };
        await db.sequelize.transaction(async transaction => {
          try {
            for (const name of [
              'StockReceiptAllocation',
              'StockExpenseAllocation',
              'StockTransferUnit',
              'StockAttachmentLink',
              'StockAttachment',
              'StockReceipt',
              'StockCollection',
              'StockExpense',
              'StockSaleUnit',
              'StockSaleLine',
              'StockSale',
              'StockTransfer',
              'StockUnit',
              'StockOfficialPrice',
              'StockLocation',
              'StockParty',
              'StockProduct',
              'StockImportJob',
            ]) {
              await db[name].destroy({ where: { createdBy }, transaction });
            }
            await db.StockEvent.destroy({ where: { actorUserId: createdBy }, transaction });
            if (maintenanceOperationIds.length) {
              await db.StockEvent.destroy({
                where: { operationId: { [Op.in]: maintenanceOperationIds } },
                transaction,
              });
              await db.StockOperation.destroy({
                where: { id: { [Op.in]: maintenanceOperationIds } },
                transaction,
              });
            }
            await db.StockOperation.destroy({ where: { actorUserId: createdBy }, transaction });
            await db.UserPermission.destroy({ where: { userId: createdBy }, transaction });
            await db.User.destroy({ where: { id: createdBy }, force: true, transaction });
          } catch (error) {
            throw new Error('合成记录清理事务失败', { cause: error });
          }
        });
      }
      if (settingBefore)
        await db.StockSetting.update(
          { enabled: settingBefore.enabled, cutoverAt: settingBefore.cutoverAt },
          { where: { id: 1 } }
        );
    } catch (error) {
      throw new Error('库存导入集成清理失败', { cause: error });
    } finally {
      await db.sequelize.close();
    }
  });

  test('期初、历史销售、客户付款、公司到账全部提交并回读，历史不扣现货', async () => {
    try {
      const acquiredOn = new Date(+new Date(cutover) - 2 * 86400000).toISOString().slice(0, 10);
      await importRows('opening', [
        {
          serialNumber: sn(1),
          productId: product.id,
          locationId: warehouse.id,
          acquiredOn,
          costAmount: '8000.00',
          costBasis: '合成官网快照',
        },
      ]);
      expect(
        await db.StockUnit.count({ where: { productId: product.id, state: 'in_stock' } })
      ).toBe(1);
      const historyBase = {
        productId: product.id,
        channel: 'local',
        customerId: customer.id,
        salespersonId: salesperson.id,
        handlerId: salesperson.id,
        shippedAt: new Date(+new Date(cutover) - 86400000).toISOString(),
        acquiredOn,
        costAmount: '8000.00',
        costBasis: '合成官网快照',
        saleAmount: '9000.00',
      };
      const history = await importRows('historical_sales', [
        { ...historyBase, saleKey: 'local', serialNumber: sn(2) },
        { ...historyBase, saleKey: 'local', serialNumber: sn(3) },
        {
          ...historyBase,
          saleKey: 'agent',
          channel: 'consignment',
          consigneeLocationId: consignee.id,
          serialNumber: sn(4),
        },
      ]);
      expect(history.resultRefs.saleIds).toHaveLength(2);
      expect(
        await db.StockUnit.count({ where: { productId: product.id, state: 'in_stock' } })
      ).toBe(1);
      expect(await db.StockUnit.count({ where: { productId: product.id, state: 'sold' } })).toBe(3);
      const localSale = await db.StockSale.findOne({
        where: { id: history.resultRefs.saleIds, channel: 'local' },
      });
      const consigneeSale = await db.StockSale.findOne({
        where: { id: history.resultRefs.saleIds, channel: 'consignment' },
      });
      const paidAt = new Date(+new Date(cutover) + 3600000).toISOString();
      await importRows('collections', [
        {
          externalRecordKey: 'collection-local',
          saleNo: localSale.saleNo,
          destination: 'agent',
          collectorId: salesperson.id,
          amount: '18000.00',
          receivedAt: paidAt,
        },
        {
          externalRecordKey: 'collection-company',
          saleNo: consigneeSale.saleNo,
          destination: 'company',
          amount: '9000.00',
          receivedAt: paidAt,
        },
      ]);
      expect(
        await db.StockReceipt.count({ where: { createdBy: admin.id, source: 'direct_customer' } })
      ).toBe(1);
      const receiptBase = {
        externalRecordKey: 'receipt-local',
        payerId: salesperson.id,
        amount: '18000.00',
        receivedAt: new Date(+new Date(cutover) + 86400000).toISOString(),
        saleNo: localSale.saleNo,
        allocationAmount: '9000.00',
      };
      const receipt = await importRows('receipts', [
        { ...receiptBase, allocationSerialNumber: sn(2) },
        { ...receiptBase, allocationSerialNumber: sn(3) },
      ]);
      expect(receipt.resultRefs.receiptIds).toHaveLength(1);
      expect(
        await db.StockReceiptAllocation.sum('amount', {
          where: { receiptId: receipt.resultRefs.receiptIds[0], status: 'active' },
        })
      ).toBe(18000);
      const duplicate = await service.previewImport(admin, {
        kind: 'receipts',
        sourceLabel,
        file: fileFrom([{ ...receiptBase, allocationSerialNumber: sn(2) }]),
      });
      expect(duplicate.canCommit).toBe(false);
      expect(duplicate.errors[0].message).toContain('已导入');
      for (const [entity, filter] of [
        ['units', { q: `I${suffix}` }],
        ['sales', { salespersonId: salesperson.id }],
        ['receipts', { payerId: salesperson.id }],
      ]) {
        const exported = await service.exportStock(admin, { entity, ...filter });
        const rows = XLSX.utils.sheet_to_json(XLSX.read(exported.buffer).Sheets.导出数据, {
          header: 1,
        });
        expect(rows.length).toBeGreaterThan(1);
      }
    } catch (error) {
      throw new Error('四类库存导入闭环验收失败', { cause: error });
    }
  }, 60000);

  test('预览后撤销权限，get/commit和敏感字段导出都拒绝', async () => {
    try {
      const preview = await service.previewImport(limited, {
        kind: 'opening',
        sourceLabel,
        file: fileFrom([{ serialNumber: sn(5), productId: product.id, locationId: warehouse.id }]),
      });
      expect(preview.canCommit).toBe(true);
      await db.UserPermission.destroy({
        where: { userId: limited.id, permissionCode: 'stock.receive' },
      });
      await expect(service.getImport(limited, preview.id)).rejects.toMatchObject({
        statusCode: 403,
      });
      const input = {
        requestKey: crypto.randomUUID(),
        expectedVersion: preview.version,
        previewHash: preview.previewHash,
      };
      await expect(
        command.runCommand(limited, input, 'import.commit', ['stock.import'], async ctx => {
          try {
            return await service.commitImport(ctx, preview.id, input);
          } catch (error) {
            error.message = `导入确认权限校验：${error.message}`;
            throw error;
          }
        })
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        service.exportStock(limited, { entity: 'units', fields: ['officialCostAmount'] })
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        service.previewImport(limited, {
          kind: 'collections',
          sourceLabel,
          file: fileFrom([{ externalRecordKey: 'denied' }]),
        })
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(await db.StockUnit.count({ where: { serialNumber: sn(5) } })).toBe(0);
    } catch (error) {
      throw new Error('库存导入权限撤销验收失败', { cause: error });
    }
  });

  test('真实写入后故障使整批与幂等记录回滚，同键可安全重试', async () => {
    try {
      const preview = await service.previewImport(admin, {
        kind: 'opening',
        sourceLabel,
        file: fileFrom([{ serialNumber: sn(6), productId: product.id, locationId: warehouse.id }]),
      });
      const input = {
        requestKey: crypto.randomUUID(),
        expectedVersion: preview.version,
        previewHash: preview.previewHash,
      };
      await expect(
        command.runCommand(admin, input, 'import.commit-fault', ['stock.import'], async ctx => {
          try {
            await service.commitImport(ctx, preview.id, input);
            throw new Error('synthetic-post-write-fault');
          } catch (error) {
            throw new Error('synthetic-rollback', { cause: error });
          }
        })
      ).rejects.toThrow('synthetic-rollback');
      expect(await db.StockUnit.count({ where: { serialNumber: sn(6) } })).toBe(0);
      expect((await db.StockImportJob.findByPk(preview.id)).status).toBe('preview');
      expect(
        await db.StockOperation.count({
          where: { actorKey: String(admin.id), requestKey: input.requestKey },
        })
      ).toBe(0);
      await command.runCommand(admin, input, 'import.commit-fault', ['stock.import'], async ctx => {
        try {
          return await service.commitImport(ctx, preview.id, input);
        } catch (error) {
          throw new Error('回滚后重试失败', { cause: error });
        }
      });
      expect(await db.StockUnit.count({ where: { serialNumber: sn(6) } })).toBe(1);
    } catch (error) {
      throw new Error('库存原子导入故障回滚验收失败', { cause: error });
    }
  });
  test('500台期初预览与单事务提交满足最大批量限制', async () => {
    try {
      const rows = Array.from({ length: 500 }, (_, index) => ({
        serialNumber: `P${suffix.slice(0, 6)}${String(index).padStart(5, '0')}`.toUpperCase(),
        productId: product.id,
        locationId: warehouse.id,
      }));
      const result = await importRows('opening', rows);
      expect(result.resultRefs.unitIds).toHaveLength(500);
      expect(
        await db.StockUnit.count({ where: { id: result.resultRefs.unitIds, state: 'in_stock' } })
      ).toBe(500);
    } catch (error) {
      throw new Error('库存500台批量导入验收失败', { cause: error });
    }
  }, 60000);

  test('显式清理只移除本测试的过期未提交载荷，已提交引用保留', async () => {
    try {
      const { cleanExpiredPreviews } = require('../scripts/cleanupStockImportPreviews');
      const preview = await service.previewImport(admin, {
        kind: 'opening',
        sourceLabel,
        file: fileFrom([{ serialNumber: sn(7), productId: product.id, locationId: warehouse.id }]),
      });
      await db.StockImportJob.update(
        { expiresAt: new Date(Date.now() - 1000) },
        { where: { id: preview.id } }
      );
      const committed = await db.StockImportJob.findOne({
        where: { createdBy: admin.id, status: 'committed' },
      });
      const beforeRefs = committed.resultRefs;
      expect((await cleanExpiredPreviews({ createdBy: admin.id })).eligibleCount).toBe(1);
      expect((await db.StockImportJob.findByPk(preview.id)).payloadCiphertext).toHaveProperty(
        '__encrypted'
      );
      const cleaned = await cleanExpiredPreviews({ apply: true, createdBy: admin.id });
      maintenanceOperationIds.push(cleaned.operationId);
      expect(cleaned.cleanedCount).toBe(1);
      const expired = await db.StockImportJob.findByPk(preview.id);
      expect(expired.status).toBe('expired');
      expect(expired.payloadCiphertext).toEqual({});
      expect(await service.getImport(admin, preview.id)).toMatchObject({
        status: 'expired',
        canCommit: false,
        rows: [],
      });
      expect((await db.StockImportJob.findByPk(committed.id)).resultRefs).toEqual(beforeRefs);
      expect((await cleanExpiredPreviews({ apply: true, createdBy: admin.id })).cleanedCount).toBe(
        0
      );
    } catch (error) {
      throw new Error('显式过期清理数据库验收失败', { cause: error });
    }
  });
});
