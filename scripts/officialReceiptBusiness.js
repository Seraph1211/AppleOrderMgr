const fs = require('fs');
const path = require('path');
const {
  bindOfficialReceipt,
  reconcileOfficialReceipt,
  readReceiptInput,
  readReceiptPlan,
} = require('../src/services/officialReceiptBinding');

/** 由受控服务器 CLI 在现有应用容器内执行；不开放 HTTP 端点或输出敏感错误。 */
async function main() {
  let db;
  try {
    const [mode, appRoot] = process.argv.slice(2);
    if (!['plan', 'input', 'apply', 'reconcile'].includes(mode) || !path.isAbsolute(appRoot || ''))
      throw new Error('RECEIPT_COMMAND_INVALID');
    const raw = fs.readFileSync(0);
    if (raw.length > 1048576) throw new Error('RECEIPT_INPUT_TOO_LARGE');
    const input = JSON.parse(raw.toString('utf8'));
    db = require(path.join(appRoot, 'src/models'));
    const deps = {
      db,
      Op: require('sequelize').Op,
      stock: require(path.join(appRoot, 'src/services/stockCommandService')),
      units: require(path.join(appRoot, 'src/services/stockUnitService')),
      getEffectivePermissions: require(path.join(appRoot, 'src/services/permissionService'))
        .getEffectivePermissions,
      decrypt: require(path.join(appRoot, 'src/utils/fieldEncryption')).decrypt,
    };
    const result =
      mode === 'plan'
        ? await readReceiptPlan(input.orderIds, input.actorUserId, deps)
        : mode === 'input'
          ? await readReceiptInput(input.orderId, input.actorUserId, deps)
          : await (mode === 'apply' ? bindOfficialReceipt : reconcileOfficialReceipt)(input, deps);
    process.stdout.write(JSON.stringify({ success: true, data: result }) + '\n');
  } catch (error) {
    const value = error.code || error.message;
    process.stdout.write(
      JSON.stringify({
        success: false,
        code: /^[A-Z_0-9]+$/.test(value || '') ? value : 'RECEIPT_BUSINESS_FAILED',
      }) + '\n'
    );
    process.exitCode = 1;
  } finally {
    if (db) await db.sequelize.close().catch(() => {});
  }
}
main().catch(() => {
  process.exitCode = 1;
});
