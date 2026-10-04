/** 旧应用回滚后，显式幂等补齐可空的实物身份桥接；默认只读。 */
const crypto = require('crypto');
const logger = require('../src/utils/logger');
const db = require('../src/models');
const { runCommand } = require('../src/services/stockCommandService');
const { ensureUnit } = require('../src/services/stockUnitService');
/** 不改变设备UUID、来源订单、时间、实物库存或成本。 */
async function main() {
  try {
    const apply = process.argv.includes('--apply');
    const pending = await db.PickupDevice.count({ where: { stockUnitId: null } });
    if (!apply) {
      process.stdout.write(
        `待补桥接 ${pending} 条；默认只读。执行需 --apply --actor-id=<管理员ID>。\n`
      );
      return;
    }
    const value = process.argv.find(arg => arg.startsWith('--actor-id='));
    const actorId = Number(value?.split('=')[1]);
    const user = Number.isSafeInteger(actorId) ? await db.User.findByPk(actorId) : null;
    if (!user || user.role !== 'admin' || user.status !== 'active')
      throw new Error('必须指定有效内部管理员作为审计操作者');
    const result = await runCommand(
      user,
      { requestKey: crypto.randomUUID() },
      'legacy.repair_bridges',
      [],
      async ctx => {
        try {
          const rows = await db.PickupDevice.findAll({
            where: { stockUnitId: null },
            order: [['id', 'ASC']],
            transaction: ctx.transaction,
          });
          for (const row of rows) {
            const unit = await ensureUnit(ctx, row.serialNumber);
            await row.update({ stockUnitId: unit.id }, { transaction: ctx.transaction });
          }
          return { repairedCount: rows.length };
        } catch (error) {
          logger.warn('桥接补齐失败', { code: error.code || error.name });
          throw error;
        }
      },
      { allowDisabled: true }
    );
    process.stdout.write(`已补齐 ${result.repairedCount} 条桥接；未登记实物库存。\n`);
  } catch (error) {
    logger.error('桥接修复未完成', { code: error.code || error.name });
    process.exitCode = 1;
  } finally {
    await db.sequelize.close();
  }
}
main();
