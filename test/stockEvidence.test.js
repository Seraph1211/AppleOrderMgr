const ApiError = require('../src/utils/ApiError');
jest.mock('ali-oss', () => jest.fn());
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn() }));
jest.mock('../src/models', () =>
  Object.fromEntries(
    [
      'StockAttachment',
      'StockAttachmentLink',
      'StockUnit',
      'StockSale',
      'StockCollection',
      'StockReceipt',
      'StockExpense',
    ].map(name => [
      name,
      { findByPk: jest.fn(), findAll: jest.fn(), create: jest.fn(), bulkCreate: jest.fn() },
    ])
  )
);
jest.mock('../src/services/stockCommandService', () => ({
  createReadContext: jest.fn(),
  recordEvent: jest.fn(),
  updateRow: jest.fn(),
  requirePermissions: (ctx, ...codes) => {
    if (codes.some(code => !ctx.permissions.has(code)))
      throw new (require('../src/utils/ApiError'))(403, 'FORBIDDEN', '权限不足');
  },
  assertVersion: (row, version) => {
    if (row.version !== version)
      throw new (require('../src/utils/ApiError'))(409, 'VERSION_CONFLICT', '版本冲突');
  },
}));
jest.mock('../src/services/pickupOcrService', () => ({ recognize: jest.fn() }));

const OSS = require('ali-oss');
const db = require('../src/models');
const command = require('../src/services/stockCommandService');
const ocr = require('../src/services/pickupOcrService');
const oss = require('../src/services/ossService');
const evidence = require('../src/services/stockEvidenceService');
const id = value => `20000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
let ctx;
let attachment;
let links;
let client;
const originalEnv = process.env;

beforeEach(() => {
  jest.clearAllMocks();
  process.env = {
    ...originalEnv,
    OSS_REGION: 'oss-cn-test',
    OSS_BUCKET: 'synthetic-private',
    OSS_ACCESS_KEY_ID: 'synthetic-test',
    OSS_ACCESS_KEY_SECRET: 'synthetic-test',
  };
  ctx = {
    user: { id: 7, role: 'operator' },
    transaction: { id: 'test-tx' },
    operationId: id(99),
    permissions: new Set([
      'stock.read',
      'stock.receive',
      'stock.sales.read',
      'stock.sales.ship',
      'stock.collections.read',
      'stock.collections.edit',
      'stock.receipts.read',
      'stock.receipts.edit',
      'stock.expenses.read',
      'stock.expenses.edit',
    ]),
  };
  command.createReadContext.mockResolvedValue(ctx);
  command.recordEvent.mockResolvedValue();
  command.updateRow.mockImplementation((_ctx, target, values) => {
    Object.assign(target, values, { version: target.version + 1 });
    return Promise.resolve(target);
  });
  client = {
    signatureUrl: jest.fn(
      (key, options) => `https://synthetic.invalid/${key}?method=${options.method}`
    ),
    head: jest.fn().mockResolvedValue({
      res: { headers: { 'content-length': '1024', 'content-type': 'image/jpeg' } },
    }),
  };
  OSS.mockImplementation(() => client);
  attachment = {
    id: id(1),
    version: 0,
    kind: 'unit_photo',
    status: 'prepared',
    originalName: '测试.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1024,
    createdBy: 7,
    objectKey: `pickup-evidence/stock/${id(1)}/unit_photo/${id(9)}.jpg`,
    expiresAt: new Date(Date.now() + 100000),
  };
  links = [{ attachmentId: id(1), unitId: id(2) }];
  db.StockAttachment.findByPk.mockImplementation(() => Promise.resolve(attachment));
  db.StockAttachment.findAll.mockImplementation(() => Promise.resolve([attachment]));
  db.StockAttachmentLink.findAll.mockImplementation(() => Promise.resolve(links));
  db.StockAttachment.create.mockImplementation(values =>
    Promise.resolve({ version: 0, ...values })
  );
  db.StockAttachmentLink.bulkCreate.mockResolvedValue([]);
  db.StockUnit.findAll.mockResolvedValue([{ id: id(2) }]);
  db.StockSale.findAll.mockResolvedValue([{ id: id(3) }]);
  db.StockCollection.findAll.mockResolvedValue([{ id: id(4) }]);
  db.StockReceipt.findAll.mockResolvedValue([{ id: id(5) }]);
  db.StockExpense.findAll.mockResolvedValue([{ id: id(6) }]);
  ocr.recognize.mockResolvedValue({ candidates: ['F2LTEST001'], provider: 'aliyun' });
});
afterAll(() => {
  process.env = originalEnv;
});

describe('库存附件的私有存储与实际上传核验', () => {
  test('使用库存受控路径，PUT短期签名强制禁止覆盖', () => {
    const result = oss.createStockUpload(id(1), 'unit_photo', attachment);
    expect(result.objectKey).toMatch(/^pickup-evidence\/stock\/[^/]+\/unit_photo\/[^/]+\.jpg$/);
    expect(result.uploadHeaders).toEqual({
      'Content-Type': 'image/jpeg',
      'x-oss-forbid-overwrite': 'true',
    });
    expect(client.signatureUrl).toHaveBeenCalledWith(
      result.objectKey,
      expect.objectContaining({ method: 'PUT', expires: 300, 'x-oss-forbid-overwrite': 'true' })
    );
    expect(() =>
      oss.createStockUploadUrl('pickup-evidence/42/settlement/a.jpg', attachment)
    ).toThrow('路径');
  });

  test.each([
    [{ 'content-length': '1023', 'content-type': 'image/jpeg' }],
    [{ 'content-length': '1024', 'content-type': 'application/pdf' }],
    [{ 'content-length': '1024' }],
  ])('HEAD大小和MIME不一致不能确认 %#', async headers => {
    try {
      client.head.mockResolvedValue({ res: { headers } });
      await expect(oss.confirmStockUpload(attachment.objectKey, attachment)).rejects.toMatchObject({
        code: 'ATTACHMENT_MISMATCH',
      });
    } catch (error) {
      error.message = `库存文件回归失败：${error.message}`;
      throw error;
    }
  });

  test('OSS真实异常与未配置明确失败，不泄漏供应商原始响应', async () => {
    try {
      client.head.mockRejectedValue(new Error('secret-provider-response'));
      await expect(oss.confirmStockUpload(attachment.objectKey, attachment)).rejects.toMatchObject({
        code: 'OSS_UPLOAD_UNVERIFIED',
      });
      delete process.env.OSS_ACCESS_KEY_SECRET;
      expect(() => oss.createStockReadUrl(attachment.objectKey)).toThrow('OSS 尚未配置');
    } catch (error) {
      error.message = `库存文件回归失败：${error.message}`;
      throw error;
    }
  });

  test('prepare只创建预备元数据，HEAD在verify阶段才调用', async () => {
    try {
      const result = await evidence.prepareAttachment(ctx, {
        kind: 'unit_photo',
        originalName: '测试.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 1024,
        targets: [{ type: 'unit', id: id(2) }],
      });
      expect(result.attachmentId).toMatch(/^[a-f0-9-]+$/);
      expect(db.StockAttachment.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'prepared', createdBy: 7 }),
        { transaction: ctx.transaction }
      );
      expect(client.head).not.toHaveBeenCalled();
      const verification = await evidence.verifyAttachment(ctx.user, id(1));
      expect(client.head).toHaveBeenCalledTimes(1);
      expect(verification).toMatchObject({
        attachmentId: id(1),
        version: 0,
        sizeBytes: 1024,
        contentType: 'image/jpeg',
      });
      await evidence.confirmAttachment(ctx, id(1), { expectedVersion: 0 }, verification);
      expect(attachment.status).toBe('confirmed');
      expect(client.head).toHaveBeenCalledTimes(1);
    } catch (error) {
      error.message = `库存文件回归失败：${error.message}`;
      throw error;
    }
  });

  test('确认必须使用服务端核验，过期核验、版本变化与过期上传都拒绝', async () => {
    try {
      await expect(
        evidence.confirmAttachment(ctx, id(1), { expectedVersion: 0 }, null)
      ).rejects.toThrow('核验');
      const verification = await evidence.verifyAttachment(ctx.user, id(1));
      await expect(
        evidence.confirmAttachment(
          ctx,
          id(1),
          { expectedVersion: 0 },
          { ...verification, verifiedAt: 0 }
        )
      ).rejects.toThrow('过期');
      attachment.version = 1;
      await expect(
        evidence.confirmAttachment(ctx, id(1), { expectedVersion: 0 }, verification)
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      attachment.expiresAt = new Date(0);
      await expect(evidence.readUpload(ctx.user, id(1))).rejects.toMatchObject({
        code: 'ATTACHMENT_EXPIRED',
      });
    } catch (error) {
      error.message = `库存文件回归失败：${error.message}`;
      throw error;
    }
  });
});

describe('多目标权限、旧照片隔离和OCR共用', () => {
  test('附件元信息列表也不泄漏无财务权限的共用证明文件名', async () => {
    try {
      attachment.status = 'confirmed';
      links.push({ attachmentId: id(1), receiptId: id(5) });
      ctx.permissions.delete('stock.receipts.read');
      expect(await evidence.listAttachmentMetadata(ctx, 'unitId', id(2))).toEqual([]);
      ctx.permissions.add('stock.receipts.read');
      expect(await evidence.listAttachmentMetadata(ctx, 'unitId', id(2))).toEqual([
        expect.objectContaining({ id: id(1), originalName: '测试.jpg' }),
      ]);
      expect(client.signatureUrl).not.toHaveBeenCalled();
    } catch (error) {
      error.message = `库存文件回归失败：${error.message}`;
      throw error;
    }
  });
  test('多目标凭证每个领域都必须有权限，不能借库存读取财务证明', async () => {
    try {
      attachment.status = 'confirmed';
      links.push({ attachmentId: id(1), receiptId: id(5) });
      ctx.permissions.delete('stock.receipts.read');
      await expect(evidence.readAttachment(ctx.user, id(1))).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(client.signatureUrl).not.toHaveBeenCalled();
      ctx.permissions.add('stock.receipts.read');
      const result = await evidence.readAttachment(ctx.user, id(1));
      expect(result.targets).toHaveLength(2);
      expect(result.readUrl).toContain('method=GET');
      expect(result).not.toHaveProperty('objectKey');
    } catch (error) {
      error.message = `库存文件回归失败：${error.message}`;
      throw error;
    }
  });

  test('准备后撤销写权限或目标删除，确认不能继续', async () => {
    try {
      const verification = await evidence.verifyAttachment(ctx.user, id(1));
      ctx.permissions.delete('stock.receive');
      await expect(
        evidence.confirmAttachment(ctx, id(1), { expectedVersion: 0 }, verification)
      ).rejects.toMatchObject({ statusCode: 403 });
      ctx.permissions.add('stock.receive');
      db.StockUnit.findAll.mockResolvedValue([]);
      await expect(
        evidence.confirmAttachment(ctx, id(1), { expectedVersion: 0 }, verification)
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(command.updateRow).not.toHaveBeenCalled();
    } catch (error) {
      error.message = `库存文件回归失败：${error.message}`;
      throw error;
    }
  });

  test('未确认及非库存对象不可取得读取URL，目标重复和未知字段拒绝', async () => {
    try {
      await expect(evidence.readAttachment(ctx.user, id(1))).rejects.toThrow('尚未确认');
      attachment.status = 'confirmed';
      attachment.objectKey = 'pickup-evidence/42/pickup/old.jpg';
      await expect(evidence.readAttachment(ctx.user, id(1))).rejects.toThrow('路径');
      expect(() =>
        evidence.normalizeTargets([
          { type: 'unit', id: id(2) },
          { type: 'unit', id: id(2) },
        ])
      ).toThrow('重复');
      expect(() =>
        evidence.normalizeTargets([{ type: 'unit', id: id(2), objectKey: 'x' }])
      ).toThrow('未知');
    } catch (error) {
      error.message = `库存文件回归失败：${error.message}`;
      throw error;
    }
  });

  test('无来源订单OCR使用同一识别服务；失败不重试，图像缓冲区释放', async () => {
    try {
      const file = { buffer: Buffer.from('synthetic-image'), mimetype: 'image/jpeg' };
      expect((await evidence.recognizeSerial(ctx.user, file)).candidates).toEqual(['F2LTEST001']);
      expect(ocr.recognize).toHaveBeenCalledTimes(1);
      expect(file.buffer).toBeNull();
      ocr.recognize.mockRejectedValueOnce(new ApiError(429, 'OCR_MONTHLY_LIMIT', '额度用尽'));
      const retryFile = { buffer: Buffer.from('synthetic-image') };
      await expect(evidence.recognizeSerial(ctx.user, retryFile)).rejects.toMatchObject({
        code: 'OCR_MONTHLY_LIMIT',
      });
      expect(ocr.recognize).toHaveBeenCalledTimes(2);
      expect(retryFile.buffer).toBeNull();
      ctx.permissions.delete('stock.receive');
      ctx.permissions.delete('stock.sales.ship');
      await expect(
        evidence.recognizeSerial(ctx.user, { buffer: Buffer.alloc(1) })
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(ocr.recognize).toHaveBeenCalledTimes(2);
    } catch (error) {
      error.message = `库存文件回归失败：${error.message}`;
      throw error;
    }
  });
});
