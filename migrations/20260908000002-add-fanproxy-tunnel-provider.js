const REQUESTED_CONSTRAINT = 'chk_order_refresh_requested_proxy_provider';
const ACTIVE_CONSTRAINT = 'chk_order_refresh_active_proxy_provider';
const PREVIOUS_PROVIDERS = ['kdl_tunnel', 'kdl_private'];
const CURRENT_PROVIDERS = [...PREVIOUS_PROVIDERS, 'fanproxy_tunnel'];

/**
 * 替换订单刷新系统状态中的代理 Provider 检查约束。
 * @param {import('sequelize').QueryInterface} queryInterface - Sequelize QueryInterface
 * @param {string[]} providerNames - 允许的 Provider 枚举
 * @param {Object} transaction - Sequelize 事务
 * @returns {Promise<void>}
 */
async function replaceProviderConstraints(queryInterface, providerNames, transaction) {
  await queryInterface.removeConstraint('order_refresh_system_states', REQUESTED_CONSTRAINT, {
    transaction,
  });
  await queryInterface.removeConstraint('order_refresh_system_states', ACTIVE_CONSTRAINT, {
    transaction,
  });
  await queryInterface.addConstraint('order_refresh_system_states', {
    fields: ['requested_proxy_provider'],
    type: 'check',
    name: REQUESTED_CONSTRAINT,
    where: { requested_proxy_provider: providerNames },
    transaction,
  });
  await queryInterface.addConstraint('order_refresh_system_states', {
    fields: ['active_proxy_provider'],
    type: 'check',
    name: ACTIVE_CONSTRAINT,
    where: { active_proxy_provider: providerNames },
    transaction,
  });
}

/** 为运行时代理切换状态加入网帆隧道 Provider 枚举。 */
module.exports = {
  /** @param {import('sequelize').QueryInterface} queryInterface - Sequelize QueryInterface */
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async transaction => {
      await replaceProviderConstraints(queryInterface, CURRENT_PROVIDERS, transaction);
    });
  },

  /** @param {import('sequelize').QueryInterface} queryInterface - Sequelize QueryInterface */
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.sequelize.query(
        `UPDATE order_refresh_system_states
         SET requested_proxy_provider = CASE
               WHEN requested_proxy_provider = 'fanproxy_tunnel' THEN NULL
               ELSE requested_proxy_provider
             END,
             active_proxy_provider = CASE
               WHEN active_proxy_provider = 'fanproxy_tunnel' THEN NULL
               ELSE active_proxy_provider
             END,
             proxy_switch_status = CASE
               WHEN requested_proxy_provider = 'fanproxy_tunnel'
                 OR active_proxy_provider = 'fanproxy_tunnel'
               THEN 'idle'
               ELSE proxy_switch_status
             END
         WHERE requested_proxy_provider = 'fanproxy_tunnel'
            OR active_proxy_provider = 'fanproxy_tunnel'`,
        { transaction }
      );
      await replaceProviderConstraints(queryInterface, PREVIOUS_PROVIDERS, transaction);
    });
  },
};
