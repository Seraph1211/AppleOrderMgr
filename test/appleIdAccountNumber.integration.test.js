/* eslint-disable camelcase */
const { Sequelize } = require('sequelize');
const migration = require('../migrations/20261016000001-add-apple-id-account-number');
const describeIntegration =
  process.env.RUN_APPLE_ID_NUMBER_TEST === 'true' ? describe : describe.skip;

describeIntegration('Apple ID 编号真实 PostgreSQL 迁移与 Sequelize 创建路径', () => {
  let sequelize, AppleId;
  const connect = () =>
    new Sequelize(process.env.DB_NAME, 'postgres', process.env.DB_PASSWORD, {
      host: process.env.DB_HOST,
      dialect: 'postgres',
      logging: false,
    });
  const account = (name, extra = {}) => ({
    appleId: `${name}@example.invalid`,
    password: 'synthetic',
    ...extra,
  });
  beforeAll(async () => {
    if (
      process.env.DB_NAME !== 'apple_order_mgr_appleid_test_20261016' ||
      process.env.DATABASE_URL
    ) {
      throw new Error('仅允许独立 Apple ID 编号测试库');
    }
    process.env.FIELD_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
    sequelize = connect();
    await sequelize.query(`CREATE TABLE apple_ids (
      id SERIAL PRIMARY KEY, apple_id VARCHAR(255) UNIQUE NOT NULL, password TEXT NOT NULL,
      is_proxy_pool BOOLEAN NOT NULL DEFAULT FALSE, notes TEXT, nickname VARCHAR(255),
      security_qa JSONB, country VARCHAR(50) DEFAULT '中国', status VARCHAR(20) NOT NULL DEFAULT '未使用',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_order_at TIMESTAMPTZ
    );
    INSERT INTO apple_ids (id, apple_id, password) VALUES
      (12, 'legacy-b@example.invalid', 'synthetic'), (3, 'legacy-a@example.invalid', 'synthetic');
    SELECT setval('apple_ids_id_seq', 12);`);
    await migration.up(sequelize.getQueryInterface());
    AppleId = require('../src/models/AppleId')(sequelize);
  });
  afterAll(async () => {
    if (sequelize) {
      await sequelize.query('DROP TABLE IF EXISTS apple_ids CASCADE');
      await sequelize.close();
    }
  });

  test('按内部 ID 升序从 1 回填且保留内部 ID', async () => {
    const [rows] = await sequelize.query('SELECT id, account_number FROM apple_ids ORDER BY id');
    expect(rows).toEqual([
      { id: 3, account_number: 1 },
      { id: 12, account_number: 2 },
    ]);
  });

  test('create、bulkCreate、findOrCreate、upsert 回填且不依赖应用 MAX+1', async () => {
    const created = await AppleId.create(account('created'));
    expect(created.accountNumber).toBe(3);
    const bulk = await AppleId.bulkCreate([account('bulk-a'), account('bulk-b')]);
    expect(bulk.map(row => row.accountNumber)).toEqual([4, 5]);
    const [found] = await AppleId.findOrCreate({
      where: { appleId: 'found@example.invalid' },
      defaults: account('found'),
    });
    expect(found.accountNumber).toBe(6);
    const [inserted] = await AppleId.upsert(account('upserted'));
    expect(inserted.accountNumber).toBe(7);
    const [updated] = await AppleId.upsert(account('upserted', { notes: 'upsert更新' }));
    expect(updated.accountNumber).toBe(7);
    expect(updated.notes).toBe('upsert更新');
  });

  test('原始 SQL INSERT 与指定 fields 的创建均使用数据库默认编号', async () => {
    const [[raw]] = await sequelize.query(`INSERT INTO apple_ids (apple_id,password)
      VALUES ('raw-default@example.invalid','synthetic') RETURNING account_number`);
    const selectedFields = await AppleId.create(account('selected-fields'), {
      fields: ['appleId', 'password'],
    });
    expect(Number.isInteger(raw.account_number)).toBe(true);
    expect(selectedFields.accountNumber).toBeGreaterThan(raw.account_number);
  });

  test('删除不复用、事务回滚允许跳号且不复用', async () => {
    const deleted = await AppleId.create(account('deleted'));
    await deleted.destroy();
    const next = await AppleId.create(account('after-delete'));
    expect(next.accountNumber).toBeGreaterThan(deleted.accountNumber);
    let rolledBackNumber;
    await expect(
      sequelize.transaction(async transaction => {
        const rolledBack = await AppleId.create(account('rolled-back'), { transaction });
        rolledBackNumber = rolledBack.accountNumber;
        throw new Error('synthetic-rollback');
      })
    ).rejects.toThrow('synthetic-rollback');
    const afterRollback = await AppleId.create(account('after-rollback'));
    expect(afterRollback.accountNumber).toBeGreaterThan(rolledBackNumber);
    expect(await AppleId.count({ where: { appleId: 'rolled-back@example.invalid' } })).toBe(0);
  });

  test('重新建立应用连接仍接续数据库序列', async () => {
    const beforeRestart = await AppleId.create(account('before-restart'));
    const otherConnection = connect();
    try {
      const otherModel = require('../src/models/AppleId')(otherConnection);
      const afterRestart = await otherModel.create(account('after-restart'));
      expect(afterRestart.accountNumber).toBeGreaterThan(beforeRestart.accountNumber);
    } finally {
      await otherConnection.close();
    }
  });

  test('数据库拒绝编号 NULL、非正数、重复及修改', async () => {
    for (const value of ['NULL', '0', '-1', '1']) {
      await expect(
        sequelize.query(`INSERT INTO apple_ids (apple_id,password,account_number)
        VALUES ('invalid-${value}@example.invalid','synthetic',${value})`)
      ).rejects.toThrow();
    }
    await expect(
      sequelize.query('UPDATE apple_ids SET account_number=10000 WHERE id=3')
    ).rejects.toThrow();
    const legacy = await AppleId.findByPk(3);
    expect(legacy.accountNumber).toBe(1);
    await legacy.update({ notes: '普通更新不受影响' });
    expect(legacy.accountNumber).toBe(1);
  });

  test('并发创建唯一递增，不复用编号', async () => {
    const rows = await Promise.all(
      Array.from({ length: 10 }, (_, i) => AppleId.create(account(`concurrent-${i}`)))
    );
    expect(new Set(rows.map(row => row.accountNumber)).size).toBe(10);
    expect(rows.every(row => Number.isInteger(row.accountNumber) && row.accountNumber > 0)).toBe(
      true
    );
  });

  test('down 移除编号及序列但保留账号与内部 ID，空表 up 从 1 开始', async () => {
    const [before] = await sequelize.query('SELECT id, apple_id FROM apple_ids ORDER BY id');
    await migration.down(sequelize.getQueryInterface());
    const [after] = await sequelize.query('SELECT id, apple_id FROM apple_ids ORDER BY id');
    expect(after).toEqual(before);
    const [[sequence]] = await sequelize.query(
      "SELECT to_regclass('apple_ids_account_number_seq') AS sequence"
    );
    expect(sequence.sequence).toBeNull();
    await sequelize.query('DELETE FROM apple_ids');
    await migration.up(sequelize.getQueryInterface());
    const created = await AppleId.create(account('empty-first'));
    expect(created.accountNumber).toBe(1);
    await migration.down(sequelize.getQueryInterface());
  });
});
