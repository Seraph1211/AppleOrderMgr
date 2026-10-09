const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('../src/models', () => ({
  AppleId: { findAll: jest.fn(), findOne: jest.fn(), create: jest.fn() },
  Recipient: { findAll: jest.fn() },
  Order: { findAll: jest.fn() },
  sequelize: { transaction: jest.fn(), query: jest.fn() },
}));
const {
  parseExcelFile,
  previewImportData,
  validateAppleId,
  validateRecipient,
} = require('../src/services/importService');
const { previewImport, executeImport } = require('../src/controllers/importController');
const { exportOrders } = require('../src/controllers/orderController');
const { exportRecipients } = require('../src/controllers/recipientController');
const { AppleId, Recipient, Order, sequelize } = require('../src/models');
const { verifyVendor } = require('../scripts/verifyVendor');

let tempDir;
let sequence = 0;

function workbookFile(rows, sheetName = 'Apple IDs') {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), sheetName);
  const filePath = path.join(tempDir, `${sequence++}.xlsx`);
  XLSX.writeFile(book, filePath);
  return filePath;
}

function response() {
  return { set: jest.fn(), json: jest.fn(), send: jest.fn(), setHeader: jest.fn() };
}

async function previewRows(count = 1) {
  const rows = [['Apple ID', '密码']];
  for (let i = 0; i < count; i++) rows.push([`synthetic-${i}@example.invalid`, 'synthetic-value']);
  const filePath = workbookFile(rows);
  const res = response();
  await previewImport(
    { query: {}, file: { path: filePath }, body: { type: 'apple_ids' }, user: { id: 1 } },
    res
  );
  return { filePath, result: res.json.mock.calls[0][0].data };
}

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aom-xlsx-test-'));
});
afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});
beforeEach(() => {
  jest.clearAllMocks();
  AppleId.findAll.mockResolvedValue([]);
  Recipient.findAll.mockResolvedValue([]);
  sequelize.query.mockResolvedValue([[]]);
});

describe('固定 SheetJS 制品与读写兼容', () => {
  test('官方版本和真实制品校验一致', () => {
    expect(XLSX.version).toBe('0.20.3');
    expect(() => verifyVendor()).not.toThrow();
  });

  test('损坏或缺失的制品必须拒绝', () => {
    const filePath = path.join(tempDir, 'invalid.tgz');
    fs.writeFileSync(filePath, Buffer.from('not-a-package'));
    expect(() => verifyVendor(filePath)).toThrow('SHA-256');
    expect(() => verifyVendor(path.join(tempDir, 'missing.tgz'))).toThrow();
  });

  test.each([
    ['apple_ids', 'apple_ids_import_template.xlsx'],
    ['recipients', 'recipients_import_template.xlsx'],
  ])('现有 %s 模板可读取', (type, filename) => {
    const parsed = parseExcelFile(path.join(__dirname, '../templates', filename), type);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0].rowNumber).toBe(2);
  });

  test('取机人模板包含独立渠道列且示例渠道保持空白', () => {
    const filePath = path.join(__dirname, '../templates/recipients_import_template.xlsx');
    const book = XLSX.readFile(filePath);
    const rows = XLSX.utils.sheet_to_json(book.Sheets.Recipients, { header: 1, defval: '' });
    expect(rows[0]).toEqual(['姓', '名', '身份证号', '标签', '渠道']);
    expect(rows.slice(1).every(row => row[4] === '')).toBe(true);
  });

  test('中文表头、前导零、空值和原始行号保持不变', () => {
    const file = workbookFile([
      ['Apple ID', '密码', '备注名称', '国家地区', '未知列'],
      [' first@example.invalid ', '00123456', '', '中国', '忽略'],
      [],
      ['second@example.invalid', '00000001', '测试', '', '忽略'],
    ]);
    expect(parseExcelFile(file, 'apple_ids')).toEqual([
      {
        rowNumber: 2,
        sheetName: 'Apple IDs',
        issues: [],
        data: {
          appleId: 'first@example.invalid',
          password: '00123456',
          country: '中国',
        },
      },
      {
        rowNumber: 4,
        sheetName: 'Apple IDs',
        issues: [],
        data: {
          appleId: 'second@example.invalid',
          password: '00000001',
          notes: '测试',
        },
      },
    ]);
  });

  test('原型继承名称不是已批准的表头', () => {
    const file = workbookFile([
      ['Apple ID', '密码', '__proto__', 'constructor', 'toString'],
      ['sample@example.invalid', '00123456', 'bad', 'bad', 'bad'],
    ]);
    expect(parseExcelFile(file, 'apple_ids')[0].data).toEqual({
      appleId: 'sample@example.invalid',
      password: '00123456',
    });
    expect({}.polluted).toBeUndefined();
  });

  test('错误工作表、无数据、畸形 ZIP 被拒绝', () => {
    expect(() => parseExcelFile(workbookFile([['a'], ['b']], '错误工作表'), 'apple_ids')).toThrow(
      '未找到'
    );
    expect(() => parseExcelFile(workbookFile([['Apple ID', '密码']]), 'apple_ids')).toThrow(
      '没有可导入资料'
    );
    const badFile = path.join(tempDir, 'malformed.xlsx');
    fs.writeFileSync(badFile, Buffer.from([0x50, 0x4b, 3, 4, 0, 0]));
    expect(() => parseExcelFile(badFile, 'apple_ids')).toThrow();
  });

  test('无效邮箱与不完整密保保留行级验证', () => {
    const result = previewImportData(
      workbookFile([
        ['Apple ID', '密码', '密保问题1'],
        ['bad', '', '仅一个问题'],
      ]),
      'apple_ids'
    );
    expect(result.summary).toEqual({ total: 1, valid: 0, invalid: 1 });
    expect(result.preview[0].errors.map(item => item.field)).toEqual([
      'appleId',
      'password',
      'securityQa',
    ]);
  });

  test('取机人中文列映射和联系方式、身份证、枚举校验保持不变', () => {
    const file = workbookFile(
      [
        ['姓', '名', '身份证号', '手机号', '邮箱', '绑定 Apple ID', '渠道', '状态'],
        [
          '测',
          '试',
          '110101199001010001',
          '13800000000',
          'sample@example.invalid',
          'sample@example.invalid',
          '合作渠道甲',
          '未使用',
        ],
      ],
      'Recipients'
    );
    const valid = previewImportData(file, 'recipients');
    expect(valid.summary).toEqual({ total: 1, valid: 1, invalid: 0 });
    expect(valid.preview[0].data.idCardNumber).toBe('110101199001010001');
    expect(valid.preview[0].data.channel).toBe('合作渠道甲');
    expect(validateRecipient({}).map(item => item.field)).toEqual([
      'lastName',
      'firstName',
      'idCardNumber',
    ]);
    expect(
      validateRecipient({
        lastName: '姓'.repeat(51),
        firstName: '名'.repeat(50),
        idCardNumber: 'bad',
        phone: 'bad',
        email: 'bad',
        appleId: 'bad',
        channel: '渠'.repeat(101),
        status: 'bad',
      }).map(item => item.field)
    ).toEqual([
      'lastName',
      'firstName',
      'idCardNumber',
      'phone',
      'email',
      'appleId',
      'channel',
      'status',
    ]);
  });

  test('Apple ID 必填和枚举校验保持不变', () => {
    expect(validateAppleId({}).map(item => item.field)).toEqual(['appleId', 'password']);
    expect(
      validateAppleId({
        appleId: 'sample@example.invalid',
        password: 'synthetic-value',
        status: 'bad',
      }).map(item => item.field)
    ).toEqual(['status']);
  });
});

describe('Excel 会话与导出安全回归（模型桩，无数据库）', () => {
  test('真实上传路由保留权限、扩展名和 10 MB 限制', async () => {
    const express = require('express');
    const { PERMISSIONS } = require('../src/constants/business');
    const app = express();
    app.use((req, _res, next) => {
      if (req.headers['x-synthetic-permission']) {
        req.user = {
          id: 1,
          permissions:
            req.headers['x-synthetic-permission'] === 'allowed'
              ? [PERMISSIONS.APPLE_IDS_IMPORT]
              : [],
        };
      }
      next();
    });
    app.use('/api/import', require('../src/routes/importRoutes'));
    app.use((error, _req, res, _next) => {
      res.status(error.statusCode || 400).json({ code: error.code || 'VALIDATION_ERROR' });
    });
    const server = await new Promise(resolve => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const url = `http://127.0.0.1:${server.address().port}/api/import/preview?type=apple_ids`;
    const uploadDir = path.join(__dirname, '../uploads/import');
    const initialUploads = fs.readdirSync(uploadDir).sort();
    const send = (bytes, filename, permission = 'allowed') => {
      const body = new FormData();
      body.append('type', 'apple_ids');
      body.append('file', new Blob([bytes]), filename);
      return fetch(url, {
        method: 'POST',
        headers: { 'x-synthetic-permission': permission },
        body,
      });
    };
    try {
      const denied = await send('not-an-excel', 'test.xlsx', 'denied');
      expect(denied.status).toBe(403);
      expect((await denied.json()).error.code).toBe('FORBIDDEN');
      const wrongExtension = await send('not-an-excel', 'test.csv');
      expect(wrongExtension.status).toBe(400);
      await wrongExtension.json();
      const oversized = await send(Buffer.alloc(10 * 1024 * 1024 + 1), 'oversized.xlsx');
      expect(oversized.status).toBe(400);
      expect((await oversized.json()).code).toBe('LIMIT_FILE_SIZE');
      const maliciousFields = new FormData();
      maliciousFields.append('items[4294967294]', 'synthetic');
      const rejectedFields = await fetch(url, {
        method: 'POST',
        headers: { 'x-synthetic-permission': 'allowed' },
        body: maliciousFields,
      });
      expect(rejectedFields.status).toBe(400);
      expect((await rejectedFields.json()).code).toBe('LIMIT_FIELD_ARRAY_INDEX');
      const file = workbookFile([
        ['Apple ID', '密码'],
        ['sample@example.invalid', 'synthetic-value'],
      ]);
      const accepted = await send(fs.readFileSync(file), 'test.xlsx');
      expect(accepted.status).toBe(200);
      expect((await accepted.json()).data.summary.valid).toBe(1);
      expect(fs.readdirSync(uploadDir).sort()).toEqual(initialUploads);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('1000 行可预览且不返回密码或完整预览数据', async () => {
    const { filePath, result } = await previewRows(1000);
    expect(result.summary).toMatchObject({ total: 1000, valid: 1000, invalid: 0, conflicts: 0 });
    expect(result.preview).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('synthetic-value');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  test('10001 行拒绝且 finally 清理上传文件', async () => {
    await expect(previewRows(10001)).rejects.toMatchObject({ statusCode: 400 });
  });

  test('不能跨用户执行，事务失败也不能重放会话', async () => {
    const { result } = await previewRows();
    const body = { type: 'apple_ids', sessionToken: result.sessionToken };
    await expect(executeImport({ body, user: { id: 2 } }, response())).rejects.toMatchObject({
      statusCode: 400,
    });
    sequelize.transaction.mockRejectedValueOnce(new Error('synthetic-db-error'));
    await expect(executeImport({ body, user: { id: 1 } }, response())).rejects.toMatchObject({
      code: 'DATABASE_ERROR',
    });
    await expect(executeImport({ body, user: { id: 1 } }, response())).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(sequelize.transaction).toHaveBeenCalledTimes(1);
  });

  test('并发重复执行最多进入一个事务', async () => {
    const { result } = await previewRows();
    const req = {
      body: { type: 'apple_ids', sessionToken: result.sessionToken },
      user: { id: 1, permissions: ['apple_ids.import'] },
    };
    sequelize.transaction.mockImplementationOnce(callback => callback({ synthetic: true }));
    AppleId.findOne.mockResolvedValue(null);
    AppleId.create.mockResolvedValue({ id: 1 });
    const outcomes = await Promise.allSettled([
      executeImport(req, response()),
      executeImport(req, response()),
    ]);
    expect(outcomes.map(item => item.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(sequelize.transaction).toHaveBeenCalledTimes(1);
    expect(AppleId.create).toHaveBeenCalledTimes(1);
  });

  test('订单导出使用新库且公式文本不变成可执行公式、不含敏感字段', async () => {
    Order.findAll.mockResolvedValue([
      {
        toJSON: () => ({
          orderNumber: 'W1234567890',
          appleId: 'sample@example.invalid',
          tag: '=1+1',
          status: 'payment_received',
          paymentStatus: 'paid',
          orderAmount: '21998.00',
          orderAmountPriceVersion: 'cn-iphone18-20260921',
          officialOrderAmount: '8999.00',
          officialOrderAmountCurrency: 'CNY',
          applePassword: 'synthetic-secret',
          orderUrl: 'https://example.invalid/private',
        }),
      },
    ]);
    const res = response();
    await exportOrders({ query: {}, user: { id: 1 } }, res);
    const book = XLSX.read(res.send.mock.calls[0][0], { type: 'buffer' });
    const sheet = book.Sheets['订单'];
    const data = XLSX.utils.sheet_to_json(sheet);
    expect(data[0]['订单状态']).toBe('待确认');
    expect(data[0]['标签']).toBe("'=1+1");
    expect(data[0]['订单金额']).toBe('21998.00');
    expect(data[0]['金额来源']).toBe('按官方售价计算');
    expect(data[0]).not.toHaveProperty('官网金额');
    expect(JSON.stringify(data)).not.toMatch(/synthetic-secret|private/);
    expect(Object.values(sheet).filter(cell => cell?.f)).toHaveLength(0);
  });

  test.each([
    ['unknown', '待确认'],
    ['confirmed', '订单已确认'],
    ['payment_timeout', '付款超时'],
    ['processing', '处理中'],
    ['ready_for_pickup', '可取货'],
    ['picked_up', '已取货'],
    ['partially_cancelled', '部分取消'],
    ['cancelled', '已取消'],
    ['expired', '已过期'],
    [null, '待确认'],
    ['invalid_status', '待确认'],
    ['toString', '待确认'],
  ])('选中订单 Excel 状态 %s 输出页面中文 %s', async (status, label) => {
    Order.findAll.mockResolvedValue([
      {
        toJSON: () => ({
          id: 41,
          orderNumber: 'W1234567890',
          products: [],
          emailOrderStatus: status === 'payment_timeout' ? 'confirmed' : status,
          emailPaymentStatus: 'unknown',
          orderDate: status === 'payment_timeout' ? new Date('2020-01-01T00:00:00Z') : null,
        }),
      },
    ]);
    const res = response();
    await exportOrders(
      {
        query: { orderIds: '[41]', fields: '["emailOrderStatus"]' },
        user: { id: 1, role: 'admin' },
      },
      res
    );
    const book = XLSX.read(res.send.mock.calls[0][0], { type: 'buffer' });
    expect(XLSX.utils.sheet_to_json(book.Sheets['订单'])).toEqual([{ 订单状态: label }]);
  });

  test('选中订单按字段白名单导出且不包含未选择或敏感字段', async () => {
    Order.findAll.mockResolvedValue([
      {
        toJSON: () => ({
          id: 41,
          orderNumber: 'W1234567890',
          products: [{ name: '=HYPERLINK("bad")', quantity: 2 }],
          emailPickupInfo: {
            storeName: 'Apple 长沙',
            pickupDate: '2026-09-22',
            startTime: '18:15',
            endTime: '18:30',
            appointmentMode: 'scheduled',
          },
          applePassword: 'synthetic-secret',
          orderUrl: 'https://example.invalid/private',
        }),
      },
    ]);
    const res = response();

    await exportOrders(
      {
        query: {
          orderIds: JSON.stringify([41]),
          fields: JSON.stringify([
            'systemOrderId',
            'orderNumber',
            'products',
            'emailPickupStore',
            'emailPickupSchedule',
          ]),
        },
        user: { id: 1, role: 'admin' },
      },
      res
    );

    const book = XLSX.read(res.send.mock.calls[0][0], { type: 'buffer' });
    const data = XLSX.utils.sheet_to_json(book.Sheets['订单']);
    expect(data).toEqual([
      {
        '系统订单 ID': 41,
        官网订单号: 'W1234567890',
        商品信息: '\'=HYPERLINK("bad") ×2',
        取货门店: 'Apple 长沙',
        取货安排: '2026-09-22 18:15–18:30',
      },
    ]);
    expect(JSON.stringify(data)).not.toMatch(/synthetic-secret|private|Apple ID/);
  });

  test.each([
    ['READY_FOR_PICKUP | RETURN_STARTED', '可取货 | 已发起退货'],
    ['PICKUP_READY | CANCELED | PICK_UP_CANCELLED', '可取货 | 已取消 | 取货已取消'],
    ['UNKNOWN_STATUS', 'UNKNOWN_STATUS'],
    ['=1+1', "'=1+1"],
    [null, '尚未更新'],
    ['toString', 'toString'],
  ])('Excel 官网状态 %s 与预约字段表头正确输出', async (status, label) => {
    Order.findAll.mockResolvedValue([
      {
        toJSON: () => ({
          id: 41,
          products: [],
          officialRawStatus: status,
          emailPickupDate: '2026-09-22',
          emailPickupInfo: { storeName: 'Apple 长沙' },
        }),
      },
    ]);
    const res = response();
    await exportOrders(
      {
        query: {
          orderIds: '[41]',
          fields: JSON.stringify([
            'officialOrderStatus',
            'emailPickupStore',
            'emailPickupDate',
            'emailPickupSchedule',
          ]),
        },
        user: { id: 1, role: 'admin' },
      },
      res
    );
    const book = XLSX.read(res.send.mock.calls[0][0], { type: 'buffer' });
    expect(XLSX.utils.sheet_to_json(book.Sheets['订单'])).toEqual([
      {
        官网订单状态: label,
        取货门店: 'Apple 长沙',
        取货日期: '2026-09-22',
        取货安排: '2026-09-22',
      },
    ]);
  });

  test('选中订单导出拒绝空字段、未知字段和不可见 ID 集合', async () => {
    const baseRequest = { user: { id: 1, role: 'admin' } };
    await expect(
      exportOrders({ ...baseRequest, query: { orderIds: '[1]', fields: '[]' } }, response())
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      exportOrders(
        { ...baseRequest, query: { orderIds: '[1]', fields: '["orderUrl"]' } },
        response()
      )
    ).rejects.toMatchObject({ statusCode: 400 });

    Order.findAll.mockResolvedValue([]);
    await expect(
      exportOrders(
        {
          ...baseRequest,
          query: { orderIds: '[1]', fields: '["systemOrderId"]' },
        },
        response()
      )
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test('非管理员导出不能用 includeSensitive 绕过脱敏', async () => {
    Recipient.findAll.mockResolvedValue([
      {
        lastName: '测',
        firstName: '试',
        phone: '13800000000',
        idCardNumber: '110101199001010001',
        streetAddress: 'synthetic-address',
        tag: '=1+1',
        channel: '=2+2',
        appleAccount: { appleId: 'sample@example.invalid', password: 'synthetic-secret' },
      },
    ]);
    const res = response();
    await expect(
      exportRecipients(
        { query: { includeSensitive: 'true' }, user: { id: 2, role: 'operator' } },
        res
      )
    ).rejects.toMatchObject({ statusCode: 403 });
    await exportRecipients({ query: {}, user: { id: 2, role: 'operator' } }, res);
    const book = XLSX.read(res.send.mock.calls[0][0], { type: 'buffer' });
    const data = XLSX.utils.sheet_to_json(book.Sheets['取机人数据']);
    expect(data[0]['密码']).toBe('******');
    expect(data[0]['街道地址']).toBe('详细地址已隐藏');
    expect(data[0].TAG).toBe("'=1+1");
    expect(data[0]['渠道']).toBe("'=2+2");
    expect(JSON.stringify(data)).not.toMatch(
      /synthetic-secret|synthetic-address|110101199001010001/
    );
  });

  test('敏感取机人导出为无表头逐行 TXT 录入信息', async () => {
    Recipient.findAll.mockResolvedValue([
      {
        lastName: '测',
        firstName: '试甲',
        phone: '13800000000',
        email: '13800000000@vvv8.net',
        idCardNumber: '110101199001010001',
        tag: '北京-负责人甲',
        appleAccount: { appleId: 'a@example.invalid', password: 'synthetic-a' },
      },
      {
        lastName: '测',
        firstName: '试乙',
        phone: '13900000000',
        idCardNumber: '110101199001010002',
        tag: '上海-负责人乙',
        appleAccount: { appleId: 'b@example.invalid', password: 'synthetic-b' },
      },
    ]);
    const res = response();
    await exportRecipients(
      {
        query: { includeSensitive: 'true' },
        user: { id: 1, permissions: ['recipients.export_sensitive'] },
      },
      res
    );
    const text = res.send.mock.lastCall[0].toString('utf8');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/plain; charset=utf-8');
    expect(text.split('\n')).toHaveLength(2);
    expect(text).toMatch(/^a@example\.invalid,synthetic-a,/);
    expect(text).toContain('\nb@example.invalid,synthetic-b,');
    expect(text).not.toContain('信息导入模板');
  });
});
