/** 邮件可靠接收游标和独立扫描指标；不改变历史邮件状态。 */
module.exports = {
  async up(queryInterface, Sequelize) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.createTable(
          'email_mailbox_cursors',
          {
            mailbox_identity_hash: {
              type: Sequelize.STRING(64),
              primaryKey: true,
              allowNull: false,
            },
            uid_validity: { type: Sequelize.STRING(100), primaryKey: true, allowNull: false },
            last_uid: { type: Sequelize.BIGINT, allowNull: true },
            bootstrap_since: { type: Sequelize.DATE, allowNull: false },
            created_at: {
              type: Sequelize.DATE,
              allowNull: false,
              defaultValue: Sequelize.fn('NOW'),
            },
            updated_at: {
              type: Sequelize.DATE,
              allowNull: false,
              defaultValue: Sequelize.fn('NOW'),
            },
          },
          { transaction }
        );
        await queryInterface.sequelize.query(
          'ALTER TABLE email_mailbox_cursors ADD CONSTRAINT email_cursor_uid_range CHECK (last_uid BETWEEN 1 AND 4294967295)',
          { transaction }
        );
        for (const [name, type] of [
          ['last_scan_started_at', Sequelize.DATE],
          ['last_scan_succeeded_at', Sequelize.DATE],
          ['last_scan_duration_ms', Sequelize.INTEGER],
          ['last_scan_error_code', Sequelize.STRING(64)],
        ]) {
          await queryInterface.addColumn(
            'email_worker_states',
            name,
            { type, allowNull: true },
            { transaction }
          );
        }
      });
    } catch (error) {
      error.migrationStep = 'email_scan_progress';
      throw error;
    }
  },
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        for (const name of [
          'last_scan_error_code',
          'last_scan_duration_ms',
          'last_scan_succeeded_at',
          'last_scan_started_at',
        ]) {
          await queryInterface.removeColumn('email_worker_states', name, { transaction });
        }
        await queryInterface.dropTable('email_mailbox_cursors', { transaction });
      });
    } catch (error) {
      error.migrationStep = 'email_scan_progress';
      throw error;
    }
  },
};
