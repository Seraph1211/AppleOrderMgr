/** 一次性基础测试资料清理：默认只读，执行必须匹配预览指纹；不删除订单或付款任务。 */
const crypto = require('node:crypto');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../src/models');

async function readState(transaction) {
  const [state] = await sequelize.query(
    `
    SELECT
      (SELECT COALESCE(jsonb_agg(id ORDER BY id), '[]') FROM apple_ids) AS "appleIds",
      (SELECT COALESCE(jsonb_agg(id ORDER BY id), '[]') FROM recipients) AS "recipientIds",
      (SELECT md5(COALESCE(jsonb_agg(to_jsonb(a) ORDER BY id)::text, '[]')) FROM apple_ids a) AS "appleDigest",
      (SELECT md5(COALESCE(jsonb_agg(to_jsonb(r) ORDER BY id)::text, '[]')) FROM recipients r) AS "recipientDigest",
      (SELECT count(*)::int FROM orders) AS "orderCount",
      (SELECT count(*)::int FROM payment_tasks) AS "taskCount",
      (SELECT count(*)::int FROM orders WHERE apple_id_ref IS NOT NULL) AS "appleLinks",
      (SELECT count(*)::int FROM orders WHERE recipient_ref IS NOT NULL) AS "recipientLinks",
      (SELECT md5(COALESCE(jsonb_agg(to_jsonb(o) - 'apple_id_ref' - 'recipient_ref' ORDER BY id)::text, '[]')) FROM orders o) AS "orderDigest",
      (SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id)::text, '[]')) FROM payment_tasks t) AS "taskDigest"
  `,
    { type: QueryTypes.SELECT, transaction }
  );
  return state;
}

function fingerprint(state) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        sequelize.getDatabaseName(),
        state.appleIds,
        state.recipientIds,
        state.appleDigest,
        state.recipientDigest,
      ])
    )
    .digest('hex');
}

/**
 * 预览或按精确资料指纹清理；调用者须先完成备份与隔离演练。
 * @param {Object} options - execute 与 expectedFingerprint
 * @returns {Promise<Object>} 不含个人信息的计数与一致性证据
 */
function clearTestProfiles({ execute = false, expectedFingerprint } = {}) {
  return sequelize.transaction(async transaction => {
    await sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });
    if (execute) {
      if (!/^[a-f0-9]{64}$/.test(expectedFingerprint || '')) throw new Error('执行需要预览指纹');
      await sequelize.query(
        'LOCK TABLE apple_ids, recipients, orders, payment_tasks IN ACCESS EXCLUSIVE MODE',
        { transaction }
      );
    }
    const before = await readState(transaction);
    const expected = fingerprint(before);
    const summary = {
      fingerprint: expected,
      appleIds: before.appleIds.length,
      recipients: before.recipientIds.length,
      orders: before.orderCount,
      paymentTasks: before.taskCount,
      appleLinks: before.appleLinks,
      recipientLinks: before.recipientLinks,
    };
    if (!execute) return { executed: false, ...summary };
    if (expected !== expectedFingerprint) throw new Error('资料已变化，拒绝清理，请重新预览');
    const references = await sequelize.query(
      `
      SELECT conrelid::regclass::text AS "tableName", pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE contype = 'f'
      AND confrelid IN ('apple_ids'::regclass, 'recipients'::regclass)
    `,
      { type: QueryTypes.SELECT, transaction }
    );
    if (
      references.some(
        ref =>
          !['orders', 'recipients'].includes(ref.tableName) ||
          !ref.definition.includes('ON DELETE SET NULL')
      )
    ) {
      throw new Error('发现未知或非置空外键，拒绝清理');
    }
    if (before.recipientIds.length) {
      await sequelize.query(
        'UPDATE orders SET recipient_ref = NULL WHERE recipient_ref IN (:ids)',
        {
          replacements: { ids: before.recipientIds },
          transaction,
        }
      );
      await sequelize.query('DELETE FROM recipients WHERE id IN (:ids)', {
        replacements: { ids: before.recipientIds },
        transaction,
      });
    }
    if (before.appleIds.length) {
      await sequelize.query('UPDATE orders SET apple_id_ref = NULL WHERE apple_id_ref IN (:ids)', {
        replacements: { ids: before.appleIds },
        transaction,
      });
      await sequelize.query('DELETE FROM apple_ids WHERE id IN (:ids)', {
        replacements: { ids: before.appleIds },
        transaction,
      });
    }
    const after = await readState(transaction);
    if (
      after.appleIds.length ||
      after.recipientIds.length ||
      after.appleLinks ||
      after.recipientLinks ||
      before.orderDigest !== after.orderDigest ||
      before.taskDigest !== after.taskDigest
    ) {
      throw new Error('清理后数据保留校验失败，事务回滚');
    }
    return {
      executed: true,
      ...summary,
      remainingAppleIds: 0,
      remainingRecipients: 0,
      ordersUnchangedExceptLinks: true,
      paymentTasksUnchanged: true,
    };
  });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  clearTestProfiles({
    execute: args.includes('--execute'),
    expectedFingerprint: args.find(arg => arg.startsWith('--expected-fingerprint='))?.split('=')[1],
  })
    .then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(() => {
      process.stderr.write('基础资料清理失败，未提交事务；请核对预览指纹及外键条件。\n');
      process.exitCode = 1;
    })
    .finally(() => sequelize.close());
}

module.exports = { clearTestProfiles };
