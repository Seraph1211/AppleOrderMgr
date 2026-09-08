/* eslint-disable camelcase -- 合成数据保留既有接口字段 */
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
  AppleId: { findOne: jest.fn(), create: jest.fn() },
  Recipient: { findAll: jest.fn() },
  Order: { findAll: jest.fn() },
  sequelize: { transaction: jest.fn() },
}));
jest.mock('../src/services/crawler/refreshJobService', () => ({}));

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
  return { json: jest.fn(), send: jest.fn(), setHeader: jest.fn() };
}

async function previewRows(count = 1) {
  const rows = [['Apple ID', '密码']];
  for (let i = 0; i < count; i++) rows.push([`synthetic-${i}@example.invalid`, 'synthetic-value']);
  const filePath = workbookFile(rows);
  const res = response();
  await previewImport(
    { file: { path: filePath }, body: { type: 'apple_ids' }, user: { id: 1 } },
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
        data: {
          appleId: 'first@example.invalid',
          password: '00123456',
          nickname: null,
          country: '中国',
        },
      },
      {
        rowNumber: 4,
        data: {
          appleId: 'second@example.invalid',
          password: '00000001',
          nickname: '测试',
          country: null,
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
      '不存在'
    );
    expect(() => parseExcelFile(workbookFile([['Apple ID', '密码']]), 'apple_ids')).toThrow(
      '一行数据'
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
        ['姓', '名', '身份证号', '手机号', '邮箱', '绑定 Apple ID', '状态'],
        [
          '测',
          '试',
          '110101199001010001',
          '13800000000',
          'sample@example.invalid',
          'sample@example.invalid',
          '未使用',
        ],
      ],
      'Recipients'
    );
    const valid = previewImportData(file, 'recipients');
    expect(valid.summary).toEqual({ total: 1, valid: 1, invalid: 0 });
    expect(valid.preview[0].data.idCardNumber).toBe('110101199001010001');
    expect(validateRecipient({}).map(item => item.field)).toEqual([
      'lastName',
      'firstName',
      'idCardNumber',
    ]);
    expect(
      validateRecipient({
        lastName: '两个',
        firstName: '名'.repeat(50),
        idCardNumber: 'bad',
        phone: 'bad',
        email: 'bad',
        appleId: 'bad',
        status: 'bad',
      }).map(item => item.field)
    ).toEqual(['lastName', 'firstName', 'idCardNumber', 'phone', 'email', 'appleId', 'status']);
  });

  test('Apple ID 必填和枚举校验保持不变', () => {
    expect(validateAppleId({}).map(item => item.field)).toEqual(['appleId', 'password']);
    expect(
      validateAppleId({
        appleId: 'sample@example.invalid',
        password: 'synthetic-value',
        isModified: 'bad',
        status: 'bad',
      }).map(item => item.field)
    ).toEqual(['isModified', 'status']);
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
    expect(result.summary).toEqual({ total: 1000, valid: 1000, invalid: 0 });
    expect(result.preview).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('synthetic-value');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  test('1001 行拒绝且 finally 清理上传文件', async () => {
    await expect(previewRows(1001)).rejects.toMatchObject({ statusCode: 400 });
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
    const req = { body: { type: 'apple_ids', sessionToken: result.sessionToken }, user: { id: 1 } };
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
    expect(data[0]['标签']).toBe("'=1+1");
    expect(data[0]['官网金额']).toBe('8999.00');
    expect(JSON.stringify(data)).not.toMatch(/synthetic-secret|private/);
    expect(Object.values(sheet).filter(cell => cell?.f)).toHaveLength(0);
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
        appleAccount: { appleId: 'sample@example.invalid', password: 'synthetic-secret' },
      },
    ]);
    const res = response();
    await exportRecipients(
      { query: { includeSensitive: 'true' }, user: { id: 2, role: 'operator' } },
      res
    );
    const book = XLSX.read(res.send.mock.calls[0][0], { type: 'buffer' });
    const data = XLSX.utils.sheet_to_json(book.Sheets['取机人数据']);
    expect(data[0]['密码']).toBe('******');
    expect(data[0]['街道地址']).toBe('详细地址已隐藏');
    expect(data[0].TAG).toBe("'=1+1");
    expect(JSON.stringify(data)).not.toMatch(
      /synthetic-secret|synthetic-address|110101199001010001/
    );
  });
});
