'use strict';

module.exports = {
  async up(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // 只保留新来源规则启用前已进入处理的任务资格，不扩大新接收历史邮件的范围。
      await queryInterface.sequelize.query(
        `UPDATE email_logs e
        SET ingestion_eligible_at = s.created_at
        FROM ingestion_settings s
        WHERE s.id = 1 AND e.received_at < s.created_at AND e.last_attempt_at IS NOT NULL
          AND e.status NOT IN ('succeeded','superseded','ignored') AND e.ingestion_eligible_at IS NULL`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `INSERT INTO order_sources
        (id, order_id, source, email_log_id, result, received_at, created_at, updated_at)
        SELECT md5('legacy-email-source:' || e.id::text)::uuid, e.order_id, 'email', e.id,
          CASE WHEN e.status = 'succeeded' THEN 'created' ELSE 'duplicate' END,
          COALESCE(e.received_at, e.created_at), s.created_at, s.created_at
        FROM email_logs e CROSS JOIN ingestion_settings s
        WHERE s.id = 1 AND e.order_id IS NOT NULL AND e.status IN ('succeeded','superseded')
          AND e.created_at < s.created_at
        ON CONFLICT (email_log_id) DO NOTHING`,
        { transaction }
      );
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.sequelize.query(
        `DELETE FROM order_sources
        WHERE email_log_id IS NOT NULL AND id = md5('legacy-email-source:' || email_log_id::text)::uuid`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `UPDATE email_logs e SET ingestion_eligible_at = NULL
        FROM ingestion_settings s WHERE s.id = 1 AND e.ingestion_eligible_at = s.created_at
          AND e.received_at < s.created_at`,
        { transaction }
      );
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
