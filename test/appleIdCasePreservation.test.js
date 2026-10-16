/* eslint-disable camelcase, no-magic-numbers -- 合成 API 与导入样本。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');
jest.mock('../src/models', () => ({
  sequelize: {
    transaction: jest.fn(),
    fn: jest.fn((name, ...args) => ({ name, args })),
    col: jest.fn(column => ({ column })),
    where: jest.fn((expression, value) => ({ expression, value })),
  },
  AppleId: {
    findOne: jest.fn(),
    findByPk: jest.fn(),
    findAll: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  Recipient: {},
  ProxyEvent: { create: jest.fn() },
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('../src/services/profileBindingService', () => ({ lockProfiles: jest.fn() }));
const { AppleId, sequelize, ProxyEvent } = require('../src/models');
const { parseExcelFile } = require('../src/services/importService');
const { buildImportPlan, applyImportPlan } = require('../src/services/profileImportService');
const { parsePoolAccounts } = require('../src/utils/proxyOrderInput');
const proxy = require('../src/services/proxyOrderService');
const controller = require('../src/controllers/appleIdController');
const user = { id: 1, permissions: ['apple_ids.import', 'apple_ids.edit'] };
const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
const row = (appleId, extra = {}, rowNumber = 2) => ({
  fileName: 'synthetic.xlsx',
  sheetName: 'Apple IDs',
  rowNumber,
  data: { appleId, password: 'Synthetic-pass', ...extra },
});
const existing = {
  id: 19,
  appleId: 'Original.Case@Example.COM',
  password: 'Synthetic-pass',
  notes: '原备注',
  country: '中国',
  status: '使用中',
  securityQa: Object.fromEntries(
    [1, 2, 3].flatMap(i => [
      [`question${i}`, `q${i}`],
      [`answer${i}`, `a${i}`],
    ])
  ),
};
const profiles = { accounts: [existing], recipients: [] };
const empty = { accounts: [], recipients: [] };

beforeEach(() => {
  jest.clearAllMocks();
  sequelize.transaction.mockImplementation(work => work({ LOCK: { UPDATE: 'UPDATE' } }));
  AppleId.findOne.mockResolvedValue(null);
  AppleId.findAll.mockResolvedValue([]);
  AppleId.create.mockImplementation(data =>
    Promise.resolve({ id: 23, toJSON: () => ({ id: 23, ...data }) })
  );
});

describe('API 新建和编辑保留账号原文', () => {
  test('新建保留源大小写，trim后独立小写匹配', async () => {
    const res = response();
    await controller.createAppleId(
      { body: { apple_id: '  Mixed.Name@Example.COM  ', password: 'Synthetic-pass' }, user },
      res
    );
    expect(AppleId.create).toHaveBeenCalledWith(
      expect.objectContaining({ appleId: 'Mixed.Name@Example.COM' }),
      expect.any(Object)
    );
    expect(sequelize.where).toHaveBeenCalledWith(
      { name: 'lower', args: [{ name: 'trim', args: [{ column: 'apple_id' }] }] },
      'mixed.name@example.com'
    );
    expect(res.json.mock.calls[0][0].data.apple_id).toBe('Mixed.Name@Example.COM');
  });

  test('跨大小写已有账号整条拒绝，账号和凭据不更新', async () => {
    AppleId.findOne.mockResolvedValue(existing);
    await expect(
      controller.createAppleId(
        { body: { apple_id: 'ORIGINAL.CASE@example.com', password: 'new-pass' }, user },
        response()
      )
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(AppleId.create).not.toHaveBeenCalled();
    expect(AppleId.update).not.toHaveBeenCalled();
  });

  test('普通更新备注不写账号或凭据，即使请求附带不同大小写apple_id', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    AppleId.findByPk.mockResolvedValue({ ...existing, update, toJSON: () => ({ ...existing }) });
    await controller.updateAppleId(
      {
        params: { id: existing.id },
        body: { notes: '修改', apple_id: 'original.case@example.com' },
        user,
      },
      response()
    );
    expect(update).toHaveBeenCalledWith({ notes: '修改' }, expect.any(Object));
  });
});

describe('Excel 与腾讯账号表解析', () => {
  test.each(['Apple IDs', '26年AppleID大陆'])('工作表 %s 保留首尾trim后的大小写', sheetName => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-case-'));
    try {
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(
        book,
        XLSX.utils.aoa_to_sheet([
          ['Apple ID', '密码'],
          ['  Mixed.Source@Example.COM  ', 'Synthetic-pass'],
        ]),
        sheetName
      );
      const file = path.join(dir, 'synthetic.xlsx');
      XLSX.writeFile(book, file);
      expect(parseExcelFile(file, 'apple_ids')[0].data.appleId).toBe('Mixed.Source@Example.COM');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('普通导入身份匹配与原文存储分离', () => {
  test('多个来源大小写变体归一，新增采用第一个原文且无大小写冲突', async () => {
    const plan = buildImportPlan(
      [row('Mixed.Source@Example.COM'), row('mixed.source@example.com', {}, 3)],
      'apple_ids',
      empty
    );
    expect(plan.summary).toMatchObject({ records: 1, conflicts: 0 });
    expect(plan.writes[0].data.appleId).toBe('Mixed.Source@Example.COM');
    expect(plan.records[0].sources).toHaveLength(2);
    await applyImportPlan(plan, { user }, {});
    expect(AppleId.create).toHaveBeenCalledTimes(1);
    expect(AppleId.create).toHaveBeenCalledWith(
      expect.objectContaining({ appleId: 'Mixed.Source@Example.COM' }),
      expect.any(Object)
    );
  });

  test('跨大小写命中已有账号只算重复，裁定不能重命名或触碰其他字段', async () => {
    const plan = buildImportPlan([row('ORIGINAL.CASE@example.com')], 'apple_ids', profiles, {
      'g0:appleId': 'source0',
    });
    expect(plan.summary).toMatchObject({ records: 1, conflicts: 0 });
    expect(plan.records[0].action).toBe('重复');
    expect(plan.writes[0].data.appleId).toBe(existing.appleId);
    expect(plan.writes[0].changed).toEqual([]);
    expect(await applyImportPlan(plan, { user }, {})).toMatchObject({
      imported: 0,
      updated: 0,
      skipped: 1,
    });
    expect(AppleId.create).not.toHaveBeenCalled();
    expect(AppleId.update).not.toHaveBeenCalled();
  });

  test('已有账号备注冲突仍须裁定，只写备注不重加密密码/密保', async () => {
    const rows = [row('original.case@example.com', { notes: '新备注' })];
    const pending = buildImportPlan(rows, 'apple_ids', profiles);
    expect(pending.conflicts.map(item => item.id)).toEqual(['g0:notes']);
    await expect(applyImportPlan(pending, { user }, {})).rejects.toMatchObject({ statusCode: 409 });
    const accepted = buildImportPlan(rows, 'apple_ids', profiles, { 'g0:notes': 'source0' });
    expect(accepted.writes[0].changed).toEqual(['notes']);
    await applyImportPlan(accepted, { user }, {});
    expect(AppleId.update).toHaveBeenCalledWith(
      { notes: '新备注' },
      expect.objectContaining({ fields: ['notes'], where: { id: 19 } })
    );
  });

  test('新来源账号只有大小写不同，但密码差异不会被静默合并', () => {
    const plan = buildImportPlan(
      [row('Mixed@Example.COM'), row('mixed@example.com', { password: 'different-pass' }, 3)],
      'apple_ids',
      empty
    );
    expect(plan.summary.records).toBe(1);
    expect(plan.conflicts.map(item => item.id)).toEqual(['g0:password']);
  });

  test('已有账号不同密码仍要求选择来源，未授予edit不能覆盖', async () => {
    const rows = [row('ORIGINAL.CASE@example.com', { password: 'different-pass' })];
    const plan = buildImportPlan(rows, 'apple_ids', profiles, { 'g0:password': 'source0' });
    expect(plan.writes[0].changed).toEqual(['password']);
    await expect(
      applyImportPlan(plan, { user: { permissions: ['apple_ids.import'] } }, {})
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(AppleId.update).not.toHaveBeenCalled();
  });
});

describe('代抢池原文与去重', () => {
  test.each([' ', '\t', '----', ','])('分隔符 %s 不改变账号大小写', separator => {
    expect(parsePoolAccounts(`  Pool.Mixed@Example.COM${separator}Synthetic-pass  `)).toEqual([
      { appleId: 'Pool.Mixed@Example.COM', password: 'Synthetic-pass' },
    ]);
  });
  test('同批次异大小写身份仍拒绝', () => {
    expect(() =>
      parsePoolAccounts(
        'Pool.Mixed@Example.COM Synthetic-pass\npool.mixed@example.com Synthetic-pass'
      )
    ).toThrow('重复');
  });
  test('代抢池新增保留原文，查库使用lower key', async () => {
    await proxy.changeAccounts(
      'import',
      { text: 'Pool.Mixed@Example.COM Synthetic-pass' },
      user.id
    );
    expect(AppleId.create).toHaveBeenCalledWith(
      expect.objectContaining({ appleId: 'Pool.Mixed@Example.COM', isProxyPool: true }),
      expect.any(Object)
    );
    const condition = sequelize.where.mock.calls[0][1];
    expect(Object.values(condition)[0]).toBeUndefined();
    expect(Object.getOwnPropertySymbols(condition).map(key => condition[key])).toEqual([
      ['pool.mixed@example.com'],
    ]);
  });
  test('已在池内大小写变体+同密码复用，不改写任何账号字段', async () => {
    AppleId.findAll.mockResolvedValue([{ ...existing, isProxyPool: true }]);
    await proxy.changeAccounts(
      'import',
      { text: 'ORIGINAL.CASE@example.com Synthetic-pass' },
      user.id
    );
    expect(AppleId.create).not.toHaveBeenCalled();
    expect(AppleId.update).not.toHaveBeenCalled();
    expect(ProxyEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { accountIds: [19] } }),
      expect.any(Object)
    );
  });
  test.each([
    { isProxyPool: false, password: 'Synthetic-pass' },
    { isProxyPool: true, password: 'wrong-pass' },
  ])('已有归属或密码不同整批拒绝 %#', async values => {
    AppleId.findAll.mockResolvedValue([{ ...existing, ...values }]);
    await expect(
      proxy.changeAccounts('import', { text: 'ORIGINAL.CASE@example.com Synthetic-pass' }, user.id)
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(AppleId.create).not.toHaveBeenCalled();
    expect(AppleId.update).not.toHaveBeenCalled();
    expect(ProxyEvent.create).not.toHaveBeenCalled();
  });
});
