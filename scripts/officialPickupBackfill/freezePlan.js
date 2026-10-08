const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const { freezePickupBackfill } = require('../../src/services/officialPickupBackfill');

/** 只读冻结缺失字段订单，备份目标原值与设备绑定；私密计划一经创建不覆盖。 */
async function main() {
  let client;
  try {
    const root = process.argv[2];
    if (!root || !path.isAbsolute(root) || process.argv.length !== 3)
      throw Error('BACKFILL_ROOT_INVALID');
    const privateDirectory = path.join(root, 'private');
    const planPath = path.join(privateDirectory, 'plan.json');
    if (fs.existsSync(planPath)) throw Error('BACKFILL_PLAN_ALREADY_EXISTS');
    client = new Client({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });
    await client.connect();
    const plan = await freezePickupBackfill(client, { missingFields: true });
    const serialized = `${JSON.stringify(plan, null, 2)}\n`;
    const sha256 = crypto.createHash('sha256').update(serialized).digest('hex');
    fs.mkdirSync(privateDirectory, { recursive: true, mode: 0o700 });
    const fd = fs.openSync(planPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, serialized);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    process.stdout.write(
      `${JSON.stringify({
        scope: plan.scope,
        startedAt: plan.startedAt,
        total: plan.entries.length,
        missingDate: plan.entries.filter(entry => entry.dateMissing).length,
        missingSerials: plan.entries.filter(entry => entry.serialsMissing).length,
        missingBoth: plan.entries.filter(entry => entry.dateMissing && entry.serialsMissing).length,
        planPath,
        sha256,
        businessWrites: 0,
      })}\n`
    );
  } catch (error) {
    const code = error.code || error.message;
    process.stderr.write(
      `${JSON.stringify({
        outcome: /^[A-Z_0-9]+$/.test(code) ? code : 'BACKFILL_FREEZE_FAILED',
      })}\n`
    );
    process.exitCode = 1;
  } finally {
    if (client) await client.end().catch(() => {});
  }
}

main();
