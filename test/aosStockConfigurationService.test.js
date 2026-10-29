/* eslint-disable no-magic-numbers */
jest.mock('../src/services/monitorLogBlockStore', () => ({ readBlock: jest.fn() }));
const blocks = require('../src/services/monitorLogBlockStore');
const service = require('../src/services/aosStockConfigurationService');
const signals = require('../src/services/aosSignalPolicy');
const at = Date.parse('2026-10-29T12:17:40Z');
const raw = (id, offset, text, seconds = 0) => ({
  id,
  deviceId: 'dev',
  localId: 'local',
  fileId: 'file',
  byteOffset: String(offset),
  partIndex: 0,
  parseState: 'parsed',
  loggedAt: new Date(at - 10000 + seconds * 1000).toISOString(),
  message: `2026-10-29 20:17:${String(30 + seconds).padStart(2, '0')}.000 [2][001]A-${text}`,
});
const start = raw('start', 1, '开始下单 iPhone Duo 星光白色 512G (x1)');
const city = raw('city', 2, '消息24093001: R637, 2, , 0', 1);
const anchor = { ...signals.parseEntry(raw('stock', 3, '消息20110501...', 2), at), loggedAt: at };
const index = row => ({ id: row.id, byteOffset: row.byteOffset, loggedAt: row.loggedAt });
function models() {
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const query = jest.fn(sql => {
    if (sql.includes("kind='start'")) return Promise.resolve([index(start)]);
    if (sql.includes("kind='city'")) return Promise.resolve([index(city)]);
    if (sql.includes('WITH wanted'))
      return Promise.resolve([
        {
          id: 'block',
          locations: [
            { id: 'start', ordinal: 0 },
            { id: 'city', ordinal: 1 },
          ],
        },
      ]);
    return Promise.resolve([]);
  });
  return {
    sequelize: {
      query,
      transaction: jest.fn((_options, work) => {
        if (typeof _options === 'function') return _options(transaction);
        return work(transaction);
      }),
    },
  };
}

beforeEach(() => blocks.readBlock.mockResolvedValue([start, city]));

test('历史补证按原文件和完整任务标识验证原始片段，查询限定三天及检测前', async () => {
  const m = models();
  const result = await service.load(m, anchor);
  expect(result.map(row => row.kind)).toEqual(['configStart', 'configCity']);
  const queries = m.sequelize.query.mock.calls.filter(([sql]) => sql.includes("kind='start'"));
  expect(queries[0][1].replacements.from.getTime()).toBe(at - 3 * 86400000);
  expect(queries[0][1].replacements.to.getTime()).toBe(at);
  expect(m.sequelize.transaction.mock.calls[0][0]).toEqual({
    readOnly: true,
    isolationLevel: 'REPEATABLE READ',
  });
});

test('同编号但完整任务后缀不同的原文不能补证，原片段缺失同样拒绝', async () => {
  blocks.readBlock.mockResolvedValue([
    { ...start, message: start.message.replace(']A-', ']B-') },
    city,
  ]);
  await expect(service.load(models(), anchor)).rejects.toThrow('STOCK_CONFIGURATION_LOAD_FAILED');
  blocks.readBlock.mockResolvedValue([]);
  await expect(service.load(models(), anchor)).rejects.toThrow();
});

test('最新启动原文不完整时不借较早配置，最多保留无规格的新启动', async () => {
  blocks.readBlock.mockResolvedValue([
    {
      ...start,
      message: start.message.replace('开始下单 iPhone Duo 星光白色 512G (x1)', '开始监控库存状态'),
    },
    city,
  ]);
  const result = await service.load(models(), anchor);
  expect(result[0].model).toBeUndefined();
});

test('城市形状超过上限或SQL失败不返回部分可信配置', async () => {
  const m = models();
  m.sequelize.query.mockImplementation(sql => {
    if (sql.includes("kind='start'")) return Promise.resolve([index(start)]);
    if (sql.includes("kind='city'")) return Promise.resolve(Array(33).fill(index(city)));
    return Promise.resolve([]);
  });
  await expect(service.load(m, anchor)).rejects.toThrow();
  m.sequelize.query.mockRejectedValue(new Error('timeout'));
  await expect(service.load(m, anchor)).rejects.toThrow();
});

test('短事务行锁合并配置保留实时字段及较新启动，空补证不写入', async () => {
  const m = models();
  const future = {
    ...anchor,
    id: 'future',
    kind: 'configStart',
    byteOffset: '99',
    loggedAt: at + 1000,
  };
  const row = {
    body: { untouched: 1, configuration: [future] },
    update: jest.fn().mockResolvedValue(),
  };
  m.AosSignalContext = { findByPk: jest.fn().mockResolvedValue(row) };
  await service.merge(m, anchor, [signals.parseEntry(start, at)]);
  expect(row.update.mock.calls[0][0].body.untouched).toBe(1);
  expect(row.update.mock.calls[0][0].body.configuration.at(-1).id).toBe('future');
  expect(m.AosSignalContext.findByPk.mock.calls[0][1].lock).toBe('UPDATE');
  row.update.mockClear();
  await service.merge(m, anchor, []);
  expect(row.update).not.toHaveBeenCalled();
});

test('真实无后缀启动按原文件与方括号任务身份关联，显式不同后缀仍拒绝', async () => {
  blocks.readBlock.mockResolvedValue([
    { ...start, message: start.message.replace(']A-开始', ']开始') },
    city,
  ]);
  const result = await service.load(models(), anchor);
  expect(result[0].taskKey).toBe(anchor.taskKey);
  expect(result[0].configurationBare).toBe(true);
  expect(result[0].configurationKey).toBe(anchor.configurationKey);
});

test('原日志旧表回退仍验证每个位置，不把缺失当成零', async () => {
  const m = models();
  blocks.readBlock.mockResolvedValue([]);
  m.MonitorLogEntry = { findAll: jest.fn().mockResolvedValue([start, city]) };
  expect(await service.load(m, anchor)).toHaveLength(2);
  expect(m.MonitorLogEntry.findAll).toHaveBeenCalledTimes(1);
});

test('补证每轮一个、成功合并后退避，既有业务字段保留且无需库存锁', async () => {
  const m = models();
  const ref = { anchor, reason: 'STOCK_SCOPE_UNKNOWN', item: { city: '天津' } };
  m.AosAccountConfigEvent = {};
  m.InventoryRuntime = {
    findByPk: jest.fn().mockResolvedValue({ body: { aosStockTasks: { refs: [ref] } } }),
  };
  const row = { body: { retained: true }, update: jest.fn().mockResolvedValue() };
  m.AosSignalContext = { findByPk: jest.fn().mockResolvedValue(row) };
  expect(await service.warm(m, at)).toEqual(anchor);
  expect(await service.warm(m, at + 1000)).toBeUndefined();
  expect(row.update).toHaveBeenCalledTimes(1);
  expect(row.update.mock.calls[0][0].body.retained).toBe(true);
  expect(m.sequelize.query.mock.calls.some(([sql]) => sql.includes("kind='city'"))).toBe(false);
});
