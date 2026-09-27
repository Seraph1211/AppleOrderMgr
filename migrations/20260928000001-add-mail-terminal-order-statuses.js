const CONSTRAINT_NAME = 'orders_email_order_status_valid';
const PREVIOUS_STATUSES = ['unknown', 'confirmed', 'processing', 'ready_for_pickup', 'picked_up'];

async function replaceConstraint(queryInterface, Sequelize, statuses, transaction) {
  try {
    await queryInterface.removeConstraint('orders', CONSTRAINT_NAME, { transaction });
    await queryInterface.addConstraint('orders', {
      fields: ['email_order_status'],
      type: 'check',
      name: CONSTRAINT_NAME,
      where: { email_order_status: { [Sequelize.Op.in]: statuses } },
      transaction,
    });
  } catch (error) {
    throw new Error('更新订单邮件终态约束失败', { cause: error });
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await replaceConstraint(
          queryInterface,
          Sequelize,
          [...PREVIOUS_STATUSES, 'partially_cancelled', 'cancelled', 'expired'],
          transaction
        );
      });
    } catch (error) {
      throw new Error('订单邮件终态迁移失败', { cause: error });
    }
  },

  async down(queryInterface, Sequelize) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        const [rows] = await queryInterface.sequelize.query(
          "SELECT 1 FROM orders WHERE email_order_status IN ('partially_cancelled', 'cancelled', 'expired') LIMIT 1",
          { transaction }
        );
        if (rows.length) throw new Error('存在部分取消、已取消或已过期订单，须先恢复备份或授权处理终态数据');
        await replaceConstraint(queryInterface, Sequelize, PREVIOUS_STATUSES, transaction);
      });
    } catch (error) {
      throw new Error('订单邮件终态迁移回滚失败：不得丢失已有终态', { cause: error });
    }
  },
};
