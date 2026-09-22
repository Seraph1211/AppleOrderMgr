/**
 * 下线官网爬虫的收尾阶段：归档旧表和退休权限。
 * 必须在无爬虫依赖的新 API 已接管、旧爬虫 Worker 停止后执行。
 */
module.exports = {
  async up(queryInterface) {
    const retiredPermissions = [
      'orders.refresh',
      'payment_tasks.refresh_own',
      'system.refresh.read',
      'system.refresh.manage',
      'system.proxy.read',
      'system.proxy.manage',
    ];
    const retiredTables = [
      'order_refresh_jobs',
      'order_refresh_batches',
      'order_refresh_schedules',
      'order_refresh_system_states',
      'crawl_logs',
    ];
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(
          `CREATE TABLE archive.retired_permission_grants AS
             SELECT *, CURRENT_TIMESTAMP AS archived_at
               FROM user_permissions
              WHERE permission_code IN (:retiredPermissions)`,
          { replacements: { retiredPermissions }, transaction }
        );
        await queryInterface.sequelize.query(
          'DELETE FROM user_permissions WHERE permission_code IN (:retiredPermissions)',
          { replacements: { retiredPermissions }, transaction }
        );
        await queryInterface.sequelize.query(
          `UPDATE users
              SET permissions_version = permissions_version + 1,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id IN (SELECT DISTINCT user_id FROM archive.retired_permission_grants)`,
          { transaction }
        );
        await queryInterface.sequelize.query(
          `CREATE TABLE archive.retired_table_foreign_keys (
             table_name TEXT NOT NULL,
             constraint_name TEXT NOT NULL,
             definition TEXT NOT NULL,
             PRIMARY KEY (table_name, constraint_name)
           )`,
          { transaction }
        );
        await queryInterface.sequelize.query(
          `INSERT INTO archive.retired_table_foreign_keys
           SELECT c.relname, con.conname, pg_get_constraintdef(con.oid)
             FROM pg_constraint con
             JOIN pg_class c ON c.oid = con.conrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND con.contype = 'f'
              AND c.relname IN (:retiredTables)`,
          { replacements: { retiredTables }, transaction }
        );
        await queryInterface.sequelize.query(
          `DO $retire$
           DECLARE item RECORD;
           BEGIN
             FOR item IN SELECT * FROM archive.retired_table_foreign_keys LOOP
               EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',
                              item.table_name, item.constraint_name);
             END LOOP;
           END $retire$`,
          { transaction }
        );
        for (const table of retiredTables) {
          await queryInterface.sequelize.query(`ALTER TABLE public.${table} SET SCHEMA archive`, {
            transaction,
          });
        }
        for (const sequence of [
          'order_refresh_jobs_id_seq',
          'order_refresh_batches_id_seq',
          'crawl_logs_id_seq',
        ]) {
          await queryInterface.sequelize.query(
            `ALTER SEQUENCE IF EXISTS public.${sequence} SET SCHEMA archive`,
            { transaction }
          );
        }
        await queryInterface.sequelize.query(
          'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA archive FROM CURRENT_USER',
          { transaction }
        );
        await queryInterface.sequelize.query(
          'REVOKE USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA archive FROM CURRENT_USER',
          { transaction }
        );
      });
    } catch (error) {
      throw new Error('官网订单爬虫下线收尾迁移失败', { cause: error });
    }
  },

  async down(queryInterface) {
    const retiredTables = [
      'order_refresh_batches',
      'order_refresh_schedules',
      'order_refresh_jobs',
      'order_refresh_system_states',
      'crawl_logs',
    ];
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        for (const table of retiredTables) {
          await queryInterface.sequelize.query(`ALTER TABLE archive.${table} SET SCHEMA public`, {
            transaction,
          });
        }
        for (const sequence of [
          'order_refresh_jobs_id_seq',
          'order_refresh_batches_id_seq',
          'crawl_logs_id_seq',
        ]) {
          await queryInterface.sequelize.query(
            `ALTER SEQUENCE IF EXISTS archive.${sequence} SET SCHEMA public`,
            { transaction }
          );
        }
        await queryInterface.sequelize.query(
          `DO $restore$
           DECLARE item RECORD;
           BEGIN
             FOR item IN SELECT * FROM archive.retired_table_foreign_keys LOOP
               EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I %s',
                              item.table_name, item.constraint_name, item.definition);
             END LOOP;
           END $restore$`,
          { transaction }
        );
        await queryInterface.sequelize.query(
          `INSERT INTO user_permissions
             (user_id, permission_code, granted_by, created_at, updated_at)
           SELECT user_id, permission_code, granted_by, created_at, updated_at
             FROM archive.retired_permission_grants
           ON CONFLICT (user_id, permission_code) DO NOTHING`,
          { transaction }
        );
        await queryInterface.sequelize.query(
          `UPDATE users
              SET permissions_version = permissions_version + 1,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id IN (SELECT DISTINCT user_id FROM archive.retired_permission_grants)`,
          { transaction }
        );
        await queryInterface.sequelize.query('DROP TABLE archive.retired_permission_grants', {
          transaction,
        });
        await queryInterface.sequelize.query('DROP TABLE archive.retired_table_foreign_keys', {
          transaction,
        });
      });
    } catch (error) {
      throw new Error('官网订单爬虫下线收尾迁移回滚失败', { cause: error });
    }
  },
};
