/** 退货申请历史维护CLI：先预览，凭冻结计划与订单版本有限应用。 */
const fs = require('fs');
const { OrderMailMessage, sequelize } = require('../src/models');
const { RULE_VERSION } = require('../src/services/orderMailLifecycleParser');
const { replayReturnMailMessages } = require('../src/services/orderMailLifecycleService');
const { Op } = require('sequelize');

async function main() {
  try {
    const [mode = 'preview', file] = process.argv.slice(2);
    if (!file || !['preview', 'apply'].includes(mode))
      throw new Error('用法：node scripts/replayReturnMail.js preview|apply 计划文件.json');
    if (mode === 'preview') {
      const ids = [];
      let cursor = null;
      for (;;) {
        const rows = await OrderMailMessage.findAll({
          attributes: ['id', 'metadata'],
          where: cursor ? { id: { [Op.gt]: cursor } } : {},
          order: [['id', 'ASC']],
          limit: 500,
        });
        for (const row of rows)
          if (/我们已经收到您的退货申请/.test(row.metadata?.subject || '')) ids.push(row.id);
        if (ids.length > 500) throw new Error('退货候选超过500封，请拆分明确范围');
        if (rows.length < 500) break;
        cursor = rows[rows.length - 1].id;
      }
      const preview = ids.length
        ? await replayReturnMailMessages({ messageIds: ids })
        : { messageCount: 0, orderCount: 0, results: [] };
      const plan = {
        ruleVersion: RULE_VERSION,
        createdAt: new Date().toISOString(),
        messageIds: ids,
        expectedVersions: Object.fromEntries(
          preview.results.map(row => [row.orderId, row.version])
        ),
        preview,
      };
      fs.writeFileSync(file, JSON.stringify(plan, null, 2), { mode: 0o600, flag: 'wx' });
      process.stdout.write(JSON.stringify(preview) + '\n');
    } else {
      const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (plan.ruleVersion !== RULE_VERSION || !plan.preview || !plan.expectedVersions)
        throw new Error('计划格式或规则版本不匹配，请重新预览');
      const result = await replayReturnMailMessages({
        messageIds: plan.messageIds,
        expectedVersions: plan.expectedVersions,
        apply: true,
      });
      process.stdout.write(JSON.stringify(result) + '\n');
    }
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: error.name, message: error.message }) + '\n');
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}

main();
