const { randomUUID } = require('crypto');
const { Sequelize } = require('sequelize');
const migration = require('../migrations/20261019000002-monitor-dual-notifications');

const suite = process.env.MONITOR_NOTIFICATIONS_INDEPENDENT === '1' ? describe : describe.skip;

suite('独立验收：双通道迁移与旧业务保全（真实 PostgreSQL）', () => {
  let db;
  let qi;

  beforeAll(async () => {
    try {
      if (
        process.env.DB_HOST !== '127.0.0.1' ||
        process.env.DB_NAME !== 'monitor_notify_independent' ||
        process.env.DATABASE_URL
      )
        throw new Error('仅允许本轮隔离 PostgreSQL Compose');
      db = new Sequelize('monitor_notify_migration', process.env.DB_USER, process.env.DB_PASSWORD, {
        host: '127.0.0.1',
        dialect: 'postgres',
        logging: false,
      });
      qi = db.getQueryInterface();
      await db.authenticate();
    } catch (error) {
      throw new Error('独立迁移环境初始化失败', { cause: error });
    }
  });

  beforeEach(async () => {
    try {
      const tables = await qi.showAllTables();
      const resetTables = [
        'monitor_notification_events',
        'monitor_notification_links',
        'monitor_notification_deliveries',
        'notification_worker_states',
        'wecom_robot_budgets',
      ].filter(name => tables.includes(name));
      if (resetTables.length)
        await db.query(`TRUNCATE ${resetTables.map(name => `"${name}"`).join(',')} CASCADE`);
      if (tables.includes('monitor_notification_channels')) {
        await db.query(`UPDATE monitor_notification_channels SET enabled=false,webhook_cipher=NULL,
          version=1,target_version=1,policy_version=1`);
        await db.query('UPDATE monitor_notification_settings SET version=1 WHERE id=1');
        await migration.down(qi, Sequelize);
      }
      await db.query(
        "UPDATE monitor_notification_settings SET enabled=false,recipients='[]'::jsonb WHERE id=1"
      );
    } catch (error) {
      throw new Error('独立迁移合成数据重置失败', { cause: error });
    }
  });

  afterAll(async () => {
    try {
      await db?.close();
    } catch (error) {
      throw new Error('独立迁移连接关闭失败', { cause: error });
    }
  });

  test('MIG-01：空新增队列 up/down/up，原订单逐字摘要保持', async () => {
    try {
      await db.query(
        `INSERT INTO orders(order_number,products,status,created_at,updated_at)
         VALUES('W990000001','[{"name":"合成业务哨兵","quantity":2}]','pending',now(),now())
         ON CONFLICT(order_number) DO NOTHING`
      );
      const [before] = await db.query(
        "SELECT md5(row_to_json(o)::text) AS digest FROM orders o WHERE order_number='W990000001'"
      );
      await migration.up(qi, Sequelize);
      const [channels] = await db.query(
        'SELECT channel,enabled FROM monitor_notification_channels ORDER BY channel'
      );
      expect(channels).toEqual([
        { channel: 'email', enabled: false },
        { channel: 'wecom', enabled: false },
      ]);
      await migration.down(qi, Sequelize);
      expect(await qi.showAllTables()).not.toContain('monitor_notification_channels');
      await migration.up(qi, Sequelize);
      const [after] = await db.query(
        "SELECT md5(row_to_json(o)::text) AS digest FROM orders o WHERE order_number='W990000001'"
      );
      expect(after).toEqual(before);
      await migration.down(qi, Sequelize);
    } catch (error) {
      throw new Error('MIG-01 迁移可逆与旧订单保全失败', { cause: error });
    }
  });

  test('MIG-02：历史 sent/sending/pending 原ID、次数和时间保持，接受映射不重发', async () => {
    try {
      const fixtures = [
        ['sent', 3],
        ['sending', 2],
        ['pending', 0],
      ].map(([status, attempts]) => ({ id: randomUUID(), status, attempts }));
      await db.query(
        `UPDATE monitor_notification_settings SET enabled=true,
           recipients='["legacy@example.test"]'::jsonb WHERE id=1`
      );
      for (const row of fixtures)
        await db.query(
          `INSERT INTO monitor_notification_deliveries
            (id,category,severity,status,not_before,recipient_snapshot,attempts,sent_at,created_at,updated_at)
           VALUES(:id,'test','critical',:status,'2026-10-18T00:00:00Z',
             '["legacy@example.test"]',:attempts,
             CASE WHEN :status = 'sent' THEN '2026-10-18T00:01:00Z'::timestamptz ELSE NULL END,
             '2026-10-18T00:00:00Z','2026-10-18T00:01:00Z')`,
          { replacements: row }
        );
      await migration.up(qi, Sequelize);
      const [rows] = await db.query(
        'SELECT id,status,attempts,sent_at FROM monitor_notification_deliveries ORDER BY attempts DESC'
      );
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({ id: fixtures[0].id, status: 'accepted', attempts: 3 });
      expect(rows[0].sent_at.toISOString()).toBe('2026-10-18T00:01:00.000Z');
      expect(rows[1]).toMatchObject({ id: fixtures[1].id, status: 'unknown', attempts: 2 });
      expect(rows[2]).toMatchObject({ id: fixtures[2].id, status: 'pending', attempts: 0 });
    } catch (error) {
      throw new Error(`MIG-02 历史投递保全失败：${error.message}`, { cause: error });
    }
  });

  test('MIG-03：历史在途转 unknown 后 down 拒绝抹去出站不确定性', async () => {
    try {
      await db.query(`INSERT INTO monitor_notification_deliveries
        (id,category,severity,status,not_before,created_at,updated_at)
        VALUES('00000000-0000-4000-8000-000000000002','test','critical','sending',now(),now(),now())`);
      await migration.up(qi, Sequelize);
      const [before] = await db.query(
        'SELECT md5(row_to_json(d)::text) AS digest FROM monitor_notification_deliveries d ORDER BY id'
      );
      await expect(migration.down(qi, Sequelize)).rejects.toThrow();
      const [after] = await db.query(
        'SELECT md5(row_to_json(d)::text) AS digest FROM monitor_notification_deliveries d ORDER BY id'
      );
      expect(after).toEqual(before);
    } catch (error) {
      throw new Error(`MIG-03 历史未知事实回退保护失败：${error.message}`, { cause: error });
    }
  });

  test('MIG-04：新增通道投递存在时 down 原子拒绝，事实与结构完整', async () => {
    try {
      await migration.up(qi, Sequelize);
      const id = randomUUID();
      await db.query(
        `INSERT INTO monitor_notification_deliveries
          (id,category,severity,status,not_before,channel,created_at,updated_at)
         VALUES(:id,'test','info','unknown',now(),'wecom',now(),now())`,
        { replacements: { id } }
      );
      const [before] = await db.query(
        'SELECT md5(row_to_json(d)::text) AS digest FROM monitor_notification_deliveries d ORDER BY id'
      );
      await expect(migration.down(qi, Sequelize)).rejects.toThrow();
      const [after] = await db.query(
        'SELECT md5(row_to_json(d)::text) AS digest FROM monitor_notification_deliveries d ORDER BY id'
      );
      expect(after).toEqual(before);
      expect(await qi.showAllTables()).toContain('monitor_notification_channels');
    } catch (error) {
      throw new Error(`MIG-04 有数据回退保护失败：${error.message}`, { cause: error });
    }
  });

  test('MIG-05：仅邮件渠道配置版本改变后 down 原子拒绝', async () => {
    try {
      await migration.up(qi, Sequelize);
      await db.query(
        "UPDATE monitor_notification_channels SET version=version+1,target_name='邮件配置已改变' WHERE channel='email'"
      );
      const [before] = await db.query(
        'SELECT md5(row_to_json(c)::text) AS digest FROM monitor_notification_channels c ORDER BY channel'
      );
      await expect(migration.down(qi, Sequelize)).rejects.toThrow();
      const [after] = await db.query(
        'SELECT md5(row_to_json(c)::text) AS digest FROM monitor_notification_channels c ORDER BY channel'
      );
      expect(after).toEqual(before);
    } catch (error) {
      throw new Error(`MIG-05 邮件配置回退保护失败：${error.message}`, { cause: error });
    }
  });

  test('MIG-06：升级后旧 API producer 只写 source_key 仍可登记邮件事实', async () => {
    try {
      await migration.up(qi, Sequelize);
      const id = randomUUID();
      await db.query(
        `INSERT INTO monitor_notification_deliveries
          (id,category,severity,status,not_before,recipient_snapshot,created_at,updated_at)
         VALUES(:id,'alert','critical','pending',now(),'["legacy@example.test"]',now(),now())`,
        { replacements: { id } }
      );
      await db.query(
        `INSERT INTO monitor_notification_events(id,delivery_id,source_key,payload,created_at,updated_at)
         VALUES(:eventId,:id,:sourceKey,'{}',now(),now())`,
        { replacements: { id, eventId: randomUUID(), sourceKey: `alert:${randomUUID()}` } }
      );
      const [rows] = await db.query(
        'SELECT event_key,source_key,channel,target_version FROM monitor_notification_events WHERE delivery_id = :id',
        { replacements: { id } }
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].event_key).toBe(rows[0].source_key);
      expect(rows[0].channel).toBe('email');
      expect(rows[0].target_version).toBe(1);
    } catch (error) {
      throw new Error(`MIG-06 旧 producer 兼容失败：${error.message}`, { cause: error });
    }
  });

  test('MIG-07：旧API不能把已出站sending覆盖为skipped/failed', async () => {
    try {
      await migration.up(qi, Sequelize);
      const id = randomUUID();
      await db.query(
        `INSERT INTO monitor_notification_deliveries
        (id,category,severity,status,not_before,created_at,updated_at)
        VALUES(:id,'test','critical','pending',now(),now(),now())`,
        { replacements: { id } }
      );
      await db.transaction(async transaction => {
        await db.query("SELECT set_config('app.monitor_sender_generation','2',true)", {
          transaction,
        });
        await db.query(
          `UPDATE monitor_notification_deliveries SET status='sending',
          dispatch_started_at=now(),lease_token=:token,lease_until=now()+interval '2 minutes',
          attempts=1 WHERE id = :id`,
          { replacements: { id, token: randomUUID() }, transaction }
        );
      });
      for (const status of ['skipped', 'failed']) {
        await expect(
          db.query('UPDATE monitor_notification_deliveries SET status = :status WHERE id = :id', {
            replacements: { id, status },
          })
        ).rejects.toThrow(/MONITOR_SENDER_GENERATION_REQUIRED/);
      }
      const [rows] = await db.query(
        'SELECT status,dispatch_started_at FROM monitor_notification_deliveries WHERE id = :id',
        { replacements: { id } }
      );
      expect(rows[0].status).toBe('sending');
      expect(rows[0].dispatch_started_at).not.toBeNull();
    } catch (error) {
      throw new Error(`MIG-07 旧API在途保护失败：${error.message}`, { cause: error });
    }
  });
});
