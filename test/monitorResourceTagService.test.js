const { randomUUID } = require('crypto');

jest.mock('../src/models', () => ({
  sequelize: { transaction: jest.fn(), query: jest.fn() },
  AosDevice: { findByPk: jest.fn() },
  MonitorInstance: { findOne: jest.fn() },
  MonitorLogState: { findOne: jest.fn() },
  MonitorResourceTag: { findAll: jest.fn(), findOne: jest.fn(), create: jest.fn() },
}));
jest.mock('../src/services/monitorLogService', () => ({ states: jest.fn() }));
const models = require('../src/models');
const logs = require('../src/services/monitorLogService');
const tags = require('../src/services/monitorResourceTagService');
const deviceId = randomUUID();
const localId = randomUUID();
const body = extra => ({ deviceId, tag: ' 美国主力 ', expectedVersion: 0, ...extra });
const transaction = { LOCK: { UPDATE: 'UPDATE', KEY_SHARE: 'KEY SHARE' } };

describe('监控人工标签服务', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    models.sequelize.transaction.mockImplementation(work => work(transaction));
    models.AosDevice.findByPk.mockResolvedValue({ id: deviceId });
    models.MonitorInstance.findOne.mockResolvedValue({ id: randomUUID() });
    models.MonitorLogState.findOne.mockResolvedValue(null);
    models.MonitorResourceTag.findOne.mockResolvedValue(null);
    models.MonitorResourceTag.create.mockImplementation(row => Promise.resolve(row));
  });
  test('目录附加设备和实例标签，不改原目录字段且缺省空标签', async () => {
    logs.states.mockResolvedValue({
      devices: [
        { id: deviceId, name: 'US Server No.2', enabled: false },
        { id: randomUUID(), name: '无标签' },
      ],
      instances: [{ deviceId, localId, label: '心蓝02', active: false, snapshot: null }],
      first: '2026-01-01',
    });
    models.MonitorResourceTag.findAll.mockResolvedValue([
      { deviceId, localId: null, tag: '美国主力', version: 2 },
      { deviceId, localId, tag: '北京取货', version: 1 },
    ]);
    const result = await tags.states();
    expect(result.devices[0]).toMatchObject({
      name: 'US Server No.2',
      enabled: false,
      tag: '美国主力',
      tagVersion: 2,
    });
    expect(result.devices[1]).toMatchObject({ tag: '', tagVersion: 0 });
    expect(result.instances[0]).toMatchObject({ label: '心蓝02', active: false, tag: '北京取货' });
    expect(result.first).toBe('2026-01-01');
    expect(models.MonitorResourceTag.findAll).toHaveBeenCalledTimes(1);
  });
  test.each([
    { tag: null },
    { tag: 'x'.repeat(101) },
    { tag: '换\n行' },
    { tag: '\t标签' },
    { tag: '标签\u007f' },
    { tag: '标签\u2028' },
    { expectedVersion: -1 },
    { expectedVersion: '0' },
    { unexpected: true },
    { deviceId: 'wrong' },
    { localId: '' },
  ])('拒绝无效标签请求 %p', async changes => {
    await expect(tags.save(1, body(changes))).rejects.toMatchObject({ statusCode: 400 });
    expect(models.MonitorResourceTag.create).not.toHaveBeenCalled();
  });
  test('首次保存去掉首尾空格并绑定服务器资源', async () => {
    const saved = await tags.save(1, body());
    expect(saved).toEqual({ deviceId, localId: null, tag: '美国主力', tagVersion: 1 });
    expect(models.sequelize.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      expect.objectContaining({ transaction })
    );
  });
  test('日志状态中的实例可以独立配置，不要求当前仍在配置列表', async () => {
    models.MonitorInstance.findOne.mockResolvedValue(null);
    models.MonitorLogState.findOne.mockResolvedValue({ id: randomUUID() });
    expect(await tags.save(1, body({ localId }))).toMatchObject({ localId, tag: '美国主力' });
  });
  test('不存在的设备或跨设备实例拒绝', async () => {
    models.AosDevice.findByPk.mockResolvedValue(null);
    await expect(tags.save(1, body())).rejects.toMatchObject({ statusCode: 404 });
    models.AosDevice.findByPk.mockResolvedValue({ id: deviceId });
    models.MonitorInstance.findOne.mockResolvedValue(null);
    await expect(tags.save(1, body({ localId }))).rejects.toMatchObject({ statusCode: 404 });
  });
  test('版本冲突不更新；清空保留记录并递增版本', async () => {
    const row = {
      deviceId,
      localId,
      tag: '原标签',
      version: 3,
      update: jest.fn(function (values) {
        Object.assign(this, values);
        return Promise.resolve(this);
      }),
    };
    models.MonitorResourceTag.findOne.mockResolvedValue(row);
    await expect(tags.save(1, body({ localId, expectedVersion: 2 }))).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(row.update).not.toHaveBeenCalled();
    expect(await tags.save(1, body({ localId, tag: '   ', expectedVersion: 3 }))).toEqual({
      deviceId,
      localId,
      tag: '',
      tagVersion: 4,
    });
    expect(row.update).toHaveBeenCalledWith({ tag: '', version: 4 }, { transaction });
  });
});
