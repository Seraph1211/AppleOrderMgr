/* eslint-disable camelcase -- 测试夹具显式创建数据库原字段 */
const { randomUUID } = require('crypto');
const { Sequelize, DataTypes } = require('sequelize');
const migration = require('../migrations/20261028000003-create-aos-task-config');
const { createService } = require('../src/services/aosTaskConfigService');
const ratios = require('../src/services/aosTaskRatioService');
const policy = require('../src/services/aosTaskConfigPolicy');
const suite = process.env.AOS_TASK_CONFIG_DB === '1' ? describe : describe.skip;
const sample = (
  stores = '北京三里屯|北京西单大悦城|广州天环广场',
  product = 'iPhone Duo 星光白色 512G'
) => {
  const fields = Array(36).fill('');
  [fields[0], fields[1], fields[2], fields[3], fields[4]] = [
    'test@example.invalid',
    'secret-not-stored',
    stores,
    product,
    '2',
  ];
  return fields.join(',');
};

suite('任务配置真实PostgreSQL事务、版本、保密及并发验收', () => {
  let db;
  let models;
  let service;
  let instance;
  const actor = 1;
  beforeAll(async () => {
    if (
      process.env.DB_HOST !== 'postgres' ||
      process.env.AOS_TASK_CONFIG_TEST_DATABASE !== 'test_aos_task_config'
    )
      throw new Error('隔离数据库门禁未通过');
    db = new Sequelize('test_aos_task_config', process.env.DB_USER, process.env.DB_PASSWORD, {
      host: process.env.DB_HOST,
      dialect: 'postgres',
      logging: false,
    });
    const qi = db.getQueryInterface();
    await qi.createTable('monitor_instances', {
      id: { type: DataTypes.UUID, primaryKey: true },
      device_id: DataTypes.UUID,
      local_id: DataTypes.UUID,
      label: DataTypes.STRING,
      active: DataTypes.BOOLEAN,
      observed_at: DataTypes.DATE,
      snapshot: DataTypes.JSONB,
      handling: DataTypes.JSONB,
      version: DataTypes.INTEGER,
      created_at: DataTypes.DATE,
      updated_at: DataTypes.DATE,
    });
    await qi.createTable('aos_devices', {
      id: { type: DataTypes.UUID, primaryKey: true },
      name: DataTypes.STRING,
      enabled: DataTypes.BOOLEAN,
    });
    await migration.up(qi, Sequelize);
    models = { sequelize: db };
    for (const name of [
      'MonitorInstance',
      'AosTaskConfig',
      'AosTaskConfigVersion',
      'AosTaskConfigPreview',
    ])
      models[name] = require(`../src/models/${name}`)(db);
    models.AosDevice = db.define(
      'TaskTestDevice',
      {
        id: { type: DataTypes.UUID, primaryKey: true },
        name: DataTypes.STRING,
        enabled: DataTypes.BOOLEAN,
      },
      { tableName: 'aos_devices', timestamps: false }
    );
    service = createService(models);
  });
  beforeEach(async () => {
    await models.AosTaskConfigPreview.destroy({ where: {} });
    await models.AosTaskConfigVersion.destroy({ where: {} });
    await models.AosTaskConfig.destroy({ where: {} });
    await models.MonitorInstance.destroy({ where: {} });
    await models.AosDevice.destroy({ where: {} });
    const device = await models.AosDevice.create({
      id: randomUUID(),
      name: 'US_TEST',
      enabled: true,
    });
    instance = await models.MonitorInstance.create({
      id: randomUUID(),
      deviceId: device.id,
      localId: randomUUID(),
      label: '测试号实例',
      active: true,
    });
  });
  afterAll(async () => {
    if (!db) return;
    try {
      await migration.down(db.getQueryInterface(), Sequelize);
      await db.getQueryInterface().dropTable('monitor_instances');
      await db.getQueryInterface().dropTable('aos_devices');
    } finally {
      await db.close();
    }
  });
  const preview = text => service.preview(actor, instance.id, { text });
  const activate = async (text, effectiveAt = new Date(Date.now() - 10000).toISOString()) => {
    const value = await preview(text);
    return service.activate(actor, instance.id, {
      previewId: value.previewId,
      expectedRevision: value.expectedRevision,
      effectiveAt,
    });
  };

  test('双重复行计2且仅持久化脱敏字段；完整替换而非累加', async () => {
    const initial = await activate(`${sample()}\n${sample()}`);
    expect(initial.instance).toMatchObject({
      taskCount: 2,
      cityCount: 2,
      revision: 1,
      currentVersionNumber: 1,
      status: 'active',
    });
    const stored = await models.AosTaskConfigVersion.findAll({ raw: true });
    const previews = await models.AosTaskConfigPreview.findAll({ raw: true });
    expect(JSON.stringify([stored, previews])).not.toMatch(/secret-not-stored|test@example/);
    const next = await activate(sample('广州天环广场'), new Date(Date.now() - 5000).toISOString());
    expect(next.instance).toMatchObject({ taskCount: 1, cityCount: 1, currentVersionNumber: 2 });
    expect((await service.versions(instance.id)).items).toHaveLength(2);
    const old = await models.AosTaskConfigVersion.findByPk(initial.currentVersion.id);
    expect(+old.effectiveTo).toBe(+new Date(next.currentVersion.effectiveAt));
  });

  test('相同文件上传幂等，账号不同但计数不变仍生成新版本', async () => {
    await activate(sample());
    const same = await activate(sample(), new Date(Date.now() - 5000).toISOString());
    expect(same.unchanged).toBe(true);
    expect(same.instance.currentVersionNumber).toBe(1);
    const changed = await activate(
      sample().replace('test@example.invalid', 'different@example.invalid'),
      new Date(Date.now() - 4000).toISOString()
    );
    expect(changed.unchanged).toBe(false);
    expect(changed.instance.currentVersionNumber).toBe(2);
  });

  test('多SKU预览生效及恢复保持行任务数，未知选项整批拒绝并保留当前版本', async () => {
    const text = sample(
      '上海浦东|上海静安|上海环球港|上海五角场|上海七宝|上海环贸 iapm|上海香港广场|上海南京东路',
      'iPhone Duo 星光白色 512G|iPhone Duo 星光白色 2T|iPhone Duo 夜空色 2T|iPhone Duo 星光白色 1T|iPhone Duo 夜空色 1T'
    );
    const p = await preview(text);
    expect(p).toMatchObject({ valid: true, taskCount: 1, cityCount: 1, specCount: 5 });
    expect(p.aggregates.map(row => row.taskCount)).toEqual([1, 1, 1, 1, 1]);
    const first = await service.activate(actor, instance.id, {
      previewId: p.previewId,
      expectedRevision: p.expectedRevision,
      effectiveAt: new Date(Date.now() - 10000).toISOString(),
    });
    expect(first.instance).toMatchObject({ taskCount: 1, cityCount: 1, specCount: 5 });
    expect(first.currentVersion.rows[0].products).toHaveLength(5);
    expect(first.currentVersion.rows[0]).not.toHaveProperty('model');
    const bad = await preview(`${sample()}\n${text.replace('夜空色 2T', '未知色 2T')}`);
    expect(bad).toMatchObject({ valid: false, previewId: null });
    expect((await service.detail(instance.id)).currentVersion.id).toBe(first.currentVersion.id);
    expect(await models.AosTaskConfigVersion.count()).toBe(1);
    const next = await activate(sample('上海浦东'), new Date(Date.now() - 5000).toISOString());
    const restored = await service.restore(actor, instance.id, {
      versionId: first.currentVersion.id,
      expectedRevision: next.instance.revision,
    });
    expect(restored.currentVersion).toMatchObject({
      number: 3,
      taskCount: 1,
      cityCount: 1,
      specCount: 5,
      rows: first.currentVersion.rows,
      aggregates: first.currentVersion.aggregates,
      restoredFromId: first.currentVersion.id,
    });
    expect(JSON.stringify(await models.AosTaskConfigVersion.findAll({ raw: true }))).not.toMatch(
      /secret-not-stored|test@example/
    );
  });

  test('升级前已存单SKU预览可激活，旧版本可恢复且统计与多SKU版本互不混淆', async () => {
    const payload = policy.parse(sample('北京三里屯'));
    payload.rows = payload.rows.map(({ products: _products, ...row }) => row);
    const oldPreview = await models.AosTaskConfigPreview.create({
      id: randomUUID(),
      instanceId: instance.id,
      actorId: actor,
      expectedRevision: 0,
      expiresAt: new Date(Date.now() + 60000),
      payload,
    });
    const first = await service.activate(actor, instance.id, {
      previewId: oldPreview.id,
      expectedRevision: 0,
      effectiveAt: new Date(Date.now() - 10000).toISOString(),
    });
    expect(first.currentVersion).toMatchObject({
      taskCount: 1,
      cityCount: 1,
      specCount: 1,
      aggregates: payload.aggregates,
    });
    expect(first.currentVersion.rows[0]).not.toHaveProperty('products');
    const next = await activate(
      sample('北京三里屯', 'iPhone Duo 星光白色 512G|iPhone Duo 夜空色 1T'),
      new Date(Date.now() - 5000).toISOString()
    );
    expect(next.currentVersion.specCount).toBe(2);
    const restored = await service.restore(actor, instance.id, {
      versionId: first.currentVersion.id,
      expectedRevision: next.instance.revision,
    });
    expect(restored.currentVersion).toMatchObject({
      number: 3,
      taskCount: 1,
      cityCount: 1,
      specCount: 1,
      aggregates: payload.aggregates,
      restoredFromId: first.currentVersion.id,
    });
    expect((await service.version(instance.id, first.currentVersion.id)).version.rows).toEqual(
      payload.rows
    );
  });

  test('解析失败、无权限预览token、过期与CAS冲突均不改变生效版本', async () => {
    const first = await activate(sample());
    const bad = await preview(`${sample()}\nbad-sensitive-line`);
    expect(bad).toMatchObject({ valid: false, previewId: null });
    const p = await preview(sample());
    await expect(
      service.activate(2, instance.id, {
        previewId: p.previewId,
        expectedRevision: p.expectedRevision,
      })
    ).rejects.toMatchObject({ code: 'TASK_PREVIEW_EXPIRED' });
    await models.AosTaskConfigPreview.update(
      { expiresAt: new Date(Date.now() - 1) },
      { where: { id: p.previewId } }
    );
    await expect(
      service.activate(actor, instance.id, {
        previewId: p.previewId,
        expectedRevision: p.expectedRevision,
      })
    ).rejects.toMatchObject({ code: 'TASK_PREVIEW_EXPIRED' });
    const q = await preview(sample());
    await service.confirm(actor, instance.id, { expectedRevision: first.instance.revision });
    await expect(
      service.activate(actor, instance.id, {
        previewId: q.previewId,
        expectedRevision: q.expectedRevision,
      })
    ).rejects.toMatchObject({ code: 'TASK_CONFIG_CHANGED' });
    expect((await service.detail(instance.id)).currentVersion.id).toBe(first.currentVersion.id);
  });

  test('两个操作人并发激活仅一个成功，不出现重叠版本', async () => {
    const p = await preview(sample());
    const otherActor = 2;
    const q = await service.preview(otherActor, instance.id, { text: `${sample()}\n${sample()}` });
    const results = await Promise.allSettled([
      service.activate(actor, instance.id, { previewId: p.previewId, expectedRevision: 0 }),
      service.activate(otherActor, instance.id, { previewId: q.previewId, expectedRevision: 0 }),
    ]);
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(value => value.status === 'rejected').reason.code).toBe(
      'TASK_CONFIG_CHANGED'
    );
    expect(await models.AosTaskConfigVersion.count()).toBe(1);
  });

  test('失效保留历史生效区间，同文件重新启用及恢复当前同hash都新增版本', async () => {
    const first = await activate(sample());
    const invalid = await service.invalidate(actor, instance.id, {
      expectedRevision: first.instance.revision,
    });
    expect(invalid.instance.status).toBe('invalidated');
    await expect(
      service.confirm(actor, instance.id, { expectedRevision: invalid.instance.revision })
    ).rejects.toMatchObject({ statusCode: 400 });
    const p = await preview(sample());
    const second = await service.activate(actor, instance.id, {
      previewId: p.previewId,
      expectedRevision: p.expectedRevision,
    });
    expect(second.instance).toMatchObject({ status: 'active', currentVersionNumber: 2 });
    const restored = await service.restore(actor, instance.id, {
      versionId: second.currentVersion.id,
      expectedRevision: second.instance.revision,
    });
    expect(restored.instance.currentVersionNumber).toBe(3);
    expect(restored.currentVersion.restoredFromId).toBe(second.currentVersion.id);
  });

  test.each(['2026-02-30T01:00:00+08:00', '2036-01-01T00:00:00Z', '2026-10-28T12:00:00'])(
    '拒绝无效生效时间 %s',
    async effectiveAt => {
      const p = await preview(sample());
      await expect(
        service.activate(actor, instance.id, {
          previewId: p.previewId,
          expectedRevision: 0,
          effectiveAt,
        })
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(await models.AosTaskConfigVersion.count()).toBe(0);
    }
  );

  test('停用实例/删除实例不能激活预览', async () => {
    const p = await preview(sample());
    await instance.update({ active: false });
    await expect(
      service.activate(actor, instance.id, { previewId: p.previewId, expectedRevision: 0 })
    ).rejects.toMatchObject({ code: 'TASK_INSTANCE_INACTIVE' });
    await models.AosTaskConfigPreview.destroy({ where: {} });
    await instance.destroy();
    await expect(service.detail(instance.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  test('真实事件时点读取旧版、失效间隙无分母，跨版本不混算', async () => {
    const first = await activate(`${sample()}\n${sample()}`);
    const now = Date.now();
    const at = now - 8000;
    const item = {
      city: '广州',
      model: 'iPhone Duo',
      color: '星光白色',
      capacity: '512G',
      source: { key: 'source' },
    };
    const ref = time => ({
      anchor: {
        deviceId: instance.deviceId,
        localId: instance.localId,
        fileId: randomUUID(),
        accountNumber: '001',
        loggedAt: time,
      },
      item,
    });
    const event = ref(at);
    const evaluate = refs =>
      db.transaction(transaction => ratios.evaluate({ refs }, models, transaction));
    const firstResult = await evaluate([event]);
    expect(firstResult.scopes[policy.scopeKey(item)].sources.source).toMatchObject({
      numerator: 1,
      denominator: 2,
      versionId: first.currentVersion.id,
    });
    await activate(sample(), new Date(now - 5000).toISOString());
    const old = await evaluate([event]);
    expect(old.scopes[policy.scopeKey(item)].sources.source.denominator).toBe(2);
    const next = { ...event, anchor: { ...event.anchor, loggedAt: now - 4000 } };
    const mixed = await evaluate([event, next]);
    expect(mixed.scopes[policy.scopeKey(item)].sources.source.reason).toBe(
      'TASK_CONFIG_CHANGED_DURING_WINDOW'
    );
  });
  test('真实SQL读取错误回滚保存点，父信号事务仍可继续提交', async () => {
    await activate(sample());
    await db.transaction(async transaction => {
      await db.query('ALTER TABLE aos_task_config_versions RENAME TO task_config_versions_hidden', {
        transaction,
      });
      const item = {
        city: '广州',
        model: 'iPhone Duo',
        color: '星光白色',
        capacity: '512G',
        source: { key: 'source' },
      };
      const tracker = {
        refs: [
          {
            anchor: {
              deviceId: instance.deviceId,
              localId: instance.localId,
              fileId: randomUUID(),
              accountNumber: '001',
              loggedAt: Date.now(),
            },
            item,
          },
        ],
      };
      const result = await ratios.evaluate(tracker, models, transaction);
      expect(result.scopes[policy.scopeKey(item)].sources.source.reason).toBe(
        'TASK_CONFIG_READ_FAILED'
      );
      const [rows] = await db.query('SELECT 1 AS healthy', { transaction });
      expect(rows[0].healthy).toBe(1);
      await db.query('ALTER TABLE task_config_versions_hidden RENAME TO aos_task_config_versions', {
        transaction,
      });
    });
    expect(await models.AosTaskConfigVersion.count()).toBe(1);
  });
});
